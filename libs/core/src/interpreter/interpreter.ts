// file: libs/core/src/interpreter/interpreter.ts
//
// A small, dependency-free, runtime-agnostic tree-walking interpreter for
// AgentScript — Enclave's INDEPENDENT sandbox (no QuickJS, no WASM, no node:vm,
// no vm2). The interpreter IS the security boundary: untrusted code can only do
// what is implemented here. It never calls host `eval`/`Function`, never exposes
// host globals, and blocks the prototype-escape keys (`__proto__`, `constructor`,
// `prototype`). A step budget interrupts runaway/infinite loops (the thing a
// same-isolate `new Function` cannot do).
//
// Input is the ESTree AST produced by `acorn` (the same parser the AST guard
// uses) for already-transformed AgentScript: an `async function __ag_main()`
// wrapper whose body calls `await __safe_callTool(name, args)`.
//
// The values a script works with are ordinary objects of the HOST realm: there
// is no second realm to hide behind. What keeps a script inside the sandbox is
// therefore decided here, operation by operation:
//
// - a property is only ever read or written by a STRING key that is not one of
//   the blocked keys, so no symbol and no prototype link is reachable;
// - only data the script owns (plain objects and arrays that are not frozen) can
//   be changed; functions, the globals and everything else are read-only;
// - `new` and `instanceof` work for the constructors the host registered and for
//   nothing else;
// - whatever a script catches is its own thrown value or a plain copy of an
//   error, never a host Error object (which carries a host stack);
// - every promise an interpreted function returns has a rejection handler, so a
//   call nobody awaits cannot become an unhandled rejection of the host process;
// - every loop the interpreter runs on a script's behalf counts against the
//   step budget, and what evaluation allocates is charged to the host's budget.

import type * as ESTree from 'estree';

/**
 * Keys that must never be readable/writable — they bridge to host intrinsics.
 * Beyond the obvious prototype-escape trio, the four legacy
 * `Object.prototype` accessor methods are blocked: `o.__lookupGetter__('__proto__')`
 * returns the real `__proto__` getter, and `.call(o)` then hands back the HOST
 * `Object.prototype` (and likewise `Array`/`Function` prototypes) — a
 * prototype-pollution + intrinsic-mutation escape that the string-key blocks
 * above do NOT catch (the dangerous string is the method's argument, not the
 * accessed key). AgentScript never legitimately needs these.
 */
const BLOCKED_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** Whether a property key is one a script may never use. */
export function isBlockedKey(key: string): boolean {
  return BLOCKED_KEYS.has(key);
}

/**
 * Max length any single string-amplifying native op (`repeat`/`padStart`/
 * `padEnd`) may PRODUCE. These allocate in one step, so they're invisible to the
 * instruction budget — without this cap a script can OOM the V8 isolate well
 * within `maxSteps` (e.g. `'x'.repeat(5e8)`, or a short loop of `.repeat(5e7)`).
 * 1 MB is far above any legitimate AgentScript need.
 */
const MAX_STRING_OP_LENGTH = 1_000_000;

/** Longest string `Array.prototype.join` may produce in one call (the budget still applies to it). */
const MAX_JOIN_LENGTH = 16_000_000;

/**
 * Longest array a script may make in one step: by assigning an index or `length`, or by
 * spreading. An array of a billion holes costs nothing to make and a lot to `join`.
 */
export const MAX_ARRAY_LENGTH = 1_000_000;

/** Array methods that take a callback the interpreter must `await`. */
const HIGHER_ORDER_ARRAY_METHODS = new Set([
  'map',
  'flatMap',
  'filter',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'reduce',
  'reduceRight',
  'sort',
  'toSorted',
]);

/** Thrown when the instruction budget is exceeded (interrupts infinite loops). */
export class StepLimitError extends Error {
  constructor(limit: number) {
    super(`Execution step limit exceeded (${limit})`);
    this.name = 'StepLimitError';
  }
}

/** Thrown on any disallowed operation (blocked key, unknown identifier, bad call). */
export class InterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterError';
  }
}

// Internal non-error control-flow signals (return / break / continue / `?.`).
class ReturnSignal {
  constructor(readonly value: unknown) {}
}
class BreakSignal {}
class ContinueSignal {}
/** An optional chain met `null` or `undefined`: the whole chain is `undefined`. */
class ChainShortCircuit {}

function isControlSignal(value: unknown): boolean {
  return (
    value instanceof ReturnSignal ||
    value instanceof BreakSignal ||
    value instanceof ContinueSignal ||
    value instanceof ChainShortCircuit
  );
}

// ── Errors as a script sees them ─────────────────────────────────────────────

const SCRIPT_ERRORS = new WeakSet<object>();

/**
 * An error as script code holds it: a frozen object without a prototype that has a `name`, a
 * `message`, a `code` when there is one, and a `toString`. It is what `new Error()` makes in a
 * script and what a `catch` clause receives in place of a host Error object, whose `stack`
 * names host files.
 */
export function createScriptError(name: string, message: string, code?: string): object {
  const error = Object.create(null) as Record<string, unknown>;
  error['name'] = name;
  error['message'] = message;
  if (code !== undefined) error['code'] = code;
  Object.defineProperty(error, 'toString', {
    value: function toString(): string {
      return message ? `${name}: ${message}` : name;
    },
    enumerable: false,
  });
  SCRIPT_ERRORS.add(error);
  return Object.freeze(error);
}

/** Whether a value is an error object made by {@link createScriptError}. */
export function isScriptError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && SCRIPT_ERRORS.has(value);
}

/** A lexical scope with a parent chain and per-binding const protection. */
class Scope {
  private readonly vars = new Map<string, { value: unknown; mutable: boolean }>();
  constructor(private readonly parent?: Scope) {}

