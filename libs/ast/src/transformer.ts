import type * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { generate } from 'astring';
import type { TransformConfig } from './interfaces';
import { analyzeScopes } from './utils/scope-analysis';

/**
 * JavaScript keywords that should never be transformed
 * These are reserved words and language constructs
 */
const JS_KEYWORDS = new Set([
  // Reserved keywords
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',

  // Literals
  'null',
  'true',
  'false',
  'undefined',

  // Special identifiers that are not really identifiers
  'arguments',
]);

/**
 * Determine if an identifier should be transformed
 *
 * @param identifierName The identifier name to check
 * @param mode Transformation mode ('blacklist' or 'whitelist')
 * @param targetSet Set of identifiers (blacklist or whitelist depending on mode)
 * @returns true if the identifier should be transformed
 */
function shouldTransformIdentifier(
  identifierName: string,
  mode: 'blacklist' | 'whitelist',
  targetSet: Set<string>,
): boolean {
  // Never transform JavaScript keywords
  if (JS_KEYWORDS.has(identifierName)) {
    return false;
  }

  if (mode === 'blacklist') {
    // Blacklist mode: Transform ONLY if in the list
    return targetSet.has(identifierName);
  } else {
    // Whitelist mode: Transform EVERYTHING except whitelisted identifiers
    return !targetSet.has(identifierName);
  }
}

/**
 * Transform AST by prefixing identifiers based on mode
 *
 * **Blacklist Mode (default):**
 * Transforms only identifiers specified in the list:
 *   console.log('hello');  →  __safe_console.log('hello');
 *   obj['eval']();         →  obj['__safe_eval']();
 *
 * **Whitelist Mode:**
 * Transforms ALL identifiers except those in the whitelist:
 *   const data = users.filter(u => u.active);
 *   →  const __safe_data = __safe_users.filter(__safe_u => __safe_u.active);
 *   (assuming 'users' is whitelisted, but 'data', 'u', 'filter' are not)
 *
 * @param ast The AST to transform (will be mutated in place)
 * @param config Transformation configuration
 */
export function transformAst(ast: acorn.Node, config: TransformConfig): void {
  if (!config.enabled) {
    return;
  }

  const mode = config.mode || 'blacklist';
  const prefix = config.prefix || '__safe_';

  // Build the target set based on mode
  let targetSet: Set<string>;
  if (mode === 'blacklist') {
    targetSet = new Set(config.identifiers || []);
    if (targetSet.size === 0) {
      return; // Nothing to transform in blacklist mode
    }
  } else {
    // Whitelist mode: Build set of identifiers NOT to transform
    targetSet = new Set(config.whitelistedIdentifiers || []);
    // Always add JS keywords to whitelist
    JS_KEYWORDS.forEach((kw) => targetSet.add(kw));
  }

  if (mode === 'whitelist') {
    transformFreeReferences(ast, prefix, targetSet);
    transformComputedMemberKeys(ast, config, mode, prefix, targetSet);
    return;
  }

  // Walk the AST and transform matching identifiers
  // Use walk.ancestor to get parent context
  walk.ancestor(ast, {
    // Transform regular identifiers (e.g., `console` in `console.log()`)
    Identifier: (node: any, ancestors: any[]) => {
      // Skip if this identifier is a property name (not a value)
      // Example: { name: 'value' } - 'name' is a property, shouldn't be transformed
      if (ancestors.length > 1) {
        const parent = ancestors[ancestors.length - 2];

        // Don't transform property names in object literals
        if (parent.type === 'Property' && parent.key === node && !parent.computed) {
          return;
        }

        // Don't transform method names in class/object definitions
        if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) {
          return;
        }

        // Don't transform import/export names
        if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') {
          return;
        }

        // Don't transform function parameter names or variable declarations
        // These are declarations, not references
        if (
          parent.type === 'FunctionDeclaration' ||
          parent.type === 'FunctionExpression' ||
          parent.type === 'ArrowFunctionExpression'
        ) {
          // Check if this is a param name
          if (parent.params && parent.params.includes(node)) {
            return;
          }
        }

        if (parent.type === 'VariableDeclarator' && parent.id === node) {
          return;
        }

        // Don't transform identifiers in destructuring binding positions
        // For { a } or { a: b }, the binding is 'a' (shorthand) or 'b' (with alias)
        if (parent.type === 'Property' && parent.value === node) {
          // Check if this Property is inside an ObjectPattern (destructuring)
          if (ancestors.length > 2) {
            const grandparent = ancestors[ancestors.length - 3];
            if (grandparent.type === 'ObjectPattern') {
              return;
            }
          }
        }

        // Don't transform identifiers directly in ArrayPattern
        if (parent.type === 'ArrayPattern') {
          return;
        }

        // Don't transform RestElement arguments (e.g., ...rest)
        if (parent.type === 'RestElement' && parent.argument === node) {
          return;
        }

        // Don't transform AssignmentPattern left side (default values in destructuring)
        if (parent.type === 'AssignmentPattern' && parent.left === node) {
          return;
        }
      }

      if (shouldTransformIdentifier(node.name, mode, targetSet)) {
        node.name = `${prefix}${node.name}`;
      }
    },
  });

  transformComputedMemberKeys(ast, config, mode, prefix, targetSet);
}

