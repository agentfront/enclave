import type { ValidationRule, ValidationContext } from '../interfaces';
import { ValidationSeverity } from '../interfaces';
import * as walk from 'acorn-walk';

/**
 * Property keys that must never be read through destructuring: their prototype chain reaches host
 * intrinsics (constructor -> Function). Blocking them statically closes GHSA-3279, where
 * `const { "constructor": C } = {}` and `const { prototype: p } = callTool` slipped past the
 * computed-key guard because the key is a static Identifier/Literal. Mirrors the runtime membrane
 * and interpreter blocked-key sets.
 */
const DANGEROUS_DESTRUCTURING_KEYS = new Set([
  'constructor',
  'prototype',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/**
 * Configuration options for NoComputedDestructuringRule
 */
export interface NoComputedDestructuringOptions {
  /**
   * Custom error message
   */
  message?: string;
}

/**
 * NoComputedDestructuringRule - Blocks computed property names in destructuring patterns
 *
 * **Security Rationale:**
 * Computed property names in destructuring can bypass static analysis by constructing
 * dangerous property names at runtime through string concatenation or other expressions.
 *
 * **Attack Vector Blocked:**
 * ```javascript
 * // Attacker constructs 'constructor' at runtime to bypass static analysis
 * const {['const'+'ructor']:Func} = callTool;
 * const evil = Func('return process')();  // Sandbox escape!
 *
 * // Or using variables
 * const prop = 'constructor';
 * const {[prop]:Func} = someFunction;
 * ```
 *
 * **Why This Is Dangerous:**
 * 1. Static analysis cannot determine the property name at compile time
 * 2. Attackers can split dangerous identifiers like 'constructor', 'prototype', '__proto__'
 * 3. This allows extraction of Function constructor from any function object
 * 4. Function constructor enables arbitrary code execution: `new Function('return process')()`
 *
 * **Valid Alternatives:**
 * ```javascript
 * // Use static property names instead
 * const { name, value } = obj;
 * const { data: result } = await callTool('getData', {});
 * ```
 *
 * @example
 * ```typescript
 * const rule = new NoComputedDestructuringRule();
 * validator.addRule(rule);
 * ```
 */
export class NoComputedDestructuringRule implements ValidationRule {
  readonly name = 'no-computed-destructuring';
  readonly description =
    'Blocks computed property names in destructuring patterns to prevent runtime property name attacks';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly customMessage?: string;

  constructor(options: NoComputedDestructuringOptions = {}) {
    this.customMessage = options.message;
  }

  validate(context: ValidationContext): void {
    const { ast, report } = context;

    // Walk the AST looking for ObjectPatterns (destructuring patterns)
    walk.simple(ast, {
      ObjectPattern: (node: any) => {
        if (!node.properties) return;

        for (const prop of node.properties) {
          if (prop.type !== 'Property') continue;

          // Computed key: { [expr]: binding } — the name is unknowable at analysis time.
          if (prop.computed === true) {
            const keyDescription = this.describeKey(prop.key);

            report({
              code: 'NO_COMPUTED_DESTRUCTURING',
              message:
                this.customMessage ||
                `Computed property names in destructuring are not allowed: { [${keyDescription}]: ... }. ` +
                  `This pattern can be used to bypass security checks by constructing dangerous property names at runtime. ` +
                  `Use static property names instead.`,
              location: this.keyLocation(prop, node),
              data: {
                keyType: prop.key?.type,
                keyDescription,
              },
            });
            continue;
          }

          // Static key: { "constructor": binding } / { constructor: binding }. These are not
          // computed, so the guard above never fired — block dangerous names explicitly.
          const staticName = this.staticKeyName(prop.key);
          if (staticName !== undefined && DANGEROUS_DESTRUCTURING_KEYS.has(staticName)) {
            report({
              code: 'NO_DANGEROUS_DESTRUCTURING',
              message:
                `Destructuring the '${staticName}' property is not allowed: { ${this.describeKey(prop.key)}: ... }. ` +
                `This property's prototype chain can reach the Function constructor for sandbox escape. ` +
                `Remove the '${staticName}' binding.`,
              location: this.keyLocation(prop, node),
              data: {
                keyType: prop.key?.type,
                key: staticName,
              },
            });
          }
        }
      },

      // Also check ArrayPattern with computed elements (less common but possible)
      // Note: Array destructuring doesn't have computed keys in the same way,
      // but we should also check for any patterns that might be exploited
    });
  }

  /**
   * Resolve the name of a NON-computed destructuring key (Identifier or Literal), or undefined
   * when it has no statically-known string name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn doesn't export specific node types
  private staticKeyName(key: any): string | undefined {
    if (!key) return undefined;
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : String(key.value);
    return undefined;
  }

  /**
   * Build the issue location from the offending key, falling back to the pattern node.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn doesn't export specific node types
  private keyLocation(prop: any, node: any) {
    if (prop.key?.loc) {
      return {
        line: prop.key.loc.start.line,
        column: prop.key.loc.start.column,
        endLine: prop.key.loc.end.line,
        endColumn: prop.key.loc.end.column,
      };
    }
    if (node.loc) {
      return { line: node.loc.start.line, column: node.loc.start.column };
    }
    return undefined;
  }

  /**
   * Generate a human-readable description of the computed key
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn doesn't export specific node types
  private describeKey(key: any): string {
    if (!key) return '(unknown)';

    switch (key.type) {
      case 'Literal':
        return typeof key.value === 'string' ? `'${key.value}'` : String(key.value);

      case 'Identifier':
        return key.name;

      case 'BinaryExpression':
        if (key.operator === '+') {
          const left = this.describeKey(key.left);
          const right = this.describeKey(key.right);
          return `${left} + ${right}`;
        }
        return `(binary expression)`;

      case 'TemplateLiteral':
        return '`template`';

      case 'CallExpression':
        return '(function call)';

      case 'MemberExpression':
        return '(property access)';

      default:
        return `(${key.type})`;
    }
  }
}
