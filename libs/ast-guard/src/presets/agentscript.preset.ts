import { ValidationRule } from '../interfaces';
import {
  NoEvalRule,
  DisallowedIdentifierRule,
  NoGlobalAccessRule,
  ForbiddenLoopRule,
  CallArgumentValidationRule,
  ReservedPrefixRule,
  UnknownGlobalRule,
  NoUserDefinedFunctionsRule,
  UnreachableCodeRule,
  StaticCallTargetRule,
  RequiredFunctionCallRule,
  NoRegexLiteralRule,
  NoRegexMethodsRule,
  NoComputedDestructuringRule,
  InfiniteLoopRule,
  ResourceExhaustionRule,
  NoJsonCallbacksRule,
} from '../rules';

// =============================================================================
// Security-Level-Aware Allowed Globals
// =============================================================================
// These exports define what globals are available at each security level.
// Both AST guard and worker sandbox use these for defense-in-depth.

/**
 * Base globals allowed at STRICT security level only
 * Absolute minimum: core types + callTool
 */
export const AGENTSCRIPT_STRICT_GLOBALS = [
  // Core tool API
  'callTool',
  '__safe_callTool',

  // Safe built-in objects for data manipulation
  'Math',
  'JSON',
  'Array',
  'Object',
  'String',
  'Number',
  'Date',

  // Safe standard globals
  'undefined',
  'NaN',
  'Infinity',

  // Runtime-injected safe loop functions
  '__safe_forOf',
  '__safe_for',
  '__safe_while',
  '__safe_doWhile',

  // Runtime-injected configuration
  '__maxIterations',
] as const;

/**
 * Globals for SECURE security level
 * Adds safe utility functions (pure functions with no side effects)
 */
export const AGENTSCRIPT_SECURE_GLOBALS = [
  ...AGENTSCRIPT_STRICT_GLOBALS,

  // Safe parsing functions (pure, no side effects)
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',

  // URI encoding (safe string manipulation, no side effects)
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
] as const;

/**
 * Globals for STANDARD security level
 * Same as SECURE (room for future expansion)
 */
export const AGENTSCRIPT_STANDARD_GLOBALS = [...AGENTSCRIPT_SECURE_GLOBALS] as const;

/**
 * Globals for PERMISSIVE security level
 * Adds debugging/logging capabilities
 */
export const AGENTSCRIPT_PERMISSIVE_GLOBALS = [
  ...AGENTSCRIPT_STANDARD_GLOBALS,

  // Console for debugging (rate-limited at runtime)
  'console',
  '__safe_console',
] as const;

// Legacy alias for backwards compatibility
export const AGENTSCRIPT_BASE_GLOBALS = AGENTSCRIPT_STRICT_GLOBALS;

/**
 * Security level type for globals selection
 */
export type SecurityLevel = 'STRICT' | 'SECURE' | 'STANDARD' | 'PERMISSIVE';

/**
 * Get the allowed globals for a given security level
 *
 * Security levels (from most to least restrictive):
 * - STRICT: Absolute minimum (core types + callTool only)
 * - SECURE: Adds safe utility functions (parseInt, encodeURI, etc.)
 * - STANDARD: Same as SECURE (room for future expansion)
 * - PERMISSIVE: Adds console for debugging
 *
 * @param securityLevel The security level
 * @returns Array of allowed global identifiers
 */
export function getAgentScriptGlobals(securityLevel: SecurityLevel | string): readonly string[] {
  switch (securityLevel) {
    case 'PERMISSIVE':
      return AGENTSCRIPT_PERMISSIVE_GLOBALS;
    case 'STANDARD':
      return AGENTSCRIPT_STANDARD_GLOBALS;
    case 'SECURE':
      return AGENTSCRIPT_SECURE_GLOBALS;
    case 'STRICT':
    default:
      return AGENTSCRIPT_STRICT_GLOBALS;
  }
}

/**
 * Configuration options for AgentScript preset
 */
export interface AgentScriptOptions {
  /**
   * Security level that determines default allowed globals.
   * If allowedGlobals is also provided, it takes precedence.
   *
   * - STRICT/SECURE: Base globals only (core types + callTool)
   * - STANDARD: Adds utility functions (parseInt, encodeURI, etc.)
   * - PERMISSIVE: Adds console for debugging
   *
   * Default: 'STANDARD'
   */
  securityLevel?: SecurityLevel | string;

