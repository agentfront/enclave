/**
 * Exhaustive AST traversal.
 *
 * `acorn-walk`'s `simple`/`ancestor` walkers dispatch on a per-type table and, for nodes in a
 * "pattern" position (assignment targets, declaration ids, parameters, catch bindings), call the
 * `VariablePattern` visitor instead of `Identifier`. A security rule written as an `Identifier`
 * visitor therefore never sees `x` in `x = 1` or `[x] = y`, and a rule that lists the node types it
 * knows about silently accepts every type it does not list.
 *
 * `walkAll` visits EVERY node reachable through any property of any node, with its ancestors, so a
 * rule built on it cannot miss a position or a node type.
 *
 * @packageDocumentation
 */

/** Any ESTree node. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn does not export per-node types
export type AnyNode = any;

/** Keys that never hold child nodes. */
const NON_CHILD_KEYS = new Set(['type', 'loc', 'range', 'start', 'end', 'raw']);

/** Whether `value` is an AST node (an object carrying a string `type`). */
export function isAstNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Called for each node, before its children.
 *
 * @param node The node being visited
 * @param ancestors Path from the root to the node's parent (root first, parent last)
 * @param key The property of the parent that holds the node (`''` for the root)
 */
export type WalkVisitor = (node: AnyNode, ancestors: readonly AnyNode[], key: string) => void;

/**
 * Visit every node under `root`, depth first, parents before children.
 */
export function walkAll(root: unknown, visit: WalkVisitor): void {
  if (!isAstNode(root)) return;
  const ancestors: AnyNode[] = [];

  const descend = (node: AnyNode, key: string): void => {
    visit(node, ancestors, key);
    ancestors.push(node);
    for (const childKey of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(childKey)) continue;
      const child = node[childKey];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isAstNode(item)) descend(item, childKey);
        }
      } else if (isAstNode(child)) {
        descend(child, childKey);
      }
    }
    ancestors.pop();
  };

  descend(root, '');
}

/**
 * The static name of a property key, or `undefined` when it cannot be known without running code.
 *
 * @param key The key node (`MemberExpression.property`, `Property.key`, ...)
 * @param computed Whether the key is written in brackets
 */
export function staticPropertyName(key: AnyNode | null | undefined, computed: boolean): string | undefined {
  if (!key) return undefined;
  if (!computed) {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return String(key.value);
    return undefined;
  }
  if (key.type === 'Literal') {
    return typeof key.value === 'string' || typeof key.value === 'number' ? String(key.value) : undefined;
  }
  if (key.type === 'TemplateLiteral' && key.expressions?.length === 0 && key.quasis?.length === 1) {
    const cooked = key.quasis[0].value?.cooked ?? key.quasis[0].value?.raw;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}
