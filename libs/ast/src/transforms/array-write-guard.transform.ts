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
 * Not rewritten: a computed key that is a small non-negative integer literal (below 64, or
 * below `unguardedBelow` where the caller's limit holds fewer slots than that) or a string
 * literal that is neither `length` nor an array index (neither can take an array past a
 * limit), `super[K]`, and a private name.
 *
 * The statement that binds the two names goes after the directive prologue of the program, so
 * a program that begins with `'use strict'` stays strict.
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

/**
 * An integer literal below this is written as it is, unless the caller's limit holds fewer
 * slots (see ArrayWriteGuardOptions.unguardedBelow).
 */
const SMALL_INDEX = 64;

export interface ArrayWriteGuardOptions {
  /**
   * A write to a literal index below this number is left as it is: the number of slots the
   * caller's array limit holds, when that is below 64. An array written at index `n` has
   * `n + 1` slots, so with a limit of `s` slots the indexes below `s` cannot take an array
   * past it. At most 64, which is also the default; 0 guards every write.
   */
  unguardedBelow?: number;
}

export interface ArrayWriteGuardResult {
  /** Number of writes that were rewritten */
  guardedCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** The key of a member as an expression, or undefined when a write to it needs no guard. */
function guardedKey(member: Node, small: number): Node | undefined {
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
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < small) {
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
function toSlot(member: Node, small: number): boolean {
  const key = guardedKey(member, small);
  if (key === undefined) return false;
  member.object = call(LOCAL_SLOT_FN, [member.object, key]);
  member.property = { type: 'Identifier', name: SLOT_MEMBER };
  member.computed = false;
  member.optional = false;
  return true;
}

/** Guard every member that is a target inside a destructuring pattern. */
function guardPattern(pattern: Node, small: number): number {
  if (!pattern) return 0;
  switch (pattern.type) {
    case 'MemberExpression':
      return toSlot(pattern, small) ? 1 : 0;
    case 'ArrayPattern': {
      let count = 0;
      for (const element of pattern.elements ?? []) count += guardPattern(element, small);
      return count;
    }
    case 'ObjectPattern': {
      let count = 0;
      for (const property of pattern.properties ?? []) {
        count += guardPattern(property.type === 'RestElement' ? property.argument : property.value, small);
      }
      return count;
    }
    case 'RestElement':
      return guardPattern(pattern.argument, small);
    case 'AssignmentPattern':
      return guardPattern(pattern.left, small);
    default:
      return 0;
  }
}

/** The number of literal indexes that are left unguarded, from the caller's option. */
function smallIndexOf(options: ArrayWriteGuardOptions | undefined): number {
  const given = options?.unguardedBelow;
  if (given === undefined) return SMALL_INDEX;
  if (typeof given !== 'number' || !Number.isInteger(given) || given < 0) {
    throw new TypeError(`guardArrayWrites: unguardedBelow must be a non-negative integer, got ${String(given)}`);
  }
  return Math.min(given, SMALL_INDEX);
}

/**
 * Rewrite the writes of a program that can change the size of an array (see the module text).
 *
 * @param ast The program, changed in place
 * @param options Which literal indexes are left as they are
 */
export function guardArrayWrites(ast: acorn.Node, options?: ArrayWriteGuardOptions): ArrayWriteGuardResult {
  const small = smallIndexOf(options);
  let guardedCount = 0;

  // Post-order: the writes inside an operand are rewritten before the write they are part of
  walk.simple(
    ast as unknown as acorn.Node,
    {
      AssignmentExpression(node: Node) {
        const left = node.left;
        if (left.type !== 'MemberExpression') {
          guardedCount += guardPattern(left, small);
          return;
        }
        if (node.operator !== '=') {
          if (toSlot(left, small)) guardedCount++;
          return;
        }
        const key = guardedKey(left, small);
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
        if (toSlot(node.argument, small)) guardedCount++;
      },
      ForInStatement(node: Node) {
        guardedCount += guardPattern(node.left, small);
      },
      ForOfStatement(node: Node) {
        guardedCount += guardPattern(node.left, small);
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
    // After the directive prologue: a statement in front of `'use strict'` would make it an
    // ordinary expression, and the program would no longer be strict
    let at = 0;
    while (
      at < program.body.length &&
      program.body[at]?.type === 'ExpressionStatement' &&
      typeof program.body[at].directive === 'string'
    ) {
      at++;
    }
    program.body.splice(at, 0, {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [bind(LOCAL_SET_FN, ARRAY_WRITE_SET_FN), bind(LOCAL_SLOT_FN, ARRAY_WRITE_SLOT_FN)],
    });
  }

  return { guardedCount };
}
