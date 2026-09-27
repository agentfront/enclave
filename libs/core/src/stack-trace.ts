/**
 * Stack Trace Sanitization
 *
 * One sanitizer for every error the enclave hands back to its caller, whichever stage raised it
 * (validation, transformation, compilation, execution, tool calls) and whichever adapter ran the
 * script. With `sanitizeStackTraces` on, a returned stack keeps its message lines (with paths,
 * locations and credential-like strings redacted) and every stack frame becomes `at [REDACTED]`,
 * so no host path, file name, line or column number, or host function name survives.
 *
 * @packageDocumentation
 */

/**
 * Sensitive patterns redacted from the non-frame lines of a stack (the error header, and the
 * source excerpt V8 prints for syntax errors).
 *
 * Categories covered:
 * - File system paths (Unix, Windows, UNC), file URLs and file locations (`name.js:10:5`)
 * - Cloud, container and CI paths
 * - Secret/credential patterns
 * - Internal hostnames and IPs
 * - Package manager cache paths
 */
export const SENSITIVE_STACK_PATTERNS: readonly RegExp[] = [
  // Unix file system paths
  /\/Users\/[^/]+\/[^\s):]*/gi, // macOS home directories
  /\/home\/[^/]+\/[^\s):]*/gi, // Linux home directories
  /\/var\/[^\s):]*/gi, // System var directories
  /\/opt\/[^\s):]*/gi, // Optional software
  /\/tmp\/[^\s):]*/gi, // Temporary files
  /\/etc\/[^\s):]*/gi, // System configuration
  /\/root\/[^\s):]*/gi, // Root home directory
  /\/mnt\/[^\s):]*/gi, // Mount points
  /\/srv\/[^\s):]*/gi, // Service data
  /\/data\/[^\s):]*/gi, // Data directories
  /\/app\/[^\s):]*/gi, // Application directories
  /\/proc\/[^\s):]*/gi, // Process information
  /\/sys\/[^\s):]*/gi, // System files

  // Windows paths
  /\\\\[^\s):]*/g, // UNC paths
  /[A-Z]:\\[^\s):]+/gi, // Windows drive paths

  // URL-based paths
  /file:\/\/[^\s):]+/gi, // File URLs
  /webpack:\/\/[^\s):]+/gi, // Webpack paths
  /%2F[^\s):]+/gi, // URL-encoded paths

  // Package managers and node
  /node_modules\/[^\s):]+/gi, // Node modules paths
  /\/nix\/store\/[^\s):]*/gi, // Nix store paths
  /\.npm\/[^\s):]*/gi, // NPM cache
  /\.yarn\/[^\s):]*/gi, // Yarn cache
  /\.pnpm\/[^\s):]*/gi, // PNPM cache

  // Container and orchestration
  /\/run\/secrets\/[^\s):]*/gi, // Docker/K8s secrets
  /\/var\/run\/[^\s):]*/gi, // Runtime directories
  /\/docker\/[^\s):]*/gi, // Docker paths
  /\/containers\/[^\s):]*/gi, // Container paths
  /\/kubelet\/[^\s):]*/gi, // Kubernetes kubelet

  // CI/CD systems
  /\/github\/workspace\/[^\s):]*/gi, // GitHub Actions
  /\/runner\/[^\s):]*/gi, // GitHub/GitLab runner
  /\/builds\/[^\s):]*/gi, // CI builds
  /\/workspace\/[^\s):]*/gi, // Generic workspace
  /\/pipeline\/[^\s):]*/gi, // CI pipelines
  /\/jenkins\/[^\s):]*/gi, // Jenkins
  /\/bamboo\/[^\s):]*/gi, // Bamboo
  /\/teamcity\/[^\s):]*/gi, // TeamCity
  /\/circleci\/[^\s):]*/gi, // CircleCI

  // Cloud providers
  /\/aws\/[^\s):]*/gi, // AWS paths
  /\/gcloud\/[^\s):]*/gi, // Google Cloud
  /\/azure\/[^\s):]*/gi, // Azure paths
  /s3:\/\/[^\s):]+/gi, // S3 URIs
  /gs:\/\/[^\s):]+/gi, // GCS URIs

  // Secrets and credentials (patterns that might appear in paths or errors)
  /[A-Z0-9]{20,}/g, // AWS-style access keys (20+ uppercase chars)
  /sk-[a-zA-Z0-9]{32,}/g, // OpenAI/Stripe-style secret keys
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g, // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained tokens
  /xox[baprs]-[a-zA-Z0-9-]+/g, // Slack tokens
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens
  /Basic\s+[a-zA-Z0-9+/=]+/gi, // Basic auth

  // Internal network info
  /(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+/g, // Private IPs
  /[a-z0-9-]+\.internal(?:\.[a-z]+)?/gi, // Internal hostnames
  /localhost:\d+/gi, // Localhost with port
  /127\.0\.0\.1:\d+/gi, // Loopback with port

  // User information
  /\/u\/[^/]+\//gi, // User subdirectories
  /~[a-z_][a-z0-9_-]*/gi, // Unix user home shorthand

  // Anything else that is still shaped like a location: an absolute path of two or more
  // segments, a URL, or a script location such as `agentscript.js:3` / `index.mjs:10:5`.
  /[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, // Other URLs (http://host/bundle.js:1:2)
  /(?:\/[\w.@%+-]+){2,}\/?/g, // Remaining absolute paths
  /[\w.@-]+\.(?:[cm]?[jt]sx?|json|node|wasm)(?::\d+){1,2}/gi, // file.ext:line[:column]
];

/** A stack frame line: `at fn (file:1:2)`, `at file:1:2`, `at async fn (...)`. */
const FRAME_LINE = /^\s*at\s/;

/**
 * Bounds on the text the patterns run over. A message can be arbitrarily long and is partly
 * script-controlled; truncating first keeps sanitization cheap whatever the input.
 */
const MAX_STACK_LENGTH = 16 * 1024;
const MAX_LINE_LENGTH = 1000;

/** The replacement for every stack frame. */
const REDACTED_FRAME = '    at [REDACTED]';

/**
 * Redact sensitive data from a single non-frame line.
 */
function redactLine(line: string): string {
  let out = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
  for (const pattern of SENSITIVE_STACK_PATTERNS) {
    // Reset lastIndex for global patterns to ensure consistent behavior
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * Sanitize a stack trace for the enclave's caller.
 *
 * With `sanitize` on, every frame line becomes `at [REDACTED]` and sensitive data in the other
 * lines is redacted (see {@link SENSITIVE_STACK_PATTERNS}); the number of frames is preserved so
 * the shape of the error stays recognizable. With `sanitize` off, the stack is returned unchanged.
 *
 * Only simple, non-nested patterns are applied, one bounded line at a time (the stack is cut at
 * 16 KiB and each line at 1000 characters), so hostile input cannot make sanitization expensive.
 *
 * @param stack Original stack trace
 * @param sanitize Whether to sanitize (defaults to true)
 * @returns The sanitized stack trace (or the original if `sanitize` is false)
 */
export function sanitizeStackTrace(stack: string | undefined, sanitize = true): string | undefined {
  if (typeof stack !== 'string' || !stack || !sanitize) return stack;

  const bounded = stack.length > MAX_STACK_LENGTH ? stack.slice(0, MAX_STACK_LENGTH) : stack;
  return bounded
    .split('\n')
    .map((line) => (FRAME_LINE.test(line) ? REDACTED_FRAME : redactLine(line)))
    .join('\n');
}
