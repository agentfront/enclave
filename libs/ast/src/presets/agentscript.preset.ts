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
  AllowedSyntaxRule,
  AGENTSCRIPT_ALLOWED_NODE_TYPES,
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
 * Identifiers AgentScript refuses anywhere in a script, whether as a variable or as a property
 * name (`obj.fetch`). A custom global listed in `allowedGlobals` is exempted from this list for
 * that preset; `additionalDisallowedIdentifiers` extends it.
 */
export const AGENTSCRIPT_DISALLOWED_IDENTIFIERS: readonly string[] = Object.freeze([
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
]);

/**
 * Names AgentScript refuses as PROPERTY names (`obj.name`, `obj['name']`, `const { name } = obj`),
 * whatever object they are read from. They stay usable as variable names.
 *
 * These are the reflection entry points that reach a prototype or a property descriptor without
 * naming `constructor`, `__proto__` or `prototype`:
 * - the legacy accessors, where `obj.__lookupGetter__('__proto__')` is a `getPrototypeOf` in disguise
 *   and `obj.__defineGetter__(...)` installs an accessor on any object it is called on;
 * - the `Object` statics that read or rewrite prototypes and descriptors. Matching the property name
 *   rather than the call `Object.<name>(...)` is what makes the check hold for an alias
 *   (`const O = Object; O.getPrototypeOf(x)`), a literal key (`Object['getPrototypeOf']`), a method
 *   passed as a value (`list.map(Object.getPrototypeOf)`) and `Object.getPrototypeOf.call(...)`.
 *
 * Mirrors the prototype and descriptor categories of the runtime membrane, so the static layer and
 * the runtime layer refuse the same names.
 */
export const AGENTSCRIPT_DISALLOWED_PROPERTIES: readonly string[] = Object.freeze([
  // Legacy accessor API
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',

  // Prototype reads and writes
  'getPrototypeOf',
  'setPrototypeOf',

  // Property descriptors
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',

  // Symbols are not part of AgentScript; this is how to obtain one without naming `Symbol`
  'getOwnPropertySymbols',
]);

/**
 * Configuration options for AgentScript preset
 */
export interface AgentScriptOptions {
  /**
   * Security level that determines default allowed globals.
   * If allowedGlobals is also provided, it takes precedence.
   *
   * - STRICT: Base globals only (core types + callTool)
   * - SECURE, STANDARD: Add utility functions (parseInt, encodeURI, etc.)
   * - PERMISSIVE: Adds console for debugging
   *
   * Default: 'STANDARD'
   */
  securityLevel?: SecurityLevel | string;

  /**
   * List of allowed global identifiers (APIs available to agent code).
   * If provided, overrides the securityLevel-based defaults.
   *
   * Identifiers in this list are also removed from the built-in dangerous
   * identifiers blocklist, so a custom global like `process` won't be
   * rejected by DisallowedIdentifierRule.
   *
   * Note: `additionalDisallowedIdentifiers` takes higher precedence —
   * if the same identifier appears in both lists, it remains blocked.
   *
   * Default: Based on securityLevel (see getAgentScriptGlobals)
   */
  allowedGlobals?: string[];

  /**
   * Names of the globals in `allowedGlobals` that are objects of the host and not strings: tool
   * namespaces, custom globals that hold an object or a function. A method called `match`,
   * `matchAll` or `search` on one of them (`docs.search(args)`) is the host's method, not the
   * string method that compiles its argument into a regular expression, and is accepted with any
   * argument. On every other value those three are refused. Each name is accepted with and
   * without the `__safe_` prefix the transformer adds.
   *
   * Default: []
   */
  hostObjectGlobals?: string[];

