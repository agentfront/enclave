/**
 * Shared utilities for detecting JavaScript coercion patterns in AST nodes.
 *
 * These detect cases where array/object literals used as computed property keys
 * would coerce to known strings at runtime (e.g. `obj[['constructor']]` or
 * `obj[{toString: () => 'constructor'}]`).
 */

/**
 * Extract a string literal from a ReturnStatement inside a BlockStatement.
 * Returns `null` if the body doesn't contain exactly one ReturnStatement
 * returning a string literal.
 */
export function extractReturnLiteralString(block: any): string | null {
  if (!block || block.type !== 'BlockStatement') return null;
  const body = block.body;
  if (!Array.isArray(body)) return null;

  for (const stmt of body) {
    if (stmt.type === 'ReturnStatement' && stmt.argument) {
      if (stmt.argument.type === 'Literal' && typeof stmt.argument.value === 'string') {
        return stmt.argument.value;
      }
      return null;
    }
  }
  return null;
}

/**
 * Try to statically determine the coerced string value of an ObjectExpression
 * that defines a `toString` or `valueOf` method returning a string literal.
 *
 * Covers:
 * - `{ toString: () => 'x' }`            (ArrowFunctionExpression, expression body)
 * - `{ toString: () => { return 'x' } }` (ArrowFunctionExpression, block body)
 * - `{ toString() { return 'x' } }`      (method shorthand / FunctionExpression)
 * - `{ toString: function() { return 'x' } }` (FunctionExpression)
 * - Same patterns with `valueOf`
 *
 * Returns the resolved string or `null` if it cannot be determined.
 */