  child(): Scope {
    return new Scope(this);
  }

  declare(name: string, value: unknown, mutable: boolean): void {
    this.vars.set(name, { value, mutable });
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name: string): unknown {
    const slot = this.vars.get(name);
    if (slot) return slot.value;
    if (this.parent) return this.parent.get(name);
    throw new InterpreterError(`'${name}' is not defined`);
  }

  set(name: string, value: unknown): void {
    const slot = this.vars.get(name);
    if (slot) {
      if (!slot.mutable) throw new InterpreterError(`Assignment to constant '${name}'`);
      slot.value = value;
      return;
    }
    if (this.parent) {
      this.parent.set(name, value);
      return;
    }
    throw new InterpreterError(`'${name}' is not defined`);
  }
}

export interface InterpreterOptions {
  /** Identifiers + values available to the script (e.g. Math, JSON, __safe_callTool). */
  globals: Record<string, unknown>;
  /** Max evaluated nodes before aborting (interrupts infinite loops). */
  maxSteps: number;
  /** Max nested call depth (interpreter-defined functions). */
  maxCallDepth: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
  /**
   * What `new` may be applied to: for each such global, the function that builds the value from
   * the arguments. `new` on anything else is refused.
   */
  constructors?: ReadonlyMap<unknown, (args: unknown[]) => unknown>;
  /** What may stand on the right of `instanceof`, with the test it performs. */
  instanceChecks?: ReadonlyMap<unknown, (value: unknown) => boolean>;
  /**
   * Called with an estimate, in bytes, of what an evaluation step allocated (a string, an array,
   * an object literal). Throws when the host's budget is used up; that error ends the run and
   * cannot be caught by the script.
   */
  charge?: (bytes: number) => void;
}

/** What a member expression resolves to. */
interface MemberTarget {
  object: unknown;
  key: string;
}

/** Something that can be read and assigned: a variable or a member. */
interface Reference {
  get(): unknown;
  set(value: unknown): void;
}

type PatternMode = 'const' | 'let' | 'assign';

type FunctionNode = ESTree.FunctionDeclaration | ESTree.ArrowFunctionExpression | ESTree.FunctionExpression;

function ignoreRejection(): void {
  // Deliberately empty: see makeFunction
}

/**
 * Evaluate a parsed AgentScript program. Returns the resolved value of the
 * `__ag_main()` invocation (or the program's last value if no main wrapper).
 */
export class Interpreter {
  private steps = 0;
  private callDepth = 0;
  private readonly globals: Record<string, unknown>;
  /** The error that ended the run (step budget, abort, allocation budget); set once, never caught */
  private fatal: unknown;
  private readonly interpretedFunctions = new WeakSet<object>();
  private readonly errorCopies = new WeakMap<object, object>();

  constructor(private readonly options: InterpreterOptions) {
    this.globals = options.globals;
  }

  /** Number of AST nodes evaluated so far (for execution stats). */
  get stepCount(): number {
    return this.steps;
  }

