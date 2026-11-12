import type { ValidationRule, ValidationContext } from '../interfaces';
import { ValidationSeverity } from '../interfaces';
import { analyzeScopes } from '../utils/scope-analysis';

/**
 * Configuration options for UnknownGlobalRule
 */
export interface UnknownGlobalOptions {
  /**
   * List of allowed global identifiers
   * Default: ['callTool', 'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Date']
   */
  allowedGlobals?: string[];

  /**
   * Whether to allow standard JavaScript globals (Infinity, NaN, isNaN, isFinite, etc.)
   * Default: true
   */
  allowStandardGlobals?: boolean;

  /**
   * Whether a script may assign to an allowed global (`Math = x`, `callTool = fn`, `[JSON] = y`,
   * `for (Object of z)`, `delete Array`).
   * Default: false. A global the script may READ is still not one it may replace.
   */
  allowGlobalAssignment?: boolean;

  /**
   * Custom error message
   */
  message?: string;
}

/**
 * Standard JavaScript global identifiers that are always safe
 * These are built-in constants and functions that don't provide escape vectors
 */
const STANDARD_SAFE_GLOBALS = new Set([
  // Literals (handled by parser, but included for completeness)
  'undefined',
  'null',
  'true',
  'false',
  'Infinity',
  'NaN',

  // Safe utility functions
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
]);

/**
 * UnknownGlobalRule - Validates that all identifier references are either declared or allowed
 *
 * This rule implements a **whitelist-based approach** for identifiers:
 * - All identifiers must be either:
 *   1. Declared locally (variables, parameters, functions)
 *   2. Explicitly in the `allowedGlobals` list
 *   3. Standard safe globals (if enabled)
 *
 * **Purpose:**
 * - Prevent access to dangerous globals (process, require, window, etc.)
 * - Ensure explicit control over available APIs
 * - Create a secure sandbox with known capabilities
 *
 * **Resolution is lexical.** An identifier counts as "declared locally" only when a declaration of
 * that name is in scope where the identifier is used. A declaration in some other block, arrow
 * function or catch clause does not make the name local elsewhere:
 * ```javascript
 * { let globalThis = 1; }
 * const g = globalThis;          // ❌ BLOCKED: this `globalThis` is the global, not the block's variable
 * ```
 * Assignment targets are checked like reads (`x = 1`, `[x] = y`, `for (x of y)`, `x++`), and an
 * assignment to an allowed global is refused unless `allowGlobalAssignment` is set.
 *
 * **Example violations:**
 * ```javascript
 * console.log('hello');          // ❌ BLOCKED: console not in allowedGlobals
 * const x = process.env.HOME;    // ❌ BLOCKED: process not allowed
 * fetch('https://api.com');      // ❌ BLOCKED: fetch not allowed
 * ```
 *
 * **Valid code (with default allowedGlobals):**
 * ```javascript
 * const data = await callTool('users:list', {});  // ✅ callTool in allowedGlobals
 * const max = Math.max(1, 2, 3);                  // ✅ Math in allowedGlobals
 * const obj = JSON.parse('{"a":1}');              // ✅ JSON in allowedGlobals
 * const local = 42;                               // ✅ locally declared
 * ```
 *
 * @example
 * ```typescript
 * const rule = new UnknownGlobalRule({
 *   allowedGlobals: ['callTool', 'getTool', 'Math', 'JSON'],
 *   allowStandardGlobals: true,
 * });
 * ```
 */
export class UnknownGlobalRule implements ValidationRule {
  readonly name = 'unknown-global';
  readonly description =
    'Validates that all identifier references are either declared locally or in allowed globals list';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly allowedGlobals: Set<string>;
  /** The allowed globals in the order they are shown, computed once: the list does not change */
  private readonly allowedGlobalsSorted: readonly string[];
  private readonly allowedGlobalsText: string;
  private readonly allowGlobalAssignment: boolean;
  private readonly customMessage?: string;

  constructor(options: UnknownGlobalOptions = {}) {
    const baseGlobals = options.allowedGlobals || [
      'callTool',
      'Math',
      'JSON',
      'Array',
      'Object',
      'String',
      'Number',
      'Date',
    ];
    this.allowedGlobals = new Set(baseGlobals);

    // Add standard safe globals if enabled
    if (options.allowStandardGlobals !== false) {
      STANDARD_SAFE_GLOBALS.forEach((g) => this.allowedGlobals.add(g));
    }

    this.allowedGlobalsSorted = Object.freeze(Array.from(this.allowedGlobals).sort());
    this.allowedGlobalsText = this.allowedGlobalsSorted.join(', ');

    this.allowGlobalAssignment = options.allowGlobalAssignment === true;
    this.customMessage = options.message;
  }

  validate(context: ValidationContext): void {
    // Every reference that no enclosing scope declares reaches a global.
    const { freeReferences } = analyzeScopes(context.ast);

    // The list of allowed globals is the host's configuration, the same for every identifier. It
    // is stated in the first issue of a validation and not repeated: an issue then costs what
    // the identifier costs, however many globals the host declared.
    let listStated = false;

    for (const ref of freeReferences) {
      const identifierName = ref.name;
      const location = ref.node.loc
        ? {
            line: ref.node.loc.start.line,
            column: ref.node.loc.start.column,
            endLine: ref.node.loc.end.line,
            endColumn: ref.node.loc.end.column,
          }
        : undefined;

      if (!this.allowedGlobals.has(identifierName)) {
        const stateList = !listStated;
        listStated = true;
        context.report({
          code: 'UNKNOWN_GLOBAL',
          message:
            this.customMessage ||
            `Unknown identifier "${identifierName}". ` +
              `All identifiers must be either declared locally or in the allowed globals list.` +
              (stateList ? ` Allowed globals: ${this.allowedGlobalsText}` : ''),
          location,
          data: stateList
            ? { identifier: identifierName, allowedGlobals: [...this.allowedGlobalsSorted] }
            : { identifier: identifierName },
        });
        continue;
      }

      if (ref.write && !this.allowGlobalAssignment) {
        context.report({
          code: 'GLOBAL_ASSIGNMENT',
          message:
            `Cannot assign to "${identifierName}": it is a global provided by the runtime, not a local variable. ` +
            `Declare your own variable with const or let instead.`,
          location,
          data: { identifier: identifierName },
        });
      }
    }
  }
}
