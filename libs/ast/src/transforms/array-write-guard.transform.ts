/**
 * Array Write Guard Transform
 *
 * A write through a member can give an array any length: an element far beyond its end, an
 * assignment to `length`. The slots in between hold nothing, but every built-in that works
 * through an array works through them, and one call into a built-in is not interrupted. So
 * the runtime that accounts for arrays (`@enclave-vm/core`) refuses a write that would give an
 * array more slots than its memory limit holds, and for that it has to see the write.
 *
 * This transform hands it every write whose effect on an array cannot be told from the text:
 * a member with a computed key, and the member `length`.
 *
 * - `X[K] = V` and `X.length = V` become `__safe_set(X, K, V)`: one call, with the operands
 *   evaluated in the order the assignment evaluates them, whose value is `V`. (In the output
 *   the two functions are called by names of the program, `__ag_arraySet` and
 *   `__ag_arraySlot`, which one statement at its top binds to them.)
 * - Every other write (a compound or logical assignment, `++` and `--`, a target inside a
 *   destructuring pattern, the target in the head of a `for…in` / `for…of`) keeps its form, and
 *   its target `X[K]` becomes `__safe_slot(X, K).v`: an object whose member `v` reads and
 *   writes that slot. The operator, the pattern or the loop then works as the language defines
 *   it, with the guarded write underneath.
 *
 * Not rewritten: a computed key that is a small non-negative integer literal or a string
 * literal that is neither `length` nor an array index (neither can take an array past a
 * limit), `super[K]`, and a private name.
 *
 * Apply it AFTER the computed-key guard (`guardComputedMemberKeys`): that guard looks for
 * computed members, and a write this transform has rewritten is a call.
 *
 * @packageDocumentation
 */

import * as walk from 'acorn-walk';
import type * as acorn from 'acorn';

/** Name of the runtime function `X[K] = V` is rewritten to. Reserved prefix: a script cannot name it. */
export const ARRAY_WRITE_SET_FN = '__safe_set';

/** Name of the runtime function whose result stands in for the target of every other write. */
export const ARRAY_WRITE_SLOT_FN = '__safe_slot';

/**
 * The names the rewritten writes call. They are bound once, at the top of the program, to the
 * two runtime functions: a name of the program is found at once, a name of the sandbox's global
 * object is looked up on every call.
 */
const LOCAL_SET_FN = '__ag_arraySet';
const LOCAL_SLOT_FN = '__ag_arraySlot';

/** The member of that result that reads and writes the slot. */
const SLOT_MEMBER = 'v';

/** An integer literal below this is written as it is: no limit an enclave can have is below it. */
const SMALL_INDEX = 64;

export interface ArrayWriteGuardResult {
  /** Number of writes that were rewritten */
  guardedCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** The key of a member as an expression, or undefined when a write to it needs no guard. */
function guardedKey(member: Node): Node | undefined {
  if (member.type !== 'MemberExpression' || member.optional === true) return undefined;
  if (member.object?.type === 'Super') return undefined;
  const property = member.property;
  if (!property || property.type === 'PrivateIdentifier') return undefined;

  if (member.computed !== true) {
    // `X.length`: the one name that sets the size of an array
    return property.type === 'Identifier' && property.name === 'length'
      ? { type: 'Literal', value: 'length', raw: "'length'" }
      : undefined;
  }

  if (property.type === 'Literal') {
    const value: unknown = property.value;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SMALL_INDEX) {
      return undefined;
    }
    if (typeof value === 'string' && value !== 'length' && !/^(0|[1-9][0-9]*)$/.test(value)) {
      return undefined;
    }
  }
  return property;
}

function call(name: string, args: Node[]): Node {
  return { type: 'CallExpression', callee: { type: 'Identifier', name }, arguments: args, optional: false };
}

/** Turn a member that is a write target into `__safe_slot(X, K).v`, in place. */
function toSlot(member: Node): boolean {
  const key = guardedKey(member);
  if (key === undefined) return false;
  member.object = call(LOCAL_SLOT_FN, [member.object, key]);
  member.property = { type: 'Identifier', name: SLOT_MEMBER };
  member.computed = false;
  member.optional = false;
  return true;
}

/** Guard every member that is a target inside a destructuring pattern. */
function guardPattern(pattern: Node): number {
  if (!pattern) return 0;
  switch (pattern.type) {
    case 'MemberExpression':
      return toSlot(pattern) ? 1 : 0;
    case 'ArrayPattern': {
      let count = 0;
      for (const element of pattern.elements ?? []) count += guardPattern(element);
      return count;
    }
    case 'ObjectPattern': {
      let count = 0;
      for (const property of pattern.properties ?? []) {
        count += guardPattern(property.type === 'RestElement' ? property.argument : property.value);
      }
      return count;
    }
    case 'RestElement':
      return guardPattern(pattern.argument);
    case 'AssignmentPattern':
      return guardPattern(pattern.left);
    default:
      return 0;
  }
}

/**
 * Rewrite the writes of a program that can change the size of an array (see the module text).
 *
 * @param ast The program, changed in place
 */
export function guardArrayWrites(ast: acorn.Node): ArrayWriteGuardResult {
  let guardedCount = 0;

  // Post-order: the writes inside an operand are rewritten before the write they are part of
  walk.simple(
    ast as unknown as acorn.Node,
    {
      AssignmentExpression(node: Node) {
        const left = node.left;
        if (left.type !== 'MemberExpression') {
          guardedCount += guardPattern(left);
          return;
        }
        if (node.operator !== '=') {
          if (toSlot(left)) guardedCount++;
          return;
        }
        const key = guardedKey(left);
        if (key === undefined) return;
        const args = [left.object, key, node.right];
        node.type = 'CallExpression';
        node.callee = { type: 'Identifier', name: LOCAL_SET_FN };
        node.arguments = args;
        node.optional = false;
        delete node.operator;
        delete node.left;
        delete node.right;
        guardedCount++;
      },
      UpdateExpression(node: Node) {
        if (toSlot(node.argument)) guardedCount++;
      },
      ForInStatement(node: Node) {
        guardedCount += guardPattern(node.left);
      },
      ForOfStatement(node: Node) {
        guardedCount += guardPattern(node.left);
      },
    } as walk.SimpleVisitors<unknown>,
  );

  // const __ag_arraySet = __safe_set, __ag_arraySlot = __safe_slot;
  const program = ast as Node;
  if (guardedCount > 0 && program.type === 'Program' && Array.isArray(program.body)) {
    const bind = (local: string, runtime: string): Node => ({
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: local },
      init: { type: 'Identifier', name: runtime },
    });
    program.body.unshift({
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [bind(LOCAL_SET_FN, ARRAY_WRITE_SET_FN), bind(LOCAL_SLOT_FN, ARRAY_WRITE_SLOT_FN)],
    });
  }

  return { guardedCount };
}
