/**
 * BrowserEnclave - Browser-based Safe AgentScript Execution Environment
 *
 * Provides a sandboxed environment using double iframe isolation for
 * executing AgentScript code in the browser with:
 * - AST validation (via @enclave-vm/ast)
 * - Code transformation
 * - Runtime safety wrappers
 * - Resource limits (timeout, iterations, tool calls)
 * - Double iframe defense-in-depth
 *
 * @packageDocumentation
 */

import {
  JSAstValidator,
  createAgentScriptPreset,
  createStrictPreset,
  createSecurePreset,
  createStandardPreset,
  createPermissivePreset,
  getAgentScriptGlobals,
  transformAgentScript,
  isWrappedInMain,
  normalizeToolNamespaces,
  type NormalizedToolNamespace,
  type ValidationIssue,
} from '@enclave-vm/ast';
import { IframeAdapter, type IframeExecutionContext } from './adapters/iframe-adapter';
import type {
  BrowserEnclaveOptions,
  ExecutionResult,
  ToolHandler,
  SecurityLevel,
  AstPreset,
  SecureProxyLevelConfig,
  DoubleIframeConfig,
  SerializedIframeConfig,
  SerializableSuspiciousPattern,
} from './types';
import { SECURITY_LEVEL_CONFIGS, DEFAULT_DOUBLE_IFRAME_CONFIG } from './types';
import { sanitizeStackTrace } from './utils/sanitize-stack';

/**
 * Default security level
 */
const DEFAULT_SECURITY_LEVEL: SecurityLevel = 'STANDARD';

/**
 * Blocked properties for secure proxy per security level
 */
function getBlockedProperties(config: SecureProxyLevelConfig): string[] {
  const blocked: string[] = [];

  if (config.blockPrototype) {
    blocked.push('__proto__', 'prototype');
  }
  if (config.blockConstructor) {
    blocked.push('constructor');
  }
  if (config.blockLegacyAccessors) {
    blocked.push('__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__');
  }

  return blocked;
}

/**
 * Default suspicious patterns (serialized for iframe injection)
 */
const DEFAULT_SERIALIZED_PATTERNS: SerializableSuspiciousPattern[] = [
  {
    id: 'EXFIL_LIST_SEND',
    description: 'List/query followed by send/export (potential exfiltration)',
    detectBody: `
      var recentQueries = history.filter(function(h) {
        return /list|query|get|fetch|read|search|find|select/i.test(h.operationName) && Date.now() - h.timestamp < 5000;
      });
      var isSendOperation = /send|export|post|write|upload|publish|emit|transmit|forward/i.test(operationName);
      return recentQueries.length > 0 && isSendOperation;
    `,
  },
  {
    id: 'RAPID_ENUMERATION',
    description: 'Rapid enumeration of resources',
    detectBody: `
      var now = Date.now();
      var recentSame = history.filter(function(h) {
        return h.operationName === operationName && now - h.timestamp < 5000;
      });
      var threshold = 30;
      try {
        if (typeof validationConfig !== 'undefined') {
          threshold = (validationConfig.rapidEnumerationOverrides && validationConfig.rapidEnumerationOverrides[operationName])
            || validationConfig.rapidEnumerationThreshold || 30;
        }
      } catch(e) { threshold = 30; }
      return recentSame.length > threshold;
    `,
  },
  {
    id: 'CREDENTIAL_EXFIL',
    description: 'Credential access followed by external operation',
    detectBody: `
      var recentCreds = history.filter(function(h) {
        return /secret|credential|password|token|key|auth|api[_-]?key/i.test(h.operationName) && Date.now() - h.timestamp < 10000;
      });
      var isExternal = /http|api|external|webhook|slack|email|sms|notification/i.test(operationName);
      return recentCreds.length > 0 && isExternal;
    `,
  },
  {
    id: 'BULK_OPERATION',
    description: 'Bulk/batch operation detected',
    detectBody: `
      var isBulk = /\\b(bulk|batch|mass|dump)\\b|export[_-]all\\b/i.test(operationName);
      if (typeof args === 'object' && args !== null) {
        try {
          var argStr = JSON.stringify(args).toLowerCase();
          if (/limit.*[0-9]{4,}|"\\*"|no[_-]?limit/i.test(argStr)) return true;
        } catch(e) {}
      }
      return isBulk;
    `,
  },
  {
    id: 'DELETE_AFTER_ACCESS',
    description: 'Delete operation after data access (potential cover-up)',
    detectBody: `
      var isDelete = /delete|remove|destroy|purge|clear|wipe|erase/i.test(operationName);
      if (!isDelete) return false;
      var recentAccess = history.filter(function(h) {
        return /list|query|get|fetch|read|search|find|select/i.test(h.operationName) && Date.now() - h.timestamp < 30000;
      });
      return recentAccess.length > 0;
    `,
  },
];

