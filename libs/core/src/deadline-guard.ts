/**
 * Deadline Guard Transform (cooperative timeout)
 *
 * `vm`'s `timeout` only bounds the synchronous run of the script evaluation that it was passed to.
 * A script is an async function: everything after its first `await` runs as a promise job on the
 * host's event loop, outside that watchdog. The enclave's own timer cannot stop it either, because a
 * timer only fires between jobs, and a script that never yields never lets one fire. So
 * `await 0; <busy work>` used to run for as long as it liked, on the host's only thread.
 *
 * This transform makes the script check the clock itself. It inserts a call to `__ag_tick()`:
 * - at the start of every function body (arrow functions with an expression body get a block body),
 *   which bounds recursion and every callback a built-in drives (`map`, `sort`, a Proxy trap, a
 *   `toString` called by a coercion, ...);
 * - in front of what a parameter evaluates before the body starts (a default value, a computed
 *   key of a destructuring pattern);
 * - at the start of every loop body.
 *
 * `__ag_tick` is the sandbox realm's `__safe_tick`, captured once at program scope. The adapter
 * defines it; it samples the realm's clock and throws once the execution's deadline has passed, and
 * from then on throws on every call, so a script that catches the error still cannot run another
 * loop iteration or enter another function. An adapter that does not define `__safe_tick` gets a
 * no-op, so the transformed code runs unchanged there.
 *
 * Applied AFTER validation, like the computed-key guard, so the static rules see the script as
 * written and never the injected helper. The `__ag_` prefix is reserved: a script cannot declare,
 * shadow or assign `__ag_tick`.
 *
 * What this does not bound: a single built-in call that does all its work natively (the memory
 * limits bound those), and a script run with `transform: false`.
 *
 * @packageDocumentation
 */

import * as walk from 'acorn-walk';
import type * as acorn from 'acorn';

/** Name of the injected local that holds the realm's tick function. */
export const TICK_FN = '__ag_tick';

/** Name of the tick function an adapter defines in the sandbox realm. */
export const REALM_TICK_FN = '__safe_tick';

/**
 * How many ticks pass between two readings of the clock. A reading costs far more than the counter
 * increment, and a tick is at most one loop iteration or function entry apart from the next.
 */
export const TICKS_PER_CLOCK_CHECK = 256;

/**
 * How many more checks pass once an execution has ended, before every further check throws.
 * Enough for what a script left behind to settle; a chain that re-arms itself is over within
 * microseconds.
 */
export const TICKS_AFTER_END = 1024;

/** What a deadline check throws once the execution it belongs to has ended. */
export const EXECUTION_ENDED_MESSAGE = 'Script execution has ended';

/** Result of the deadline-guard transform. */
export interface DeadlineGuardResult {
  /** Number of function and loop bodies that received a deadline check. */
  guardedCount: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- acorn does not export per-node types */

function tickStatement(): any {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: TICK_FN },
      arguments: [],
      optional: false,
    },
  };
}

/** Insert the check into a block, after any directive prologue (`'use strict'`). */
function prependToBlock(block: any): void {
  let index = 0;
  while (index < block.body.length && typeof block.body[index].directive === 'string') {
    index++;
  }
  block.body.splice(index, 0, tickStatement());
}

/** `expression` preceded by the check: `(__ag_tick(), expression)`. */
function tickBefore(expression: any): any {
  return {
    type: 'SequenceExpression',
    expressions: [tickStatement().expression, expression],
  };
}

/**
 * Put the check in front of everything a parameter evaluates before the function body starts:
 * a default value (`(a = expr) => ...`, also inside a destructuring pattern) and a computed key
 * of a pattern. Without it the body's own check comes too late for that code.
 */
function guardParameter(pattern: any): void {
  if (!pattern || typeof pattern !== 'object') return;
  switch (pattern.type) {
    case 'AssignmentPattern':
      pattern.right = tickBefore(pattern.right);
      guardParameter(pattern.left);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties ?? []) {
        if (property.type === 'RestElement') {
          guardParameter(property.argument);
        } else {
          if (property.computed) {
            property.key = tickBefore(property.key);
          }
          guardParameter(property.value);
        }
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements ?? []) guardParameter(element);
      break;
    case 'RestElement':
      guardParameter(pattern.argument);
      break;
    default:
      break;
  }
}