  /**
   * Refuse every use of a property named `match`, `matchAll` or `search` that is not a direct
   * call: reading it as a value, a member of it, and taking it by destructuring. (A direct call
   * is checked as always; `.call`, `.apply`, `.bind` and a template tag are always refused.)
   *
   * The method as a value is where every call the validator cannot check starts from. Refusing
   * the value also refuses a field of ordinary data with one of these names (`params.search`),
   * so it is off by default: by default the realm of `@enclave-vm/core` refuses to run a regular
   * expression whatever a script does. Turn it on where the validator is the only thing between
   * a script and the regular-expression engine (a realm that is not reduced to the allowlist).
   * Methods of the globals listed in `hostObjectGlobals` are not affected.
   *
   * Default: false
   */
  requireDirectRegexMethodCalls?: boolean;

  /**
   * Additional identifiers to block beyond the default dangerous set.
   *
   * These always take precedence over `allowedGlobals`. If an identifier
   * is listed here, it will be blocked even if it also appears in
   * `allowedGlobals`.
   *
   * @example
   * // Allow most custom globals but force-block `dangerousApi`:
   * createAgentScriptPreset({
   *   allowedGlobals: ['callTool', 'safeApi', 'dangerousApi'],
   *   additionalDisallowedIdentifiers: ['dangerousApi'],
   * });
   * // Result: 'safeApi' is allowed, 'dangerousApi' is blocked.
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
   * Further prefixes that user code cannot use, in addition to the two of the runtime
   * (`__ag_` and `__safe_`), which are always reserved.
   * Default: []
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

  /**
   * Syntax node types to allow in addition to `AGENTSCRIPT_ALLOWED_NODE_TYPES`.
   *
   * AgentScript refuses every construct that is not on its syntax allowlist (`this`, classes,
   * `new.target`, `debugger`, ...). Listing a node type here re-enables it. A construct that
   * shares its node type with an allowed one is listed under its own name: `UsingDeclaration`,
   * `AwaitUsingDeclaration`, `ForAwaitStatement`, `GeneratorFunction`.
   * Each of the refused constructs is refused for a security reason (see
   * `AGENTSCRIPT_ALLOWED_NODE_TYPES`), so only do this for a host that does not run untrusted code.
   *
   * Default: []
   */
  additionalAllowedSyntax?: string[];

