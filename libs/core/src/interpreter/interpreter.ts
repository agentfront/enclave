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

/**
 * Max length any single string-amplifying native op (`repeat`/`padStart`/
 * `padEnd`) may PRODUCE. These allocate in one step, so they're invisible to the
 * instruction budget — without this cap a script can OOM the V8 isolate well
 * within `maxSteps` (e.g. `'x'.repeat(5e8)`, or a short loop of `.repeat(5e7)`).
 * 1 MB is far above any legitimate AgentScript need.
 */
const MAX_STRING_OP_LENGTH = 1_000_000;

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
  'reduce',
  'sort',
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

// Internal non-error control-flow signals (return / break / continue).
class ReturnSignal {
  constructor(readonly value: unknown) {}
}
class BreakSignal {}
class ContinueSignal {}

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
}

/**
 * Evaluate a parsed AgentScript program. Returns the resolved value of the
 * `__ag_main()` invocation (or the program's last value if no main wrapper).
 */
export class Interpreter {
  private steps = 0;
  private callDepth = 0;
  private readonly globals: Record<string, unknown>;

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

  private tick(): void {
    if (this.options.signal?.aborted) throw new InterpreterError('Execution aborted');
    if (++this.steps > this.options.maxSteps) throw new StepLimitError(this.options.maxSteps);
  }