/**
 * WHITELIST MODE: prefix every identifier that reaches a global.
 *
 * Resolution is lexical: a reference is left alone only when a declaration of that name is in
 * scope AT THE REFERENCE. (A flat "declared somewhere" set let `{ let globalThis; } globalThis`
 * keep the outer, global `globalThis` unprefixed.) Assignment targets are references too, so
 * `x = 1`, `[x] = y` and `for (x of y)` are prefixed exactly like a read of `x`.
 */
function transformFreeReferences(ast: acorn.Node, prefix: string, whitelist: Set<string>): void {
  const { freeReferences } = analyzeScopes(ast);
  for (const ref of freeReferences) {
    if (!shouldTransformIdentifier(ref.name, 'whitelist', whitelist)) continue;
    ref.node.name = `${prefix}${ref.name}`;
    // `{ x }` prints only its value; once the value is renamed the key must be written out, or the
    // property itself would be renamed to `{ __safe_x }`.
    if (ref.parent?.type === 'Property' && ref.parent.shorthand && ref.parent.value === ref.node) {
      ref.parent.shorthand = false;
    }
  }
}

/**
 * Transform statically-known computed member keys (e.g. `obj['eval']`) when `transformComputed` is set.
 */
function transformComputedMemberKeys(
  ast: acorn.Node,
  config: TransformConfig,
  mode: 'blacklist' | 'whitelist',
  prefix: string,
  targetSet: Set<string>,
): void {
  if (!config.transformComputed) return;

  walk.simple(ast, {
    MemberExpression: (node: any) => {
      if (node.computed && node.property) {
        // Handle string literals like obj['eval']
        if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
          const propValue = node.property.value;
          if (shouldTransformIdentifier(propValue, mode, targetSet)) {
            const newValue = `${prefix}${propValue}`;
            node.property.value = newValue;
            // Update raw to ensure astring generates correct code
            node.property.raw = `'${newValue}'`;
          }
        }
        // Handle template literals like obj[`eval`]
        else if (node.property.type === 'TemplateLiteral') {
          const templateNode = node.property;
          if (templateNode.quasis && templateNode.quasis.length === 1 && templateNode.expressions.length === 0) {
            const staticValue = templateNode.quasis[0].value.cooked;
            if (staticValue && shouldTransformIdentifier(staticValue, mode, targetSet)) {
              // Replace with prefixed string literal
              node.property = {
                type: 'Literal',
                value: `${prefix}${staticValue}`,
                raw: `'${prefix}${staticValue}'`,
              };
            }
          }
        }
      }
    },
  });
}

/**
 * Generate JavaScript code from an AST
 *
 * @param ast The AST to generate code from
 * @returns Generated JavaScript code
 */
export function generateCode(ast: acorn.Node): string {
  return generate(ast);
}

/**
 * Transform JavaScript code by prefixing identifiers
 *
 * This is a convenience function that combines parsing, transforming, and code generation.
 * For better performance when you already have an AST, use transformAst() directly.
 *
 * @param code JavaScript code to transform
 * @param config Transformation configuration
 * @param ast Optional pre-parsed AST (if not provided, code will be parsed)
 * @returns Transformed JavaScript code
 */
export function transformCode(code: string, config: TransformConfig, ast?: acorn.Node): string {
  if (!config.enabled) {
    return code;
  }

  if (!ast) {
    throw new Error('transformCode requires a pre-parsed AST. Use JSAstValidator.validate() instead.');
  }

  // Transform the AST in place
  transformAst(ast, config);

  // Generate code from transformed AST
  return generateCode(ast);
}