  /**
   * Allow dynamic (computed) array size for .fill() operations
   *
   * When true, `Array(dynamicSize).fill()` is allowed because runtime memory
   * patching will enforce the limit. Only enable this when memoryLimit is
   * configured at runtime.
   *
   * When false (default), only literal sizes are allowed for .fill() to
   * prevent memory exhaustion in environments without runtime protection.
   *
   * Default: false
   */
  allowDynamicArrayFill?: boolean;
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
 * - Execute in the sandbox of `@enclave-vm/core` (a `node:vm` realm, a worker, or its interpreter)
 * - Provide only `__safe_*` globals
 * - Enforce timeouts and resource limits
 *
 * @param options Configuration options for the preset
 * @returns Array of configured validation rules
 *
 * @example
 * ```typescript
 * import { createAgentScriptPreset } from '@enclave-vm/ast';
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

  // 1b. Syntax allowlist: refuse every node type AgentScript is not made of. The rules below each
  // name what they block; this one names what is allowed, so a construct none of them thought of
  // (`this`, classes, `new.target`, `debugger`, future syntax) is refused too.
  rules.push(
    new AllowedSyntaxRule({
      allowedNodeTypes: [...AGENTSCRIPT_ALLOWED_NODE_TYPES, ...(options.additionalAllowedSyntax ?? [])],
    }),
  );

  // 2. Block reserved internal prefixes
  rules.push(
    new ReservedPrefixRule({
      // The prefixes of the runtime are reserved whatever a host adds to them
      reservedPrefixes: [...new Set(['__ag_', '__safe_', ...(options.reservedPrefixes ?? [])])],
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
      // The reflection statics are refused by name on `Object`, so `Object` may not go by another name
      requireDirectObjectUse: true,
    }),
  );

  // 6. Block comprehensive list of dangerous identifiers
  const dangerousIdentifiers = AGENTSCRIPT_DISALLOWED_IDENTIFIERS;
  // Filter out identifiers that are explicitly in allowedGlobals (e.g. user provided 'process' as a custom global)
  // but preserve any additionalDisallowedIdentifiers (those always take precedence)
  const allowedSet = new Set(allowedGlobals);
  const additionalSet = new Set(options.additionalDisallowedIdentifiers || []);
  const filteredDangerousIdentifiers = [
    ...new Set([
      ...dangerousIdentifiers.filter((id) => !allowedSet.has(id) || additionalSet.has(id)),
      ...(options.additionalDisallowedIdentifiers || []),
    ]),
  ];
  rules.push(
    new DisallowedIdentifierRule({
      disallowed: filteredDangerousIdentifiers,
      // Reflection entry points, refused by property name on any object (alias-proof)
      disallowedProperties: [...AGENTSCRIPT_DISALLOWED_PROPERTIES],
      // `{ __proto__: x }` sets a prototype; it is the one key that is not a plain property
      blockProtoInObjectLiterals: true,
    }),
  );

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

  // 8. Validate callTool arguments (if configured). Under both names: a host validates a script
  // as written (`callTool`) or after the transform that renames the call (`__safe_callTool`).
  if (options.callToolValidation) {
    const callToolArguments = {
      minArgs: options.callToolValidation.minArgs || 2,
      maxArgs: options.callToolValidation.maxArgs || 2,
      expectedTypes: options.callToolValidation.expectedTypes || ['string', 'object'],
    };
    rules.push(
      new CallArgumentValidationRule({
        functions: {
          callTool: callToolArguments,
          __safe_callTool: callToolArguments,
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
        // The tool name is only checkable on a direct call, so nothing else may be done with callTool
        requireDirectCall: true,
      }),
    );
  }

  // 11. Require at least one callTool invocation (optional, default: disabled)
  if (options.requireCallTool) {
    rules.push(
      new RequiredFunctionCallRule({
        // Either name is the call: as written, or after the transform that renames it
        required: ['callTool', '__safe_callTool'],
        mode: 'any',
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
      hostObjectNames: (options.hostObjectGlobals ?? []).flatMap((name) => [name, `__safe_${name}`]),
      requireDirectCall: options.requireDirectRegexMethodCalls === true,
    }),
  );

  // 14. Block computed property names in destructuring patterns
  // This prevents runtime property name construction attacks like:
  //   const {['const'+'ructor']:Func} = callTool;  // Bypasses static analysis!
  rules.push(new NoComputedDestructuringRule({ additionalDangerousKeys: [...AGENTSCRIPT_DISALLOWED_PROPERTIES] }));

  // 15. Detect resource exhaustion patterns (CPU/memory DoS)
  // - Large BigInt exponentiation (bypasses VM timeout)
  // - Large array allocations
  // - Large array fill operations (Vector 1110: "High-Precision Math Stall")
  // - Constructor obfuscation via string concatenation
  rules.push(
    new ResourceExhaustionRule({
      maxBigIntExponent: 10000, // Block 2n ** 10001n and larger
      maxArraySize: 1000000, // Block new Array(1000001) and larger
      maxArrayFillSize: 100000, // Block Array(100001).fill() - Vector 1110 uses 500000
      maxStringRepeat: 100000, // Block 'x'.repeat(100001) and larger
      blockConstructorAccess: true, // Block obj.constructor and obj['constructor']
      blockBigIntExponentiation: false, // Only block large exponents, not all
      // Allow dynamic Array.fill when runtime protection is enabled (memoryLimit set)
      allowDynamicArrayFill: options.allowDynamicArrayFill ?? false,
    }),
  );

  // 16. Block JSON.stringify/parse with callback functions (property enumeration attack)
  // Prevents "Native Walker" attacks where replacer/reviver functions are used
  // to enumerate and leak internal sandbox globals or sensitive object properties.
  // Vector 960: JSON.stringify(this, walker) can walk and leak global scope properties.
  // requireDirectUse: JSON may only appear as JSON.parse(...) / JSON.stringify(...), so the callback
  // check cannot be sidestepped through an alias, .call/.apply or a computed method name.
  rules.push(new NoJsonCallbacksRule({ requireDirectUse: true }));

  return rules;
}