  // ── Statements ─────────────────────────────────────────────────────────────
  private async execStatement(node: ESTree.Statement, scope: Scope): Promise<unknown> {
    this.tick();
    switch (node.type) {
      case 'VariableDeclaration': {
        for (const d of node.declarations) {
          const value = d.init ? await this.evalExpr(d.init, scope) : undefined;
          this.bindPattern(d.id, value, scope, node.kind !== 'const');
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
      case 'ForStatement':
        return this.execFor(node, scope);
      case 'WhileStatement':
        return this.execWhile(node, scope);
      case 'ReturnStatement':
        throw new ReturnSignal(node.argument ? await this.evalExpr(node.argument, scope) : undefined);
      case 'BreakStatement':
        throw new BreakSignal();
      case 'ContinueStatement':
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

  private async execForOf(node: ESTree.ForOfStatement, scope: Scope): Promise<void> {
    const iterable = await this.evalExpr(node.right, scope);
    if (!isIterable(iterable)) throw new InterpreterError('for-of target is not iterable');
    for (const item of iterable as Iterable<unknown>) {
      this.tick();
      const inner = scope.child();
      const decl = node.left;
      if (decl.type === 'VariableDeclaration') {
        this.bindPattern(decl.declarations[0].id, item, inner, decl.kind !== 'const');
      } else {
        this.assignTo(decl as ESTree.Pattern, item, inner);
      }
      try {
        await this.execStatement(node.body, inner);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
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
      try {
        await this.execStatement(node.body, inner.child());
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (!(e instanceof ContinueSignal)) throw e;
      }
      if (node.update) await this.evalExpr(node.update, inner);
    }
  }

  private async execWhile(node: ESTree.WhileStatement, scope: Scope): Promise<void> {
    while (truthy(await this.evalExpr(node.test, scope))) {
      this.tick();
      try {
        await this.execStatement(node.body, scope.child());
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (!(e instanceof ContinueSignal)) throw e;
      }
    }
  }

  // ── Expressions ──────────────────────────────────────────────────────────--
  private async evalExpr(
    node: ESTree.Expression | ESTree.Pattern | ESTree.PrivateIdentifier,
    scope: Scope,
  ): Promise<unknown> {
    this.tick();
    switch (node.type) {
      case 'Literal':
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
            const spread = await this.evalExpr(el.argument, scope);
            if (!isIterable(spread)) throw new InterpreterError('Spread target is not iterable');
            for (const v of spread as Iterable<unknown>) arr.push(v);
          } else {
            arr.push(await this.evalExpr(el, scope));
          }
        }
        return arr;
      }
      case 'ObjectExpression': {
        const obj: Record<string, unknown> = {};
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            const spread = await this.evalExpr(prop.argument, scope);
            if (spread && typeof spread === 'object') {
              for (const [k, v] of Object.entries(spread as Record<string, unknown>)) {
                if (!BLOCKED_KEYS.has(k)) obj[k] = v;
              }
            }
            continue;
          }
          const key = await this.propKey(prop, scope);
          if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property key: ${key}`);
          obj[key] = await this.evalExpr(prop.value as ESTree.Expression, scope);
        }
        return obj;
      }
      case 'UnaryExpression': {
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
          default:
            throw new InterpreterError(`Unsupported unary operator: ${node.operator}`);
        }
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
      case 'MemberExpression':
        return (await this.evalMember(node, scope)).value;
      case 'CallExpression':
        return this.evalCall(node, scope);
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
    return out;
  }

  private async evalBinary(node: ESTree.BinaryExpression, scope: Scope): Promise<unknown> {
    const l = (await this.evalExpr(node.left as ESTree.Expression, scope)) as never;
    const r = (await this.evalExpr(node.right, scope)) as never;
    switch (node.operator) {
      case '+':
        return (l as number) + (r as number);
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
        throw new InterpreterError(`Unsupported binary operator: ${node.operator}`);
    }
  }

  /** Resolve a member access to `{ object, key, value }`, blocking escape keys. */
  private async evalMember(
    node: ESTree.MemberExpression,
    scope: Scope,
  ): Promise<{ object: unknown; key: string; value: unknown }> {
    const object = await this.evalExpr(node.object as ESTree.Expression, scope);
    const key = node.computed
      ? String(await this.evalExpr(node.property as ESTree.Expression, scope))
      : (node.property as ESTree.Identifier).name;
    if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
    if (object == null) throw new InterpreterError(`Cannot read '${key}' of ${String(object)}`);
    const value = (object as Record<string, unknown>)[key];
    return { object, key, value };
  }

  private async evalCall(node: ESTree.CallExpression, scope: Scope): Promise<unknown> {
    const args: unknown[] = [];
    for (const a of node.arguments) {
      if (a.type === 'SpreadElement') {
        const spread = await this.evalExpr(a.argument, scope);
        if (!isIterable(spread)) throw new InterpreterError('Spread target is not iterable');
        for (const v of spread as Iterable<unknown>) args.push(v);
      } else {
        args.push(await this.evalExpr(a as ESTree.Expression, scope));
      }
    }

    let fn: unknown;
    let thisArg: unknown;
    if (node.callee.type === 'MemberExpression') {
      const m = await this.evalMember(node.callee, scope);
      // Higher-order array methods must AWAIT the (async) interpreter callbacks —
      // native Array.map/filter/sort don't await, so run our own implementations.
      if (Array.isArray(m.object) && HIGHER_ORDER_ARRAY_METHODS.has(m.key) && typeof args[0] === 'function') {
        return this.callArrayMethod(m.object as unknown[], m.key, args);
      }
      // Cap string-amplifying ops whose allocation the step budget can't see.
      if (typeof m.object === 'string' && (m.key === 'repeat' || m.key === 'padStart' || m.key === 'padEnd')) {
        const n = Number(args[0]);
        const produced =
          m.key === 'repeat' ? m.object.length * (n > 0 ? n : 0) : Math.max(m.object.length, n > 0 ? n : 0);
        if (produced > MAX_STRING_OP_LENGTH) {
          throw new InterpreterError(
            `String '${m.key}' would produce ${produced} chars, exceeding the ${MAX_STRING_OP_LENGTH} limit`,
          );
        }
      }
      fn = m.value;
      thisArg = m.object;
    } else {
      fn = await this.evalExpr(node.callee as ESTree.Expression, scope);
      thisArg = undefined;
    }
    if (typeof fn !== 'function') throw new InterpreterError('Attempted to call a non-function');

    if (++this.callDepth > this.options.maxCallDepth) {
      this.callDepth--;
      throw new InterpreterError(`Max call depth exceeded (${this.options.maxCallDepth})`);
    }
    try {
      return await (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
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
        return out;
      }
      case 'flatMap': {
        const out: unknown[] = [];
        for (let i = 0; i < arr.length; i++) {
          const v = await each(i);
          if (Array.isArray(v)) out.push(...v);
          else out.push(v);
        }
        return out;
      }
      case 'filter': {
        const out: unknown[] = [];
        for (let i = 0; i < arr.length; i++) if (truthy(await each(i))) out.push(arr[i]);
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
      case 'reduce': {
        const reducer = cb as unknown as (acc: unknown, v: unknown, i: number, a: unknown[]) => Promise<unknown>;
        let acc: unknown;
        let start = 0;
        if (args.length > 1) acc = args[1];
        else {
          if (arr.length === 0) throw new InterpreterError('Reduce of empty array with no initial value');
          acc = arr[0];
          start = 1;
        }
        for (let i = start; i < arr.length; i++) {
          this.tick();
          acc = await reducer(acc, arr[i], i, arr);
        }
        return acc;
      }
      case 'sort': {
        // Async-comparator insertion sort (agent arrays are small); mutates +
        // returns the array, matching Array.prototype.sort semantics.
        const cmp = cb as unknown as (a: unknown, b: unknown) => Promise<number>;
        for (let i = 1; i < arr.length; i++) {
          let j = i;
          while (j > 0) {
            this.tick();
            if ((await cmp(arr[j - 1], arr[j])) <= 0) break;
            [arr[j - 1], arr[j]] = [arr[j], arr[j - 1]];
            j--;
          }
        }
        return arr;
      }
      default:
        throw new InterpreterError(`Unsupported array method: ${method}`);
    }
  }

  private async evalAssignment(node: ESTree.AssignmentExpression, scope: Scope): Promise<unknown> {
    const value = await this.evalExpr(node.right, scope);
    if (node.operator === '=') {
      this.assignTo(node.left, value, scope);
      return value;
    }
    // Compound assignment: x += y, etc. (only on identifiers/members)
    const current = await this.evalExpr(node.left as ESTree.Expression, scope);
    const op = node.operator.slice(0, -1);
    const next = applyBinary(op, current, value);
    this.assignTo(node.left, next, scope);
    return next;
  }

  /** Assign to an Identifier or MemberExpression target (blocking escape keys). */
  private assignTo(target: ESTree.Pattern | ESTree.Expression, value: unknown, scope: Scope): void {
    if (target.type === 'Identifier') {
      scope.set(target.name, value);
      return;
    }
    if (target.type === 'MemberExpression') {
      // Evaluate object + key synchronously is not possible here (async); but
      // member assignment targets are simple — handled via a small sync path.
      throw new InterpreterError('Member assignment is not supported in AgentScript');
    }
    throw new InterpreterError(`Unsupported assignment target: ${target.type}`);
  }

  private bindPattern(pattern: ESTree.Pattern, value: unknown, scope: Scope, mutable: boolean): void {
    if (pattern.type === 'Identifier') {
      scope.declare(pattern.name, value, mutable);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      const arr = (isIterable(value) ? [...(value as Iterable<unknown>)] : []) as unknown[];
      pattern.elements.forEach((el, i) => {
        if (el) this.bindPattern(el, arr[i], scope, mutable);
      });
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      const obj = (value ?? {}) as Record<string, unknown>;
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') continue;
        const key = (prop.key as ESTree.Identifier).name;
        if (BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden destructured key: ${key}`);
        this.bindPattern(prop.value, obj[key], scope, mutable);
      }
      return;
    }
    throw new InterpreterError(`Unsupported binding pattern: ${pattern.type}`);
  }

  /** Build an interpreter-backed function (declaration / arrow / expression). */
  private makeFunction(
    node: ESTree.FunctionDeclaration | ESTree.ArrowFunctionExpression | ESTree.FunctionExpression,
    closure: Scope,
  ): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return async function interpreted(...args: unknown[]): Promise<unknown> {
      const fnScope = closure.child();
      node.params.forEach((p, i) => self.bindPattern(p, args[i], fnScope, true));
      try {
        if (node.body.type === 'BlockStatement') {
          await self.execBlock(node.body.body, fnScope);
          return undefined;
        }
        return await self.evalExpr(node.body, fnScope); // arrow shorthand
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      }
    };
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
function applyBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case '+':
      return (l as number) + (r as number);
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
    default:
      throw new InterpreterError(`Unsupported compound operator: ${op}=`);
  }
}