export function tryGetObjectCoercedString(node: any): string | null {
  if (node.type !== 'ObjectExpression') return null;
  if (!node.properties || node.properties.length === 0) return null;

  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue;

    // Get the property key name
    let keyName: string | null = null;
    if (prop.key.type === 'Identifier') {
      keyName = prop.key.name;
    } else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') {
      keyName = prop.key.value;
    }

    if (keyName !== 'toString' && keyName !== 'valueOf') continue;

    const value = prop.value;
    if (!value) continue;

    // ArrowFunctionExpression with expression body: () => 'x'
    if (value.type === 'ArrowFunctionExpression') {
      if (value.expression && value.body) {
        // expression body — the body IS the expression
        if (value.body.type === 'Literal' && typeof value.body.value === 'string') {
          return value.body.value;
        }
      } else if (value.body && value.body.type === 'BlockStatement') {
        // block body — look for return statement
        const result = extractReturnLiteralString(value.body);
        if (result !== null) return result;
      }
    }

    // FunctionExpression or method shorthand: function() { return 'x' }
    if (value.type === 'FunctionExpression') {
      if (value.body && value.body.type === 'BlockStatement') {
        const result = extractReturnLiteralString(value.body);
        if (result !== null) return result;
      }
    }

    // Getter: { get toString() { return () => 'x' } }
    // The getter returns a function; JS calls the getter then calls the returned function.
    if (prop.kind === 'get' && value.type === 'FunctionExpression') {
      if (value.body && value.body.type === 'BlockStatement') {
        for (const stmt of value.body.body) {
          if (stmt.type === 'ReturnStatement' && stmt.argument) {
            const ret = stmt.argument;
            // Getter returns an arrow: get toString() { return () => 'x' }
            if (ret.type === 'ArrowFunctionExpression') {
              if (ret.expression && ret.body?.type === 'Literal' && typeof ret.body.value === 'string') {
                return ret.body.value;
              }
              if (ret.body?.type === 'BlockStatement') {
                const inner = extractReturnLiteralString(ret.body);
                if (inner !== null) return inner;
              }
            }
            // Getter returns a function expression: get toString() { return function() { return 'x' } }
            if (ret.type === 'FunctionExpression') {
              if (ret.body?.type === 'BlockStatement') {
                const inner = extractReturnLiteralString(ret.body);
                if (inner !== null) return inner;
              }
            }
            break;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Recursively check if an ArrayExpression would coerce to a disallowed string.
 * e.g. `[['__proto__']]` coerces to `'__proto__'` at runtime.
 *
 * Also recurses into ObjectExpression elements inside arrays:
 * e.g. `[{toString: () => 'constructor'}]` coerces to `'constructor'`.
 */
export function tryGetArrayCoercedString(node: any): string | null {
  if (node.type !== 'ArrayExpression') return null;
  if (!node.elements || node.elements.length !== 1) return null;
  const element = node.elements[0];
  if (!element) return null;

  if (element.type === 'Literal' && typeof element.value === 'string') {
    return element.value;
  }
  if (element.type === 'ArrayExpression') {
    return tryGetArrayCoercedString(element);
  }
  if (element.type === 'ObjectExpression') {
    return tryGetObjectCoercedString(element);
  }
  return null;
}

/**
 * Collect all statically-resolvable string values from a computed property key.
 *
 * For branching expressions (Conditional, Logical), ALL branches are collected
 * so the caller can check each against the disallowed set.
 *
 * Returns an array of resolved strings (may be empty).
 */
function collectStaticKeys(node: any, out: string[]): void {
  if (!node) return;

  // String literal: obj['constructor']
  if (node.type === 'Literal' && typeof node.value === 'string') {
    out.push(node.value);
    return;
  }

  // Template literal with no expressions: obj[`constructor`]
  if (node.type === 'TemplateLiteral') {
    if (!node.expressions || node.expressions.length === 0) {
      if (node.quasis && node.quasis.length === 1) {
        const val = node.quasis[0].value?.cooked ?? node.quasis[0].value?.raw;
        if (val != null) out.push(val);
      }
    }
    return;
  }

  // Conditional: obj[true ? 'constructor' : 'x'] — collect BOTH branches
  if (node.type === 'ConditionalExpression') {
    collectStaticKeys(node.consequent, out);
    collectStaticKeys(node.alternate, out);
    return;
  }

  // Sequence: obj[(0, 'constructor')] — JS evaluates to last expression
  if (node.type === 'SequenceExpression') {
    if (node.expressions && node.expressions.length > 0) {
      collectStaticKeys(node.expressions[node.expressions.length - 1], out);
    }
    return;
  }

  // Assignment: obj[x = 'constructor'] — evaluates to the RHS
  if (node.type === 'AssignmentExpression') {
    collectStaticKeys(node.right, out);
    return;
  }

  // Logical: obj['' || 'constructor'] — collect BOTH operands
  if (node.type === 'LogicalExpression') {
    collectStaticKeys(node.left, out);
    collectStaticKeys(node.right, out);
    return;
  }

  // Array coercion: obj[['constructor']]
  if (node.type === 'ArrayExpression') {
    const val = tryGetArrayCoercedString(node);
    if (val !== null) out.push(val);
    return;
  }

  // Object coercion: obj[{toString: () => 'constructor'}]
  if (node.type === 'ObjectExpression') {
    const val = tryGetObjectCoercedString(node);
    if (val !== null) out.push(val);
    return;
  }
}

/**
 * Try to statically resolve a computed property key expression to possible strings.
 *
 * This is the unified entry point for all computed-key coercion detection.
 * Handles:
 * - `Literal` (string) — `obj['constructor']`
 * - `TemplateLiteral` (no expressions) — `` obj[`constructor`] ``
 * - `ConditionalExpression` — `obj[true ? 'constructor' : 'x']`
 * - `SequenceExpression` — `obj[(0, 'constructor')]`
 * - `AssignmentExpression` — `obj[x = 'constructor']`
 * - `LogicalExpression` — `obj['' || 'constructor']`
 * - `ArrayExpression` — `obj[['constructor']]`
 * - `ObjectExpression` — `obj[{toString: () => 'constructor'}]`
 *
 * Returns an array of all possible resolved strings. For branching expressions
 * (Conditional, Logical), both branches are returned so the caller can check
 * each against the disallowed set.
 */
export function tryGetStaticComputedKeys(node: any): string[] {
  const results: string[] = [];
  collectStaticKeys(node, results);
  return results;
}