/**
 * Object kinds JSON copies faithfully: plain objects and class instances (own enumerable
 * properties), arrays, and Dates (as ISO strings). JSON turns the others (Map, Set, RegExp, DOM
 * nodes, ...) into `{}`, losing their data.
 */
const JSON_OBJECT_TAGS = new Set(['[object Object]', '[object Array]', '[object Date]']);

const OBJECT_TO_STRING = Object.prototype.toString;

interface UnsupportedGlobalValue {
  /** Dotted path inside the global; empty for the global itself. */
  path: string;
  /** What was found, e.g. "a function" or "a Map". */
  kind: string;
}

/**
 * Copy custom globals as JSON data for the inner iframe. Throws for a value that cannot cross the
 * iframe boundary instead of dropping it, which would leave the script with `undefined` or `{}`.
 */
function serializeGlobals(globals: Record<string, unknown>): Record<string, unknown> {
  const serializable: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(globals)) {
    serializable[name] = serializeGlobal(name, value);
  }
  return serializable;
}

function serializeGlobal(name: string, value: unknown): unknown {
  // Checked on the original value: JSON.stringify calls toJSON() first, which could hide a function.
  const unsupported = findUnsupportedValue(value, '', new Set());
  if (unsupported) {
    throw new Error(describeUnsupportedGlobal(name, unsupported));
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Custom global "${name}" cannot be passed into the sandbox: ${reason}. Globals must be JSON data.`);
  }
  if (json === undefined) {
    throw new Error(`Custom global "${name}" is undefined; give it a value or leave it out.`);
  }
  return JSON.parse(json);
}

/** Find the first value JSON.stringify would drop or mangle, walking what it would copy. */
function findUnsupportedValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): UnsupportedGlobalValue | undefined {
  const type = typeof value;
  if (type === 'function' || type === 'symbol') {
    return { path, kind: `a ${type}` };
  }
  if (type === 'bigint') {
    return { path, kind: 'a BigInt' };
  }
  if (value === null || type !== 'object') {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  if (ancestors.has(object)) {
    return { path, kind: 'a circular reference' };
  }
  const tag = OBJECT_TO_STRING.call(object);
  if (!JSON_OBJECT_TAGS.has(tag)) {
    return { path, kind: `a ${tag.slice('[object '.length, -1)}` };
  }

  ancestors.add(object);
  for (const key of Object.keys(object)) {
    const found = findUnsupportedValue(object[key], path ? `${path}.${key}` : key, ancestors);
    if (found) {
      return found;
    }
  }
  ancestors.delete(object);
  return undefined;
}

function describeUnsupportedGlobal(name: string, unsupported: UnsupportedGlobalValue): string {
  const subject =
    unsupported.path === ''
      ? `Custom global "${name}" is ${unsupported.kind}`
      : `Custom global "${name}" contains ${unsupported.kind} at "${unsupported.path}"`;
  if (unsupported.kind === 'a function') {
    return (
      `${subject}. Functions cannot cross the iframe boundary into the sandbox; expose host capabilities ` +
      'as tools (toolHandler with callTool(), or toolNamespaces).'
    );
  }
  return `${subject}, which cannot be passed into the sandbox. Globals must be JSON data.`;
}

/**
 * BrowserEnclave - Safe AgentScript Execution in the Browser
 *
 * @example
 * ```typescript
 * import { BrowserEnclave } from '@enclave-vm/browser';
 *
 * const enclave = new BrowserEnclave({
 *   securityLevel: 'STRICT',
 *   toolHandler: async (name, args) => {
 *     return fetch(`/api/tools/${name}`, {
 *       method: 'POST',
 *       body: JSON.stringify(args),
 *     }).then(r => r.json());
 *   },
 * });
 *
 * const result = await enclave.run(`
 *   const users = await callTool('users:list', {});
 *   return users.items.length;
 * `);
 *
 * enclave.dispose();
 * ```
 */
export class BrowserEnclave {
  private readonly securityLevel: SecurityLevel;
  private readonly validator: JSAstValidator;
  private readonly validateCode: boolean;
  private readonly transformCode: boolean;
  private readonly customGlobalNames: string[];
  private readonly toolNamespaces: NormalizedToolNamespace[];
  private readonly adapter: IframeAdapter;
  private readonly config: {
    timeout: number;
    maxIterations: number;
    maxToolCalls: number;
    maxConsoleOutputBytes: number;
    maxConsoleCalls: number;
    sanitizeStackTraces: boolean;
    maxSanitizeDepth: number;
    maxSanitizeProperties: number;
    memoryLimit: number;
    globals: Record<string, unknown>;
    toolHandler?: ToolHandler;
    secureProxyConfig: SecureProxyLevelConfig;
  };
  private readonly doubleIframeConfig: DoubleIframeConfig;
  private readonly customSerializablePatterns: SerializableSuspiciousPattern[];

  constructor(options: BrowserEnclaveOptions = {}) {
    this.securityLevel = options.securityLevel ?? DEFAULT_SECURITY_LEVEL;

    const levelConfig = SECURITY_LEVEL_CONFIGS[this.securityLevel];

    // Merge secure proxy config
    const secureProxyConfig: SecureProxyLevelConfig = {
      ...levelConfig.secureProxy,
      ...(options.secureProxyConfig ?? {}),
    };

    // Build config
    this.config = {
      timeout: options.timeout ?? levelConfig.timeout,
      maxIterations: options.maxIterations ?? levelConfig.maxIterations,
      maxToolCalls: options.maxToolCalls ?? levelConfig.maxToolCalls,
      maxConsoleOutputBytes: options.maxConsoleOutputBytes ?? levelConfig.maxConsoleOutputBytes,
      maxConsoleCalls: options.maxConsoleCalls ?? levelConfig.maxConsoleCalls,
      sanitizeStackTraces: options.sanitizeStackTraces ?? levelConfig.sanitizeStackTraces,
      maxSanitizeDepth: options.maxSanitizeDepth ?? levelConfig.maxSanitizeDepth,
      maxSanitizeProperties: options.maxSanitizeProperties ?? levelConfig.maxSanitizeProperties,
      memoryLimit: options.memoryLimit ?? 1 * 1024 * 1024,
      globals: options.globals ?? {},
      toolHandler: options.toolHandler,
      secureProxyConfig,
    };

    // Fails fast on a global that cannot reach the sandbox; run() serializes again to pick up later changes.
    serializeGlobals(this.config.globals);

    // Tool namespaces: validated here so an unsafe name fails at construction (same rules as
    // @enclave-vm/core). A namespace may not collide with a custom global.
    const globalNames = Object.keys(this.config.globals);
    this.toolNamespaces = normalizeToolNamespaces(options.toolNamespaces, { reservedNames: globalNames });

    // Extract custom global names (and the namespace names, which are bound the same way)
    this.customGlobalNames = [...globalNames, ...this.toolNamespaces.map((ns) => ns.name)];
    const customAllowedGlobals = this.customGlobalNames.flatMap((name) => [name, `__safe_${name}`]);

    // Create validator
    const presetName: AstPreset = options.preset ?? 'agentscript';

    if (globalNames.length > 0 && presetName !== 'agentscript') {
      throw new Error(
        "Custom globals are only supported with the 'agentscript' preset. " +
          'Remove globals or switch to preset: "agentscript".',
      );
    }
    if (this.toolNamespaces.length > 0 && presetName !== 'agentscript') {
      throw new Error(
        "Tool namespaces are only supported with the 'agentscript' preset. " +
          'Remove toolNamespaces or switch to preset: "agentscript".',
      );
    }

    this.validator = this.createValidator(presetName, customAllowedGlobals);

    // Config flags
    this.validateCode = options.validate !== false;
    this.transformCode = options.transform !== false;

    // Store custom serializable patterns
    this.customSerializablePatterns = options.customSerializablePatterns ?? [];

    // Build double iframe config
    this.doubleIframeConfig = this.buildDoubleIframeConfig(options.doubleIframe);

    // Create adapter
    this.adapter = new IframeAdapter();
  }

  /**
   * Execute AgentScript code in the browser sandbox
   */
  async run<T = unknown>(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<T>> {
    const startTime = Date.now();

    try {
      // Step 1: Transform
      let transformedCode = code;
      if (this.transformCode) {
        const needsWrapping = !isWrappedInMain(code);
        transformedCode = transformAgentScript(code, {
          wrapInMain: needsWrapping,
          transformCallTool: true,
          transformLoops: true,
          additionalIdentifiers: this.customGlobalNames,
        });
      }

      // Step 2: Validate
      if (this.validateCode) {
        const validationResult = await this.validator.validate(transformedCode);
        if (!validationResult.valid) {
          const errorMessages = this.formatValidationErrors(validationResult.issues);
          return {
            success: false,
            error: {
              name: 'ValidationError',
              message: `AgentScript validation failed:\n${errorMessages}`,
              code: 'VALIDATION_ERROR',
              data: { issues: validationResult.issues },
            },
            stats: {
              duration: Date.now() - startTime,
              toolCallCount: 0,
              iterationCount: 0,
              startTime,
              endTime: Date.now(),
            },
          };
        }
      }

      // Step 3: Build serialized config for iframes
      const serializedConfig: SerializedIframeConfig = {
        timeout: this.config.timeout,
        maxIterations: this.config.maxIterations,
        maxToolCalls: this.config.maxToolCalls,
        maxConsoleOutputBytes: this.config.maxConsoleOutputBytes,
        maxConsoleCalls: this.config.maxConsoleCalls,
        sanitizeStackTraces: this.config.sanitizeStackTraces,
        maxSanitizeDepth: this.config.maxSanitizeDepth,
        maxSanitizeProperties: this.config.maxSanitizeProperties,
        securityLevel: this.securityLevel,
        memoryLimit: this.config.memoryLimit,
        blockedProperties: getBlockedProperties(this.config.secureProxyConfig),
        throwOnBlocked: this.config.secureProxyConfig.throwOnBlocked,
        allowComposites: false,
        globals: serializeGlobals(this.config.globals),
        toolNamespaces: this.toolNamespaces,
      };

      // Step 4: Build validation config for outer iframe
      const pv = this.doubleIframeConfig.parentValidation;
      const validationConfig = {
        validateOperationNames: pv.validateOperationNames,
        allowedOperationPatternSource: pv.allowedOperationPattern?.source,
        allowedOperationPatternFlags: pv.allowedOperationPattern?.flags,
        blockedOperationPatternSources: pv.blockedOperationPatterns?.map((p) => p.source),
        blockedOperationPatternFlags: pv.blockedOperationPatterns?.map((p) => p.flags),
        maxOperationsPerSecond: pv.maxOperationsPerSecond,
        blockSuspiciousSequences: pv.blockSuspiciousSequences,
        rapidEnumerationThreshold: pv.rapidEnumerationThreshold,
        rapidEnumerationOverrides: pv.rapidEnumerationOverrides,
      };

      // Step 5: Build execution context
      const executionContext: IframeExecutionContext = {
        config: serializedConfig,
        toolHandler: toolHandler || this.config.toolHandler,
        securityLevel: this.securityLevel,
        doubleIframeConfig: this.doubleIframeConfig,
        secureProxyConfig: this.config.secureProxyConfig,
        blockedProperties: serializedConfig.blockedProperties,
        // Function-based SuspiciousPattern[] from parentValidation are not serialized here;
        // they require a serialization bridge (see serializePatterns in @enclave-vm/core).
        // String-based SerializableSuspiciousPattern[] from customSerializablePatterns are
        // appended directly since they are already in serializable form.
        suspiciousPatterns: [...DEFAULT_SERIALIZED_PATTERNS, ...this.customSerializablePatterns],
        validationConfig,
      };

      // Step 6: Execute via IframeAdapter
      return await this.adapter.execute<T>(transformedCode, executionContext);
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        error: {
          name: err.name || 'EnclaveError',
          message: err.message || 'Unknown enclave error',
          // Errors raised on the host (e.g. a parse error in the transformer) carry the page's
          // stack; it obeys sanitizeStackTraces like every other returned error.
          stack: sanitizeStackTrace(err.stack, this.config.sanitizeStackTraces),
          code: 'ENCLAVE_ERROR',
        },
        stats: {
          duration: Date.now() - startTime,
          toolCallCount: 0,
          iterationCount: 0,
          startTime,
          endTime: Date.now(),
        },
      };
    }
  }

  /**
   * Get the security level
   */
  getSecurityLevel(): SecurityLevel {
    return this.securityLevel;
  }

  /**
   * Dispose the enclave and cleanup resources
   */
  dispose(): void {
    this.adapter.dispose();
  }

  /**
   * Create a validator based on the selected preset
   */
  private createValidator(presetName: AstPreset, customAllowedGlobals: string[]): JSAstValidator {
    const securityLevelGlobals = getAgentScriptGlobals(this.securityLevel);
    const enclaveSpecificGlobals = [
      'parallel',
      '__safe_parallel',
      '__safe_concat',
      '__safe_template',
      'console',
      '__safe_console',
    ];
    const allAllowedGlobals = [...securityLevelGlobals, ...enclaveSpecificGlobals, ...customAllowedGlobals];

    switch (presetName) {
      case 'agentscript':
        return new JSAstValidator(
          createAgentScriptPreset({
            securityLevel: this.securityLevel,
            allowedGlobals: allAllowedGlobals,
            allowDynamicArrayFill: this.config.memoryLimit > 0,
          }),
        );
      case 'strict':
        return new JSAstValidator(createStrictPreset());
      case 'secure':
        return new JSAstValidator(createSecurePreset());
      case 'standard':
        return new JSAstValidator(createStandardPreset());
      case 'permissive':
        return new JSAstValidator(createPermissivePreset());
      default: {
        const _exhaustiveCheck: never = presetName;
        throw new Error(`Unknown preset: ${_exhaustiveCheck}`);
      }
    }
  }

  /**
   * Build double iframe configuration
   */
  private buildDoubleIframeConfig(options?: Partial<DoubleIframeConfig>): DoubleIframeConfig {
    if (!options) {
      return {
        ...DEFAULT_DOUBLE_IFRAME_CONFIG,
        parentValidation: {
          ...DEFAULT_DOUBLE_IFRAME_CONFIG.parentValidation,
          suspiciousPatterns: [...DEFAULT_DOUBLE_IFRAME_CONFIG.parentValidation.suspiciousPatterns],
          rapidEnumerationOverrides: { ...DEFAULT_DOUBLE_IFRAME_CONFIG.parentValidation.rapidEnumerationOverrides },
        },
      };
    }

    return {
      enabled: options.enabled ?? DEFAULT_DOUBLE_IFRAME_CONFIG.enabled,
      parentTimeoutBuffer: options.parentTimeoutBuffer ?? DEFAULT_DOUBLE_IFRAME_CONFIG.parentTimeoutBuffer,
      parentValidation: {
        ...DEFAULT_DOUBLE_IFRAME_CONFIG.parentValidation,
        ...options.parentValidation,
        suspiciousPatterns: [
          ...DEFAULT_DOUBLE_IFRAME_CONFIG.parentValidation.suspiciousPatterns,
          ...(options.parentValidation?.suspiciousPatterns ?? []),
        ],
      },
    };
  }

  /**
   * Format validation errors
   */
  private formatValidationErrors(issues: ValidationIssue[]): string {
    const seen = new Set<string>();
    const uniqueErrors: string[] = [];

    for (const issue of issues) {
      const locationStr = issue.location ? `:${issue.location.line}:${issue.location.column}` : '';
      const key = `${issue.code}|${issue.message}|${locationStr}`;

      if (!seen.has(key)) {
        seen.add(key);
        const formattedLocation = issue.location ? ` (line ${issue.location.line})` : '';
        uniqueErrors.push(`${issue.code}${formattedLocation}: ${issue.message}`);
      }
    }

    return uniqueErrors.join('\n');
  }
}