  /**
   * List of allowed global identifiers (APIs available to agent code)
   * If provided, overrides the securityLevel-based defaults.
   * Default: Based on securityLevel (see getAgentScriptGlobals)
   */
  allowedGlobals?: string[];

  /**
   * Additional identifiers to block beyond the default dangerous set
   */
  additionalDisallowedIdentifiers?: string[];

  /**
   * Whether to allow arrow functions (for array methods like map, filter)
   * Default: true
   */
  allowArrowFunctions?: boolean;

  /**
   * Allow specific loop types
   * Default: { allowFor: true, allowForOf: true } (bounded loops only)
   */
  allowedLoops?: {
    allowFor?: boolean;
    allowWhile?: boolean;
    allowDoWhile?: boolean;
    allowForIn?: boolean;
    allowForOf?: boolean;
  };

  /**
   * Validation rules for callTool arguments
   */
  callToolValidation?: {
    /** Minimum number of arguments */
    minArgs?: number;
    /** Maximum number of arguments */
    maxArgs?: number;
    /** Expected types for each argument position */
    expectedTypes?: Array<'string' | 'number' | 'boolean' | 'object' | 'array' | 'function' | 'literal'>;
  };

  /**
   * Reserved prefixes that user code cannot use
   * Default: ['__ag_', '__safe_']
   */
  reservedPrefixes?: string[];

  /**
   * Configuration for static call target validation
   * Ensures callTool first argument is always a static string literal
   */
  staticCallTarget?: {
    /**
     * Whether to enable static call target validation
     * Default: true
     */
    enabled?: boolean;
    /**
     * Whitelist of allowed tool names (exact strings or RegExp patterns)
     * If provided, only these tools can be called
     */
    allowedToolNames?: (string | RegExp)[];
  };

  /**
   * Whether to require at least one callTool invocation
   * When enabled, scripts that don't call callTool will fail validation
   * Default: false
   */
  requireCallTool?: boolean;
}

/**
 * Creates an AgentScript preset - a strict JS subset for AI agent orchestration
 *
 * **AgentScript Language (v1):**
 * AgentScript is a restricted subset of JavaScript designed for safe orchestration:
 * - Simple, linear code flow (no recursion, no complex control flow)
 * - Tool calls via `await callTool(name, args)`
 * - Data manipulation with array methods (map, filter, reduce)
 * - Bounded loops only (for, for-of with iteration limits)
 * - No access to dangerous globals (process, require, eval, etc.)
 * - No user-defined functions (v1 - prevents recursion)
 *
 * **Use Cases:**
 * - AI agents orchestrating multiple MCP tool calls
 * - Data aggregation across multiple API calls
 * - Simple conditional logic and filtering
 * - Result transformation and formatting
 *
 * **Example AgentScript Code:**
 * ```javascript
 * // Get active admin users
 * const users = await callTool('users:list', {
 * limit: 100,
 * filter: { role: 'admin', active: true }
 * });
 *
 * // Get unpaid invoices for each admin
 * const results = [];
 * for (const user of users.items) {
 * const invoices = await callTool('billing:listInvoices', {
 * userId: user.id,
 * status: 'unpaid'
 * });
 *
 * if (invoices.items.length > 0) {
 * results.push({
 * userId: user.id,
 * userName: user.name,
 * unpaidCount: invoices.items.length,
 * totalAmount: invoices.items.reduce((sum, inv) => sum + inv.amount, 0)
 * });
 * }
 * }
 *
 * return results;
 * ```
 *
 * **Security Model:**
 * 1. **Static Validation** (this preset):
 * - Block dangerous globals (process, require, eval, etc.)
 * - Block user-defined functions (no recursion)
 * - Block unknown identifiers (whitelist-only)
 * - Block reserved prefixes (__ag_, __safe_)
 * - Allow only safe constructs
 *
 * 2. **Transformation** (separate step):
 * - Wrap code in `async function __ag_main() {}`
 * - Transform `callTool` → `__safe_callTool`
 * - Transform loops → `__safe_for`/`__safe_forOf`
 *
 * 3. **Runtime** (Enclave):
 * - Execute in isolated sandbox (vm2/nodevm/wasm)
 * - Provide only `__safe_*` globals
 * - Enforce timeouts and resource limits
 *
 * @param options Configuration options for the preset
 * @returns Array of configured validation rules
 *
 * @example
 * ```typescript
 * import { createAgentScriptPreset } from 'ast-guard';
 *
 * // Default configuration
 * const rules = createAgentScriptPreset();
 *
 * // Custom configuration
 * const rules = createAgentScriptPreset({
 * allowedGlobals: ['callTool', 'getTool', 'Math', 'JSON'],
 * allowArrowFunctions: true,
 * allowedLoops: { allowFor: true, allowForOf: true },
 * });
 * ```
 */