function guardFunction(node: any): boolean {
  if (!node.body) return false;
  for (const parameter of node.params ?? []) guardParameter(parameter);
  if (node.body.type === 'BlockStatement') {
    prependToBlock(node.body);
    return true;
  }
  // Arrow function with an expression body: `x => expr` becomes `x => { __ag_tick(); return expr; }`.
  node.body = {
    type: 'BlockStatement',
    body: [tickStatement(), { type: 'ReturnStatement', argument: node.body }],
  };
  node.expression = false;
  return true;
}

function guardLoop(node: any): boolean {
  if (!node.body) return false;
  if (node.body.type === 'BlockStatement') {
    node.body.body.unshift(tickStatement());
  } else {
    node.body = { type: 'BlockStatement', body: [tickStatement(), node.body] };
  }
  return true;
}

/**
 * Source of the statement that captures the realm's tick function. `typeof` on an undeclared global
 * does not throw, so this also runs where no adapter defined it.
 */
function helperSource(): string {
  return `const ${TICK_FN} = (typeof ${REALM_TICK_FN} === 'function') ? ${REALM_TICK_FN} : () => {};`;
}

/**
 * Insert a deadline check at the start of every function and loop body, and the helper it calls at
 * the top of the program.
 *
 * Mutates the AST in place. Must be given a Program node.
 *
 * @param ast Program AST to transform
 * @param parse Acorn parse function, used to build the injected helper statement
 * @returns Number of bodies guarded
 */
export function injectDeadlineChecks(ast: acorn.Node, parse: (source: string) => acorn.Node): DeadlineGuardResult {
  const program = ast as unknown as { type?: string; body?: unknown[] };
  if (program.type !== 'Program' || !Array.isArray(program.body)) {
    throw new Error('injectDeadlineChecks requires a Program AST node to inject its runtime helper');
  }

  let guardedCount = 0;
  const count = (guarded: boolean): void => {
    if (guarded) guardedCount++;
  };

  walk.simple(ast, {
    ArrowFunctionExpression: (node: any) => count(guardFunction(node)),
    FunctionExpression: (node: any) => count(guardFunction(node)),
    FunctionDeclaration: (node: any) => count(guardFunction(node)),
    ForStatement: (node: any) => count(guardLoop(node)),
    ForInStatement: (node: any) => count(guardLoop(node)),
    ForOfStatement: (node: any) => count(guardLoop(node)),
    WhileStatement: (node: any) => count(guardLoop(node)),
    DoWhileStatement: (node: any) => count(guardLoop(node)),
  });

  if (guardedCount > 0) {
    const helper = parse(helperSource()) as unknown as { body: unknown[] };
    program.body.unshift(...helper.body);
  }

  return { guardedCount };
}

/**
 * Source of an expression that, evaluated in a sandbox realm BEFORE any script code, defines the
 * realm's `__safe_tick` for an execution that may run for `timeoutMs`.
 *
 * It captures the realm's own `Date.now` (so nothing the script does to `Date` afterwards matters)
 * and installs `__safe_tick` as a read-only global. What it throws is a string: an inert value in a
 * script's `catch`, and the adapters already report a thrown string as the error message.
 *
 * The expression's value is a function of that realm, for the adapter alone: called when the
 * execution has ended (its script has settled, either way), it lets `TICKS_AFTER_END` more
 * checks pass and makes every check after those throw, so that what the script left behind
 * settles if it is about to and is stopped if it keeps going, instead of running until the
 * deadline.
 */
export function realmTickSource(timeoutMs: number): string {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
  return `
(function (timeoutMs) {
  'use strict';
  var now = Date.now;
  // No positive timeout means no deadline.
  var deadline = timeoutMs > 0 ? now() + timeoutMs : Infinity;
  var expired = false;
  var count = 0;
  // Set when the execution has ended; what the script left behind then gets graceLeft more
  // checks to settle in.
  var ended = false;
  var graceLeft = ${TICKS_AFTER_END};
  var message = 'Script execution timed out after ' + timeoutMs + 'ms';
  Object.defineProperty(globalThis, ${JSON.stringify(REALM_TICK_FN)}, {
    value: function () {
      if (!expired) {
        if (ended) {
          if (graceLeft-- > 0) return;
        } else {
          count++;
          if (count % ${TICKS_PER_CLOCK_CHECK} !== 0 || now() < deadline) return;
        }
        expired = true;
      }
      throw message;
    },
    writable: false,
    configurable: false,
    enumerable: false
  });
  return function () {
    if (!expired && !ended) {
      ended = true;
      message = ${JSON.stringify(EXECUTION_ENDED_MESSAGE)};
    }
  };
})(${timeout})
`.trim();
}