  async run(program: ESTree.Program): Promise<unknown> {
    const root = new Scope();
    // Hoist function + var/const declarations so `__ag_main` is callable.
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        root.declare(stmt.id.name, this.makeFunction(stmt, root), false);
      }
    }
    let last: unknown;
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration') continue; // already hoisted
      // Script-mode (no ES modules) → body items are statements/directives.
      last = await this.execStatement(stmt as ESTree.Statement, root);
    }
    // The transform wraps user code in `async function __ag_main()`. Invoke it.
    if (root.has('__ag_main')) {
      const main = root.get('__ag_main');
      if (typeof main === 'function') return (main as (...a: unknown[]) => unknown)();
    }
    return last;
  }

  /**
   * End the run from outside: whatever of the script is still going (a function a built-in
   * started and nobody awaited, a callback waiting for a tool call) stops at its next step. The
   * host calls this when the execution has returned, so that no script code runs after it.
   */
  stop(): void {
    if (this.fatal === undefined) this.fatal = new InterpreterError('Execution ended');
  }

  /** End the run with an error no `catch` of the script can stop. */
  private end(error: unknown): never {
    if (this.fatal === undefined) this.fatal = error;
    throw this.fatal;
  }

  private tick(): void {
    if (this.fatal !== undefined) throw this.fatal;
    if (this.options.signal?.aborted) this.end(new InterpreterError('Execution aborted'));
    if (++this.steps > this.options.maxSteps) this.end(new StepLimitError(this.options.maxSteps));
  }

  /** Charge an allocation to the host's budget. */
  private charge(bytes: number): void {
    const charge = this.options.charge;
    if (!charge || bytes <= 0) return;
    try {
      charge(bytes);
    } catch (error) {
      this.end(error);
    }
  }

  /** Charge what a host function returned, when that is a string or an array. */
  private chargeValue(value: unknown): void {
    if (typeof value === 'string') this.charge(value.length * 2);
    else if (Array.isArray(value)) this.charge(value.length * 8);
  }

  // ── Statements ─────────────────────────────────────────────────────────────
  private async execStatement(node: ESTree.Statement, scope: Scope): Promise<unknown> {
    this.tick();
    switch (node.type) {
      case 'VariableDeclaration': {
        const mode: PatternMode = node.kind === 'const' ? 'const' : 'let';
        for (const d of node.declarations) {
          const value = d.init ? await this.evalExpr(d.init, scope) : undefined;
          await this.applyPattern(d.id, value, scope, mode);
        }
        return undefined;
      }
      case 'FunctionDeclaration':
        if (node.id) scope.declare(node.id.name, this.makeFunction(node, scope), false);
        return undefined;
      case 'ExpressionStatement':
        return this.evalExpr(node.expression, scope);
      case 'BlockStatement':
        return this.execBlock(node.body, scope.child());
      case 'IfStatement':
        if (truthy(await this.evalExpr(node.test, scope))) return this.execStatement(node.consequent, scope);
        if (node.alternate) return this.execStatement(node.alternate, scope);
        return undefined;
      case 'ForOfStatement':
        return this.execForOf(node, scope);
      case 'ForInStatement':
        return this.execForIn(node, scope);
      case 'ForStatement':
        return this.execFor(node, scope);
      case 'WhileStatement':
        return this.execWhile(node, scope);
      case 'DoWhileStatement':
        return this.execDoWhile(node, scope);
      case 'SwitchStatement':
        return this.execSwitch(node, scope);
      case 'TryStatement':
        return this.execTry(node, scope);
      case 'ThrowStatement':
        // The value itself is thrown: what a script throws, a script (or the caller) catches.
        throw await this.evalExpr(node.argument, scope);
      case 'ReturnStatement':
        throw new ReturnSignal(node.argument ? await this.evalExpr(node.argument, scope) : undefined);
      case 'BreakStatement':
        if (node.label) throw new InterpreterError('Labeled break is not supported');
        throw new BreakSignal();
      case 'ContinueStatement':
        if (node.label) throw new InterpreterError('Labeled continue is not supported');
        throw new ContinueSignal();
      case 'EmptyStatement':
        return undefined;
      default:
        throw new InterpreterError(`Unsupported statement: ${node.type}`);
    }
  }

  private async execBlock(body: ESTree.Statement[], scope: Scope): Promise<unknown> {
    // Hoist nested function declarations within the block.
    for (const stmt of body) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        scope.declare(stmt.id.name, this.makeFunction(stmt, scope), false);
      }
    }
    for (const stmt of body) {
      if (stmt.type === 'FunctionDeclaration') continue;
      await this.execStatement(stmt, scope);
    }
    return undefined;
  }

  /** Bind the variable of a `for…of` / `for…in` head to the value of one iteration. */
  private async bindLoopVariable(
    left: ESTree.VariableDeclaration | ESTree.Pattern,
    value: unknown,
    scope: Scope,
  ): Promise<void> {
    if (left.type === 'VariableDeclaration') {
      await this.applyPattern(left.declarations[0].id, value, scope, left.kind === 'const' ? 'const' : 'let');
    } else {
      await this.applyPattern(left, value, scope, 'assign');
    }
  }

  /** Run one iteration of a loop body. @returns false when the loop is to stop */
  private async runLoopBody(body: ESTree.Statement, scope: Scope): Promise<boolean> {
    try {
      await this.execStatement(body, scope);
    } catch (e) {
      if (e instanceof BreakSignal) return false;
      if (!(e instanceof ContinueSignal)) throw e;
    }
    return true;
  }

  private async execForOf(node: ESTree.ForOfStatement, scope: Scope): Promise<void> {
    if (node.await) throw new InterpreterError('for await is not supported');
    const iterable = await this.evalExpr(node.right, scope);
    if (!isIterable(iterable)) throw new InterpreterError('for-of target is not iterable');
    for (const item of iterable as Iterable<unknown>) {
      this.tick();
      const inner = scope.child();
      await this.bindLoopVariable(node.left, item, inner);
      if (!(await this.runLoopBody(node.body, inner))) break;
    }
  }

  private async execForIn(node: ESTree.ForInStatement, scope: Scope): Promise<void> {
    const object = await this.evalExpr(node.right, scope);
    if (object === null || object === undefined) return;
    // Own enumerable string keys: a plain object or an array has no enumerable inherited ones.
    for (const key of Object.keys(object as object)) {
      this.tick();
      if (BLOCKED_KEYS.has(key)) continue;
      const inner = scope.child();
      await this.bindLoopVariable(node.left, key, inner);
      if (!(await this.runLoopBody(node.body, inner))) break;
    }
  }

  private async execFor(node: ESTree.ForStatement, scope: Scope): Promise<void> {
    const inner = scope.child();
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') await this.execStatement(node.init, inner);
      else await this.evalExpr(node.init, inner);
    }
    while (node.test ? truthy(await this.evalExpr(node.test, inner)) : true) {
      this.tick();
      if (!(await this.runLoopBody(node.body, inner.child()))) break;
      if (node.update) await this.evalExpr(node.update, inner);
    }
  }

  private async execWhile(node: ESTree.WhileStatement, scope: Scope): Promise<void> {
    while (truthy(await this.evalExpr(node.test, scope))) {
      this.tick();
      if (!(await this.runLoopBody(node.body, scope.child()))) break;
    }
  }

  private async execDoWhile(node: ESTree.DoWhileStatement, scope: Scope): Promise<void> {
    do {
      this.tick();
      if (!(await this.runLoopBody(node.body, scope.child()))) break;
    } while (truthy(await this.evalExpr(node.test, scope)));
  }

  private async execSwitch(node: ESTree.SwitchStatement, scope: Scope): Promise<void> {
    const value = await this.evalExpr(node.discriminant, scope);
    const inner = scope.child();
    let start = -1;
    for (let i = 0; i < node.cases.length && start === -1; i++) {
      const test = node.cases[i].test;
      if (test && (await this.evalExpr(test, inner)) === value) start = i;
    }
    if (start === -1) start = node.cases.findIndex((clause) => !clause.test);
    if (start === -1) return;
    try {
      // From the matching clause on, clauses run into each other until a `break`.
      for (let i = start; i < node.cases.length; i++) {
        for (const stmt of node.cases[i].consequent) await this.execStatement(stmt, inner);
      }
    } catch (e) {
      if (!(e instanceof BreakSignal)) throw e;
    }
  }

  private async execTry(node: ESTree.TryStatement, scope: Scope): Promise<void> {
    try {
      await this.execBlock(node.block.body, scope.child());
    } catch (thrown) {
      // `return`, `break` and `continue` pass through, and so does whatever ended the run: a
      // script cannot catch its way past the step budget, an abort or the allocation budget.
      if (!node.handler || isControlSignal(thrown) || this.fatal !== undefined) throw thrown;
      const inner = scope.child();
      if (node.handler.param) await this.applyPattern(node.handler.param, this.toScriptValue(thrown), inner, 'let');
      await this.execBlock(node.handler.body.body, inner);
    } finally {
      // Nothing of the script runs once the run has been ended.
      if (node.finalizer && this.fatal === undefined) await this.execBlock(node.finalizer.body, scope.child());
    }
  }

  /**
   * What a `catch` clause receives. A value the script threw is its own. A host Error (a refusal
   * by the interpreter, a failed tool call, a TypeError of a built-in) is replaced by a plain
   * copy with its name, message and code.
   */
  private toScriptValue(thrown: unknown): unknown {
    if (!(thrown instanceof Error)) return thrown;
    const known = this.errorCopies.get(thrown);
    if (known) return known;
    const code = (thrown as { code?: unknown }).code;
    const copy = createScriptError(
      typeof thrown.name === 'string' ? thrown.name : 'Error',
      typeof thrown.message === 'string' ? thrown.message : '',
      typeof code === 'string' ? code : undefined,
    );
    this.errorCopies.set(thrown, copy);
    return copy;
  }

  // ── Expressions ──────────────────────────────────────────────────────────--
  private async evalExpr(
    node: ESTree.Expression | ESTree.Pattern | ESTree.PrivateIdentifier,
    scope: Scope,
  ): Promise<unknown> {
    this.tick();
    switch (node.type) {
      case 'Literal':
        // A regular expression literal would evaluate to a host RegExp (the parser builds one).
        // Matching runs natively: neither the step budget nor the adapter's timeout, which is a
        // timer and needs the event loop, can interrupt a pattern that backtracks.
        if ((node as ESTree.RegExpLiteral).regex) {
          throw new InterpreterError('Regular expressions are not supported');
        }
        return node.value;
      case 'Identifier':
        return scope.has(node.name) ? scope.get(node.name) : this.readGlobal(node.name);
      case 'TemplateLiteral':
        return this.evalTemplate(node, scope);
      case 'ArrayExpression': {
        const arr: unknown[] = [];
        for (const el of node.elements) {
          if (el == null) {
            arr.push(undefined);
          } else if (el.type === 'SpreadElement') {
            this.spreadInto(arr, await this.evalExpr(el.argument, scope));
          } else {
            arr.push(await this.evalExpr(el, scope));
          }
        }
        this.charge(arr.length * 8);
        return arr;
      }
      case 'ObjectExpression': {
        const obj: Record<string, unknown> = {};
        let count = 0;
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            const spread = await this.evalExpr(prop.argument, scope);
            if (spread && typeof spread === 'object') {
              for (const [k, v] of Object.entries(spread as Record<string, unknown>)) {
                this.tick();
                if (!BLOCKED_KEYS.has(k)) {
                  obj[k] = v;
                  count++;
                }
              }
            }
            continue;
          }
          if (prop.kind !== 'init') throw new InterpreterError('Getters and setters are not supported');
          const key = await this.propKey(prop, scope);
          if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property key: ${key}`);
          obj[key] = await this.evalExpr(prop.value as ESTree.Expression, scope);
          count++;
        }
        this.charge(count * 16);
        return obj;
      }
      case 'UnaryExpression':
        return this.evalUnary(node, scope);
      case 'UpdateExpression': {
        const ref = await this.resolveReference(node.argument, scope);
        const before = Number(ref.get());
        const after = node.operator === '++' ? before + 1 : before - 1;
        ref.set(after);
        return node.prefix ? after : before;
      }
      case 'BinaryExpression':
        return this.evalBinary(node, scope);
      case 'LogicalExpression': {
        const left = await this.evalExpr(node.left, scope);
        if (node.operator === '&&') return truthy(left) ? this.evalExpr(node.right, scope) : left;
        if (node.operator === '||') return truthy(left) ? left : this.evalExpr(node.right, scope);
        return left ?? (await this.evalExpr(node.right, scope)); // ??
      }
      case 'ConditionalExpression':
        return truthy(await this.evalExpr(node.test, scope))
          ? this.evalExpr(node.consequent, scope)
          : this.evalExpr(node.alternate, scope);
      case 'SequenceExpression': {
        let last: unknown;
        for (const expression of node.expressions) last = await this.evalExpr(expression, scope);
        return last;
      }
      case 'ChainExpression':
        try {
          return await this.evalExpr(node.expression, scope);
        } catch (e) {
          if (e instanceof ChainShortCircuit) return undefined;
          throw e;
        }
      case 'MemberExpression': {
        const { object, key } = await this.evalMemberTarget(node, scope);
        return (object as Record<string, unknown>)[key];
      }
      case 'CallExpression':
        return this.evalCall(node, scope);
      case 'NewExpression':
        return this.evalNew(node, scope);
      case 'AwaitExpression':
        return await this.evalExpr(node.argument, scope);
      case 'AssignmentExpression':
        return this.evalAssignment(node, scope);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return this.makeFunction(node, scope);
      default:
        throw new InterpreterError(`Unsupported expression: ${node.type}`);
    }
  }

  private async evalTemplate(node: ESTree.TemplateLiteral, scope: Scope): Promise<string> {
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked ?? '';
      if (i < node.expressions.length) out += String(await this.evalExpr(node.expressions[i], scope));
    }
    this.charge(out.length * 2);
    return out;
  }

  private async evalUnary(node: ESTree.UnaryExpression, scope: Scope): Promise<unknown> {
    // `typeof name` is 'undefined' for a name that is not defined, never an error (ECMAScript).
    // The helpers the enclave injects after validation (the computed-key guard, the deadline
    // guard) probe optional runtime globals this way, and this runtime provides neither.
    if (
      node.operator === 'typeof' &&
      node.argument.type === 'Identifier' &&
      !scope.has(node.argument.name) &&
      !Object.prototype.hasOwnProperty.call(this.globals, node.argument.name)
    ) {
      return 'undefined';
    }
    if (node.operator === 'delete') {
      if (node.argument.type !== 'MemberExpression') throw new InterpreterError('Only a property can be deleted');
      const { object, key } = await this.evalMemberTarget(node.argument, scope);
      this.assertChangeable(object);
      return delete (object as Record<string, unknown>)[key];
    }
    const v = await this.evalExpr(node.argument, scope);
    switch (node.operator) {
      case '!':
        return !truthy(v);
      case '-':
        return -(v as number);
      case '+':
        return +(v as number);
      case 'typeof':
        return typeof v;
      case '~':
        return ~(v as number);
      case 'void':
        return undefined;
      default:
        throw new InterpreterError(`Unsupported unary operator: ${node.operator}`);
    }
  }

  private async evalBinary(node: ESTree.BinaryExpression, scope: Scope): Promise<unknown> {
    if (node.left.type === 'PrivateIdentifier') throw new InterpreterError('Private names are not supported');
    const l = await this.evalExpr(node.left, scope);
    const r = await this.evalExpr(node.right, scope);
    if (node.operator === 'in') {
      if (r === null || (typeof r !== 'object' && typeof r !== 'function')) {
        throw new InterpreterError("Cannot use 'in' on a value that is not an object");
      }
      const key = String(l);
      if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
      return key in (r as object);
    }
    if (node.operator === 'instanceof') {
      const check = this.options.instanceChecks?.get(r);
      if (!check) throw new InterpreterError('instanceof works with the built-in types the sandbox provides only');
      return check(l);
    }
    return this.binary(node.operator, l, r);
  }

  /** Apply a binary operator to two values. */
  private binary(operator: string, left: unknown, right: unknown): unknown {
    const l = left as never;
    const r = right as never;
    switch (operator) {
      case '+': {
        const sum: unknown = (l as number) + (r as number);
        // What the engine adds to an existing string is the new part (it keeps the old one and
        // links to it), so a loop that appends to one string is charged its length once.
        if (typeof sum === 'string') this.charge((sum.length - (typeof left === 'string' ? left.length : 0)) * 2);
        return sum;
      }
      case '-':
        return (l as number) - (r as number);
      case '*':
        return (l as number) * (r as number);
      case '/':
        return (l as number) / (r as number);
      case '%':
        return (l as number) % (r as number);
      case '**':
        return (l as number) ** (r as number);
      case '==':
        return l == r;
      case '!=':
        return l != r;
      case '===':
        return l === r;
      case '!==':
        return l !== r;
      case '<':
        return l < r;
      case '<=':
        return l <= r;
      case '>':
        return l > r;
      case '>=':
        return l >= r;
      case '&':
        return (l as number) & (r as number);
      case '|':
        return (l as number) | (r as number);
      case '^':
        return (l as number) ^ (r as number);
      case '<<':
        return (l as number) << (r as number);
      case '>>':
        return (l as number) >> (r as number);
      case '>>>':
        return (l as number) >>> (r as number);
      default:
        throw new InterpreterError(`Unsupported binary operator: ${operator}`);
    }
  }

  /**
   * Resolve a member expression to the object and the key it names, blocking escape keys.
   * Inside an optional chain, a `?.` on `null` or `undefined` ends the chain.
   */
  private async evalMemberTarget(node: ESTree.MemberExpression, scope: Scope): Promise<MemberTarget> {
    if (node.object.type === 'Super') throw new InterpreterError('super is not supported');
    const object = await this.evalExpr(node.object, scope);
    if (node.optional && (object === null || object === undefined)) throw new ChainShortCircuit();
    if (node.property.type === 'PrivateIdentifier') throw new InterpreterError('Private names are not supported');
    const key = node.computed
      ? String(await this.evalExpr(node.property, scope))
      : (node.property as ESTree.Identifier).name;
    if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
    if (object == null) throw new InterpreterError(`Cannot read '${key}' of ${String(object)}`);
    return { object, key };
  }

  /** A variable or a member as something that can be read and assigned. */
  private async resolveReference(node: ESTree.Expression | ESTree.Pattern, scope: Scope): Promise<Reference> {
    if (node.type === 'Identifier') {
      const name = node.name;
      return {
        get: () => scope.get(name),
        set: (value) => scope.set(name, value),
      };
    }
    if (node.type === 'MemberExpression') {
      const { object, key } = await this.evalMemberTarget(node, scope);
      return {
        get: () => (object as Record<string, unknown>)[key],
        set: (value) => this.writeMember(object, key, value),
      };
    }
    throw new InterpreterError(`Unsupported assignment target: ${node.type}`);
  }

  /**
   * Only data a script owns can be changed: arrays and plain objects that are not frozen. The
   * globals, functions (the host's built-ins among them, which the whole process shares), dates
   * and the error copies are not: a property set on one of them would be seen by host code.
   */
  private assertChangeable(object: unknown): void {
    if (!isScriptData(object)) {
      throw new InterpreterError('Only objects and arrays the script created can be changed');
    }
    if (Object.isFrozen(object)) throw new InterpreterError('Cannot change a read-only value');
  }

  private writeMember(object: unknown, key: string, value: unknown): void {
    this.assertChangeable(object);
    if (Array.isArray(object)) {
      const grownTo = arrayLengthAfterWrite(object, key, value);
      if (grownTo > MAX_ARRAY_LENGTH) {
        throw new InterpreterError(`An array cannot be longer than ${MAX_ARRAY_LENGTH} items`);
      }
      if (grownTo > object.length) this.charge((grownTo - object.length) * 8);
    }
    (object as Record<string, unknown>)[key] = value;
  }

  /** Append what an iterable yields to an array, one step and one length check per item. */
  private spreadInto(target: unknown[], iterable: unknown): void {
    if (!isIterable(iterable)) throw new InterpreterError('Spread target is not iterable');
    for (const value of iterable as Iterable<unknown>) {
      this.tick();
      if (target.length >= MAX_ARRAY_LENGTH) {
        throw new InterpreterError(`An array cannot be longer than ${MAX_ARRAY_LENGTH} items`);
      }
      target.push(value);
    }
  }

  private async evalArguments(
    nodes: Array<ESTree.Expression | ESTree.SpreadElement>,
    scope: Scope,
  ): Promise<unknown[]> {
    const args: unknown[] = [];
    for (const a of nodes) {
      if (a.type === 'SpreadElement') this.spreadInto(args, await this.evalExpr(a.argument, scope));
      else args.push(await this.evalExpr(a, scope));
    }
    return args;
  }

  private async evalNew(node: ESTree.NewExpression, scope: Scope): Promise<unknown> {
    if (node.callee.type === 'Super') throw new InterpreterError('super is not supported');
    const callee = await this.evalExpr(node.callee, scope);
    const construct = this.options.constructors?.get(callee);
    if (!construct) throw new InterpreterError('new works with the built-in types the sandbox provides only');
    const value = construct(await this.evalArguments(node.arguments, scope));
    this.chargeValue(value);
    return value;
  }

  private async evalCall(node: ESTree.SimpleCallExpression, scope: Scope): Promise<unknown> {
    let fn: unknown;
    let thisArg: unknown;
    let member: (MemberTarget & { value: unknown }) | undefined;
    if (node.callee.type === 'MemberExpression') {
      const target = await this.evalMemberTarget(node.callee, scope);
      member = { ...target, value: (target.object as Record<string, unknown>)[target.key] };
      fn = member.value;
      thisArg = member.object;
    } else if (node.callee.type === 'Super') {
      throw new InterpreterError('super is not supported');
    } else {
      fn = await this.evalExpr(node.callee, scope);
      thisArg = undefined;
    }
    if ((node as ESTree.SimpleCallExpression).optional && (fn === null || fn === undefined)) {
      throw new ChainShortCircuit();
    }

    const args = await this.evalArguments(node.arguments, scope);

    if (member) {
      if (typeof member.object === 'string') {
        // These build a regular expression from their STRING argument inside the engine: the
        // same uninterruptible matching as a literal, without a literal.
        if (member.key === 'match' || member.key === 'matchAll' || member.key === 'search') {
          throw new InterpreterError(`String '${member.key}' is not supported: it runs a regular expression`);
        }
        // The engine would call the function for every match and use the promise it returns.
        if ((member.key === 'replace' || member.key === 'replaceAll') && typeof args[1] === 'function') {
          throw new InterpreterError(`String '${member.key}' does not take a function in the sandbox`);
        }
        // Every occurrence can be replaced by the whole replacement: the product bounds the result.
        if (
          (member.key === 'replace' || member.key === 'replaceAll') &&
          typeof args[1] === 'string' &&
          member.object.length * args[1].length > MAX_STRING_OP_LENGTH
        ) {
          throw new InterpreterError(
            `String '${member.key}' could produce more than ${MAX_STRING_OP_LENGTH} chars with this replacement`,
          );
        }
        // Cap string-amplifying ops whose allocation the step budget can't see.
        if (member.key === 'repeat' || member.key === 'padStart' || member.key === 'padEnd') {
          const n = Number(args[0]);
          const produced =
            member.key === 'repeat'
              ? member.object.length * (n > 0 ? n : 0)
              : Math.max(member.object.length, n > 0 ? n : 0);
          if (produced > MAX_STRING_OP_LENGTH) {
            throw new InterpreterError(
              `String '${member.key}' would produce ${produced} chars, exceeding the ${MAX_STRING_OP_LENGTH} limit`,
            );
          }
        }
      }
      // `join` writes every item and a separator between them into one string, in one step.
      if (Array.isArray(member.object) && member.key === 'join') {
        const separator = args.length === 0 || args[0] === undefined ? ',' : String(args[0]);
        let produced = separator.length * Math.max(0, member.object.length - 1);
        for (let i = 0; i < member.object.length && produced <= MAX_JOIN_LENGTH; i++) {
          const item: unknown = member.object[i];
          if (typeof item === 'string') produced += item.length;
        }
        if (produced > MAX_JOIN_LENGTH) {
          throw new InterpreterError(`Array 'join' would produce more than ${MAX_JOIN_LENGTH} chars`);
        }
      }
      // Higher-order array methods must AWAIT the (async) interpreter callbacks —
      // native Array.map/filter/sort don't await, so run our own implementations.
      if (Array.isArray(member.object) && HIGHER_ORDER_ARRAY_METHODS.has(member.key) && typeof args[0] === 'function') {
        return this.callArrayMethod(member.object as unknown[], member.key, args);
      }
    }
    if (typeof fn !== 'function') throw new InterpreterError('Attempted to call a non-function');

    // `call`, `apply` and `bind` choose the receiver of a function. Generic built-ins write to
    // their receiver (`[].push.call(target, value)` sets `target[n]`), and the built-in functions
    // are objects the whole host process shares: a function is never accepted as that receiver.
    if (
      member &&
      typeof member.object === 'function' &&
      (member.key === 'call' || member.key === 'apply' || member.key === 'bind') &&
      typeof args[0] === 'function'
    ) {
      throw new InterpreterError(`'${member.key}' cannot make a function the receiver of a call`);
    }

    if (++this.callDepth > this.options.maxCallDepth) {
      this.callDepth--;
      throw new InterpreterError(`Max call depth exceeded (${this.options.maxCallDepth})`);
    }
    try {
      const result = await (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
      // What an interpreted function returns was charged when it was made.
      if (!this.interpretedFunctions.has(fn)) this.chargeValue(result);
      return result;
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Async implementations of the higher-order array methods, so interpreter
   * callbacks (which are async — they may `await` tool calls) are awaited. Each
   * iteration ticks the step budget.
   */
  private async callArrayMethod(arr: unknown[], method: string, args: unknown[]): Promise<unknown> {
    const cb = args[0] as (value: unknown, index: number, array: unknown[]) => Promise<unknown>;
    const each = (i: number): Promise<unknown> => {
      this.tick();
      return cb(arr[i], i, arr);
    };
    switch (method) {
      case 'map': {
        const out: unknown[] = [];
        for (let i = 0; i < arr.length; i++) out.push(await each(i));
        this.charge(out.length * 8);
        return out;
      }
      case 'flatMap': {
        const out: unknown[] = [];
        for (let i = 0; i < arr.length; i++) {
          const v = await each(i);
          if (Array.isArray(v)) this.spreadInto(out, v);
          else out.push(v);
        }
        this.charge(out.length * 8);
        return out;
      }
      case 'filter': {
        const out: unknown[] = [];
        for (let i = 0; i < arr.length; i++) if (truthy(await each(i))) out.push(arr[i]);
        this.charge(out.length * 8);
        return out;
      }
      case 'forEach':
        for (let i = 0; i < arr.length; i++) await each(i);
        return undefined;
      case 'some':
        for (let i = 0; i < arr.length; i++) if (truthy(await each(i))) return true;
        return false;
      case 'every':
        for (let i = 0; i < arr.length; i++) if (!truthy(await each(i))) return false;
        return true;
      case 'find':
        for (let i = 0; i < arr.length; i++) if (truthy(await each(i))) return arr[i];
        return undefined;
      case 'findIndex':
        for (let i = 0; i < arr.length; i++) if (truthy(await each(i))) return i;
        return -1;
      case 'findLast':
        for (let i = arr.length - 1; i >= 0; i--) if (truthy(await each(i))) return arr[i];
        return undefined;
      case 'findLastIndex':
        for (let i = arr.length - 1; i >= 0; i--) if (truthy(await each(i))) return i;
        return -1;
      case 'reduce':
      case 'reduceRight': {
        const reducer = cb as unknown as (acc: unknown, v: unknown, i: number, a: unknown[]) => Promise<unknown>;
        const fromRight = method === 'reduceRight';
        const order = arr.map((_, i) => (fromRight ? arr.length - 1 - i : i));
        let acc: unknown;
        let start = 0;
        if (args.length > 1) acc = args[1];
        else {
          if (arr.length === 0) throw new InterpreterError('Reduce of empty array with no initial value');
          acc = arr[order[0]];
          start = 1;
        }
        for (let n = start; n < order.length; n++) {
          this.tick();
          acc = await reducer(acc, arr[order[n]], order[n], arr);
        }
        return acc;
      }
      case 'sort':
      case 'toSorted': {
        // Async-comparator insertion sort (agent arrays are small). `sort` mutates and returns
        // the array, matching Array.prototype.sort; `toSorted` sorts a copy.
        const target = method === 'sort' ? arr : [...arr];
        if (method === 'sort') this.assertChangeable(arr);
        else this.charge(target.length * 8);
        const cmp = cb as unknown as (a: unknown, b: unknown) => Promise<number>;
        for (let i = 1; i < target.length; i++) {
          let j = i;
          while (j > 0) {
            this.tick();
            if ((await cmp(target[j - 1], target[j])) <= 0) break;
            [target[j - 1], target[j]] = [target[j], target[j - 1]];
            j--;
          }
        }
        return target;
      }
      default:
        throw new InterpreterError(`Unsupported array method: ${method}`);
    }
  }

  private async evalAssignment(node: ESTree.AssignmentExpression, scope: Scope): Promise<unknown> {
    if (node.operator === '=') {
      if (node.left.type === 'MemberExpression') {
        // The target is worked out before the value, as in ECMAScript.
        const { object, key } = await this.evalMemberTarget(node.left, scope);
        const assigned = await this.evalExpr(node.right, scope);
        this.writeMember(object, key, assigned);
        return assigned;
      }
      const value = await this.evalExpr(node.right, scope);
      await this.applyPattern(node.left, value, scope, 'assign');
      return value;
    }

    const ref = await this.resolveReference(node.left, scope);
    const current = ref.get();
    // `a ||= b`, `a &&= b`, `a ??= b`: the right side is only evaluated when it is assigned.
    if (node.operator === '||=' || node.operator === '&&=' || node.operator === '??=') {
      const assign =
        node.operator === '||='
          ? !truthy(current)
          : node.operator === '&&='
            ? truthy(current)
            : current === null || current === undefined;
      if (!assign) return current;
      const value = await this.evalExpr(node.right, scope);
      ref.set(value);
      return value;
    }
    // Compound assignment: x += y, etc.
    const next = this.binary(node.operator.slice(0, -1), current, await this.evalExpr(node.right, scope));
    ref.set(next);
    return next;
  }

  /**
   * Give the names in a pattern their values: a declaration (`const` / `let`), a parameter list
   * or an assignment (`[a, o.b] = …`). Defaults and rest elements are handled here.
   */
  private async applyPattern(pattern: ESTree.Pattern, value: unknown, scope: Scope, mode: PatternMode): Promise<void> {
    switch (pattern.type) {
      case 'Identifier':
        if (mode === 'assign') scope.set(pattern.name, value);
        else scope.declare(pattern.name, value, mode === 'let');
        return;
      case 'MemberExpression': {
        if (mode !== 'assign') throw new InterpreterError('Unsupported binding pattern: MemberExpression');
        const { object, key } = await this.evalMemberTarget(pattern, scope);
        this.writeMember(object, key, value);
        return;
      }
      case 'AssignmentPattern':
        await this.applyPattern(
          pattern.left,
          value === undefined ? await this.evalExpr(pattern.right, scope) : value,
          scope,
          mode,
        );
        return;
      case 'ArrayPattern': {
        const items: unknown[] = [];
        this.spreadInto(items, value);
        for (let i = 0; i < pattern.elements.length; i++) {
          const element = pattern.elements[i];
          if (!element) continue;
          if (element.type === 'RestElement') {
            await this.applyPattern(element.argument, items.slice(i), scope, mode);
            break;
          }
          await this.applyPattern(element, items[i], scope, mode);
        }
        return;
      }
      case 'ObjectPattern': {
        if (value === null || value === undefined) {
          throw new InterpreterError(`Cannot destructure ${String(value)}`);
        }
        const source = value as Record<string, unknown>;
        const taken = new Set<string>();
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            const rest: Record<string, unknown> = {};
            for (const key of Object.keys(source)) {
              this.tick();
              if (!taken.has(key) && !BLOCKED_KEYS.has(key)) rest[key] = source[key];
            }
            await this.applyPattern(prop.argument, rest, scope, mode);
            continue;
          }
          // Resolve the key for BOTH identifier (`{ constructor: x }`) and string/number literal
          // (`{ "constructor": x }`) forms. Reading only `prop.key.name` left literal keys as
          // `undefined`, so a blocked key smuggled as a string literal escaped this check (GHSA-3279).
          if (prop.computed) throw new InterpreterError('Computed destructuring keys are not allowed');
          let key: string;
          if (prop.key.type === 'Identifier') key = prop.key.name;
          else if (prop.key.type === 'Literal') key = String(prop.key.value);
          else throw new InterpreterError('Unsupported destructuring key');
          if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden destructured key: ${key}`);
          taken.add(key);
          await this.applyPattern(prop.value, source[key], scope, mode);
        }
        return;
      }
      default:
        throw new InterpreterError(`Unsupported binding pattern: ${pattern.type}`);
    }
  }

  /** Build an interpreter-backed function (declaration / arrow / expression). */
  private makeFunction(node: FunctionNode, closure: Scope): (...args: unknown[]) => Promise<unknown> {
    if (node.generator) throw new InterpreterError('Generator functions are not supported');
    // A named function expression can call itself by its name, which only its own body sees.
    const selfName = node.type === 'FunctionExpression' && node.id ? node.id.name : undefined;
    const outer = selfName === undefined ? closure : closure.child();
    const call = async (args: unknown[]): Promise<unknown> => {
      const fnScope = outer.child();
      for (let i = 0; i < node.params.length; i++) {
        const param = node.params[i];
        if (param.type === 'RestElement') {
          await this.applyPattern(param.argument, args.slice(i), fnScope, 'let');
          break;
        }
        await this.applyPattern(param, args[i], fnScope, 'let');
      }
      try {
        if (node.body.type === 'BlockStatement') {
          await this.execBlock(node.body.body, fnScope);
          return undefined;
        }
        return await this.evalExpr(node.body, fnScope); // arrow shorthand
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      }
    };
    const interpreted = function interpreted(...args: unknown[]): Promise<unknown> {
      const result = call(args);
      // Whoever awaits this promise still sees a rejection. This handler only keeps a call that
      // nobody awaits (a callback a host built-in invoked and dropped) from becoming an unhandled
      // rejection, which by default ends the host process.
      result.then(undefined, ignoreRejection);
      return result;
    };
    this.interpretedFunctions.add(interpreted);
    if (selfName !== undefined) outer.declare(selfName, interpreted, false);
    return interpreted;
  }

  private async propKey(prop: ESTree.Property, scope: Scope): Promise<string> {
    if (prop.computed) return String(await this.evalExpr(prop.key as ESTree.Expression, scope));
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    throw new InterpreterError('Unsupported property key');
  }

  private readGlobal(name: string): unknown {
    if (Object.prototype.hasOwnProperty.call(this.globals, name)) return this.globals[name];
    throw new InterpreterError(`'${name}' is not defined`);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────--
function truthy(v: unknown): boolean {
  return Boolean(v);
}
function isIterable(v: unknown): boolean {
  return v != null && typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/**
 * Whether a value is data a script may change: an array, or an object whose prototype is
 * `Object.prototype` or nothing. That is what literals, `JSON.parse` and tool results are made of.
 */
export function isScriptData(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The length an array has after `array[key] = value`. */
function arrayLengthAfterWrite(array: unknown[], key: string, value: unknown): number {
  if (key === 'length') {
    const length = Number(value);
    if (!Number.isInteger(length) || length < 0) throw new InterpreterError('Invalid array length');
    return length;
  }
  const index = Number(key);
  // An index is a canonical non-negative integer; any other key is a plain property.
  if (Number.isInteger(index) && index >= 0 && String(index) === key) return Math.max(array.length, index + 1);
  return array.length;
}