export function createAgentScriptPreset(options: AgentScriptOptions = {}): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // Determine allowed globals based on priority:
  // 1. Explicit allowedGlobals (if provided)
  // 2. Security level (if provided)
  // 3. Default to STANDARD level globals
  const allowedGlobals: readonly string[] = options.allowedGlobals
    ? options.allowedGlobals
    : getAgentScriptGlobals(options.securityLevel || 'STANDARD');

  // 1. Block all eval-like constructs
  rules.push(new NoEvalRule());

  // 2. Block reserved internal prefixes
  rules.push(
    new ReservedPrefixRule({
      reservedPrefixes: options.reservedPrefixes || ['__ag_', '__safe_'],
      allowedIdentifiers: ['__ag_main'], // Allow the compiler wrapper function
    }),
  );

  // 3. Validate all identifiers against whitelist
  rules.push(
    new UnknownGlobalRule({
      // Spread to convert readonly array to mutable (required by UnknownGlobalRule)
      allowedGlobals: [...allowedGlobals],
      // Strictly disable standard globals to prevent access to RegExp, Promise, etc.
      // We rely on the explicit list above for the few standard globals we actually want.
      allowStandardGlobals: false,
    }),
  );

  // 4. Block user-defined functions (v1 restriction)
  rules.push(
    new NoUserDefinedFunctionsRule({
      allowArrowFunctions: options.allowArrowFunctions !== false, // default true
      allowFunctionExpressions: false,
      allowedFunctionNames: ['__ag_main'], // Allow compiler wrapper
    }),
  );

  // 5. Block dangerous global object access patterns
  rules.push(
    new NoGlobalAccessRule({
      blockedGlobals: ['window', 'globalThis', 'self', 'global', 'this'],
      blockMemberAccess: true,
      blockComputedAccess: true,
    }),
  );

  // 6. Block comprehensive list of dangerous identifiers
  const dangerousIdentifiers = [
    // Node.js/System access
    'process',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'Buffer',

    // Code execution (already blocked by NoEvalRule, but include for clarity)
    'eval',
    'Function',
    'AsyncFunction',
    'GeneratorFunction',

    // Block Arguments object (scope leakage)
    'arguments',

    // Block RegExp constructor (ReDoS bypass via new RegExp)
    'RegExp',

    // Block Promise (Async flooding/Task manipulation)
    'Promise',

    // Block Symbol (Iterator modification / Prototype poisoning)
    'Symbol',

    // Prototype manipulation
    'constructor',
    '__proto__',
    'prototype',

    // Reflection and meta-programming
    'Proxy',
    'Reflect',

    // Error manipulation (stack traces can leak)
    'Error',
    'TypeError',
    'ReferenceError',
    'SyntaxError',
    'RangeError',
    'URIError',
    'EvalError',
    'AggregateError',

    // Web APIs (if in browser context)
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'crypto',
    'performance',
    'structuredClone', // Object cloning API
    'AbortController', // Async control flow manipulation
    'AbortSignal', // Async control flow manipulation
    'MessageChannel', // Cross-context messaging
    'MessagePort', // Cross-context messaging
    'BroadcastChannel', // Cross-tab communication
    'TextEncoder', // Binary encoding
    'TextDecoder', // Binary decoding
    'Intl', // Environment fingerprinting (timezone/locale)

    // Timers (timing attacks)
    'setTimeout',
    'setInterval',
    'setImmediate',
    'clearTimeout',
    'clearInterval',
    'clearImmediate',
    'queueMicrotask', // Microtask flooding attacks

    // WebAssembly (native code execution)
    'WebAssembly',

    // Workers (sandbox escape)
    'Worker',
    'SharedWorker',
    'ServiceWorker',

    // Weak references (can hold references to sensitive objects, harder to audit)
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'FinalizationRegistry',

    // Memory Hazards
    'Map',
    'Set',

    // Additional dangerous globals
    'Atomics',
    'SharedArrayBuffer',
    'importScripts',

    // Dangerous JavaScript APIs (potential sandbox escape vectors)
    'ShadowRealm', // Escape via isolated execution
    'Iterator', // Iterator helpers can access prototype chain
    'AsyncIterator', // Async iterator helpers can access prototype chain

    ...(options.additionalDisallowedIdentifiers || []),
  ];
  rules.push(new DisallowedIdentifierRule({ disallowed: dangerousIdentifiers }));

  // 7. Configure loop restrictions
  rules.push(
    new ForbiddenLoopRule({
      allowFor: options.allowedLoops?.allowFor ?? true, // default true (bounded)
      allowWhile: options.allowedLoops?.allowWhile ?? false, // default false (unbounded)
      allowDoWhile: options.allowedLoops?.allowDoWhile ?? false, // default false (unbounded)
      allowForIn: options.allowedLoops?.allowForIn ?? false, // default false (prototype walking)
      allowForOf: options.allowedLoops?.allowForOf ?? true, // default true (safe iteration)
    }),
  );

  // 7b. Detect obvious infinite loop patterns (defense-in-depth)
  // This catches patterns like for(;;), while(true), etc.
  // Runtime protection (iteration limits) is still in place, but this provides
  // better error messages and faster failure for obvious infinite loops.
  rules.push(new InfiniteLoopRule());

  // 8. Validate callTool arguments (if configured)
  if (options.callToolValidation) {
    rules.push(
      new CallArgumentValidationRule({
        functions: {
          callTool: {
            minArgs: options.callToolValidation.minArgs || 2,
            maxArgs: options.callToolValidation.maxArgs || 2,
            expectedTypes: options.callToolValidation.expectedTypes || ['string', 'object'],
          },
        },
      }),
    );
  }

  // 9. Detect unreachable code
  rules.push(new UnreachableCodeRule());

  // 10. Enforce static string literals for callTool targets (default: enabled)
  if (options.staticCallTarget?.enabled !== false) {
    rules.push(
      new StaticCallTargetRule({
        targetFunctions: ['callTool', '__safe_callTool'],
        allowedToolNames: options.staticCallTarget?.allowedToolNames,
      }),
    );
  }

  // 11. Require at least one callTool invocation (optional, default: disabled)
  if (options.requireCallTool) {
    rules.push(
      new RequiredFunctionCallRule({
        required: ['callTool'],
        minCalls: 1,
        messageTemplate: 'AgentScript code must contain at least one callTool invocation',
      }),
    );
  }

  // 12. Block ALL regex literals (ReDoS prevention)
  // AgentScript agents should use API filtering, not regex
  rules.push(
    new NoRegexLiteralRule({
      blockAll: true, // Block all regex literals in AgentScript
    }),
  );

  // 13. Block regex methods on strings and regex objects
  // Prevents ReDoS via .match(), .test(), .replace(), etc.
  rules.push(
    new NoRegexMethodsRule({
      allowStringArguments: false, // Block even string arguments for maximum security
    }),
  );

  // 14. Block computed property names in destructuring patterns
  // This prevents runtime property name construction attacks like:
  //   const {['const'+'ructor']:Func} = callTool;  // Bypasses static analysis!
  rules.push(new NoComputedDestructuringRule());

  // 15. Detect resource exhaustion patterns (CPU/memory DoS)
  // - Large BigInt exponentiation (bypasses VM timeout)
  // - Large array allocations
  // - Constructor obfuscation via string concatenation
  rules.push(
    new ResourceExhaustionRule({
      maxBigIntExponent: 10000, // Block 2n ** 10001n and larger
      maxArraySize: 1000000, // Block new Array(1000001) and larger
      maxStringRepeat: 100000, // Block 'x'.repeat(100001) and larger
      blockConstructorAccess: true, // Block obj.constructor and obj['constructor']
      blockBigIntExponentiation: false, // Only block large exponents, not all
    }),
  );

  // 16. Block JSON.stringify/parse with callback functions (property enumeration attack)
  // Prevents "Native Walker" attacks where replacer/reviver functions are used
  // to enumerate and leak internal sandbox globals or sensitive object properties.
  // Vector 960: JSON.stringify(this, walker) can walk and leak global scope properties.
  rules.push(new NoJsonCallbacksRule());

  return rules;
}
