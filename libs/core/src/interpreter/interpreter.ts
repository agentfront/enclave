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
// - the engine never calls a function for a script: data of a script holds no function under
//   a name the engine looks up by itself (to convert a value, to serialize it, to await it), so
//   whatever runs for a script runs where the script wrote a call, with the checks of a call;
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
  return key === '__proto__' || BLOCKED_KEYS.has(key);
}

/** Refuse a key a script may never use. Called where a property is written or deleted. */
function assertKeyAllowed(key: string): void {
  if (isBlockedKey(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
}

/**
 * Read a property under a key the script chose. The key is checked here, at the read, whatever the
 * caller checked before: `__proto__` of any object, and what the other blocked keys lead to, is a
 * prototype the whole process shares, and a value read here can become the target of a write.
 */
function readProperty(object: unknown, key: string): unknown {
  if (key === '__proto__' || BLOCKED_KEYS.has(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
  return (object as Record<string, unknown>)[key];
}

/**
 * Names under which the engine looks for a function on a value and calls it by itself: to turn
 * the value into a text or a number (`toString`, `valueOf`), into JSON (`toJSON`, and for a date
 * `toISOString`), into the text of a locale (`toLocaleString`, for every item of an array), or
 * to wait for it (`then`, wherever a value passes an `await`).
 */
const ENGINE_CALLED_KEYS = new Set(['then', 'toString', 'valueOf', 'toJSON', 'toLocaleString', 'toISOString']);

/** Whether the engine calls a function it finds under this name, without a call in the script. */
export function isEngineCalledKey(key: string): boolean {
  return ENGINE_CALLED_KEYS.has(key);
}

/**
 * Refuse to store a function where the engine would call it by itself. Such a call is not a
 * call of the script: it gets none of the checks of a call, a function of the script that is
 * called that way is not awaited, and a value with a `then` function is waited for wherever it
 * is evaluated. Data of a script therefore never holds a function under one of those names (an
 * array neither under `join`, which the engine calls for the text of an array). Any other
 * value may be stored there, and the conversions every object inherits keep working.
 *
 * @throws InterpreterError when `value` is a function and `key` is such a name
 */
export function assertStorable(target: unknown, key: string, value: unknown): void {
  if (typeof value !== 'function') return;
  if (ENGINE_CALLED_KEYS.has(key) || (key === 'join' && Array.isArray(target))) {
    throw new InterpreterError(
      `A function cannot be stored under '${key}': the sandbox runs a function only where the script calls it`,
    );
  }
}

/**
 * Max length any single string-amplifying native op (`repeat`/`padStart`/
 * `padEnd`) may PRODUCE. These allocate in one step, so they're invisible to the
 * instruction budget — without this cap a script can OOM the V8 isolate well
 * within `maxSteps` (e.g. `'x'.repeat(5e8)`, or a short loop of `.repeat(5e7)`).
 * 1 MB is far above any legitimate AgentScript need.
 */
const MAX_STRING_OP_LENGTH = 1_000_000;

/**
 * Longest text one conversion of an array may produce: `join`, `'' + array`, a template literal,
 * an array given to a built-in function that expects text or a number (the budget still applies).
 */
const MAX_JOIN_LENGTH = 16_000_000;

/** Deepest nesting of arrays that is followed when an array is turned into text */
const MAX_TEXT_NESTING = 64;

/** Most array items one conversion to text looks at before it is refused as too large */
const MAX_TEXT_ITEMS = 8_000_000;

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

const FunctionProtoCall: unknown = Function.prototype.call;
const FunctionProtoApply: unknown = Function.prototype.apply;
const FunctionProtoBind: unknown = Function.prototype.bind;
const FunctionProtoToString = Function.prototype.toString;

/** The methods of a built-in prototype, with their names. */
function methodsOf(prototype: object): ReadonlyMap<unknown, string> {
  const methods = new Map<unknown, string>();
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && typeof descriptor.value === 'function') methods.set(descriptor.value, name);
  }
  return methods;
}

// A script reaches a built-in method as a value (`[].join`, `''.repeat`) and can call it through
// `call`, `apply`, `bind` or a variable. What a call may do is therefore decided by WHICH function
// is called, never by how the call is written.
const ARRAY_METHODS = methodsOf(Array.prototype);
const STRING_METHODS = methodsOf(String.prototype);

/**
 * The arguments an array method keeps as they are. Every other argument is a number or a text to
 * the engine, which converts whatever it is given.
 */
const ARRAY_DATA_ARGUMENTS: ReadonlyMap<string, (index: number) => boolean> = new Map<
  string,
  (index: number) => boolean
>([
  ['push', () => true],
  ['unshift', () => true],
  ['concat', () => true],
  ['includes', (index) => index === 0],
  ['indexOf', (index) => index === 0],
  ['lastIndexOf', (index) => index === 0],
  ['fill', (index) => index === 0],
  ['splice', (index) => index >= 2],
  ['toSpliced', (index) => index >= 2],
  ['with', (index) => index === 1],
  ['reduce', (index) => index === 1],
  ['reduceRight', (index) => index === 1],
]);

const ARRAY_DATA_FUNCTIONS = new WeakSet<object>();

/**
 * Declare that `fn` takes arrays as data and never converts one to text or to a number (the
 * engine does that to an array wherever it expects a primitive). Arrays given to any other
 * built-in or host function are measured first.
 */
export function takesArraysAsData<F extends object>(fn: F): F {
  ARRAY_DATA_FUNCTIONS.add(fn);
  return fn;
}

const CONVERTED_ARGUMENTS = new WeakMap<object, number>();

/**
 * Declare that `fn` reads only its first `count` arguments (and may convert those to text or to
 * a number): an array among the others is not measured. For functions whose code is known to
 * ignore what it is given beyond that, such as the stand-ins of the standard globals; a script
 * hands such a function three arguments when it uses it as the callback of `map`.
 */
export function convertsArguments<F extends object>(fn: F, count: number): F {
  CONVERTED_ARGUMENTS.set(fn, count);
  return fn;
}

const ARGUMENT_CONVERSIONS = new WeakMap<object, (args: unknown[]) => unknown[]>();

/**
 * Declare how `fn` converts its arguments before it looks at them. The conversion is made once,
 * before the call is measured and charged, and `fn` is called with its result: what a bound was
 * checked with is what the function gets.
 */
export function convertsBeforeCall<F extends object>(fn: F, convert: (args: unknown[]) => unknown[]): F {
  ARGUMENT_CONVERSIONS.set(fn, convert);
  return fn;
}

const CALL_COSTS = new WeakMap<object, (args: readonly unknown[]) => number>();

/**
 * Declare what a call of `fn` may allocate beyond the value it returns, in bytes, from its
 * arguments. It is charged to the budget BEFORE the call: the engine builds the result in one
 * step, and what is charged afterwards has already been allocated.
 */
export function chargedBeforeCall<F extends object>(fn: F, cost: (args: readonly unknown[]) => number): F {
  CALL_COSTS.set(fn, cost);
  return fn;
}

interface TextMeasure {
  /** Chars written so far */
  length: number;
  /** Array items looked at so far */
  items: number;
  /** Arrays being converted: the engine writes nothing for one it is already converting */
  active: Set<unknown[]>;
  /** Text length of the functions seen */
  functions: Map<unknown, number>;
}

function newTextMeasure(): TextMeasure {
  return { length: 0, items: 0, active: new Set(), functions: new Map() };
}

/** Upper bound of the text of one array item that is neither a string nor an array. */
function scalarTextLength(item: unknown, measure: TextMeasure): number {
  switch (typeof item) {
    case 'number':
    case 'boolean':
      return 32; // also covers a number in the longest locale format
    case 'bigint':
      return String(item).length;
    case 'function': {
      let length = measure.functions.get(item);
      if (length === undefined) {
        try {
          length = (FunctionProtoToString.call(item) as string).length;
        } catch {
          length = 0;
        }
        measure.functions.set(item, length);
      }
      return length;
    }
    case 'object': {
      if (isScriptError(item)) {
        const error = item as { name?: unknown; message?: unknown };
        return String(error.name).length + 2 + String(error.message).length;
      }
      return 96; // a date, or '[object Object]'
    }
    default:
      return 0; // a symbol cannot be converted at all
  }
}

/**
 * Add to `measure` the chars the engine writes when it converts `array` to text: the items,
 * `separatorLength` chars between them, and nested arrays joined by a comma. An array that is
 * reached twice is counted twice, because it is written twice. Stops once the limit is passed.
 */
function measureArrayText(array: unknown[], separatorLength: number, measure: TextMeasure, depth: number): void {
  if (depth > MAX_TEXT_NESTING) {
    measure.length = Number.POSITIVE_INFINITY;
    return;
  }
  measure.length += separatorLength * Math.max(0, array.length - 1);
  measure.active.add(array);
  for (let i = 0; i < array.length && measure.length <= MAX_JOIN_LENGTH; i++) {
    if (++measure.items > MAX_TEXT_ITEMS) {
      measure.length = Number.POSITIVE_INFINITY;
      break;
    }
    const item: unknown = array[i];
    if (typeof item === 'string') measure.length += item.length;
    else if (item === null || item === undefined) continue;
    else if (Array.isArray(item)) {
      if (!measure.active.has(item)) measureArrayText(item, 1, measure, depth + 1);
    } else measure.length += scalarTextLength(item, measure);
  }
  measure.active.delete(array);
}

/** Items of `array` after `flat(depth)`, or more than `limit`. */
function flatLength(array: unknown[], depth: number, limit: number, nesting = 0): number {
  if (nesting > MAX_TEXT_NESTING) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < array.length && count <= limit; i++) {
    const item: unknown = array[i];
    if (depth >= 1 && Array.isArray(item)) count += flatLength(item, depth - 1, limit - count, nesting + 1);
    else count++;
  }
  return count;
}

const TEXT_TOO_LONG = `An array cannot be turned into a text of more than ${MAX_JOIN_LENGTH} chars`;

/**
 * Refuse arrays that the engine would turn into more text than a script may make in one step.
 * A built-in that converts its argument (`String(x)`, `Number(x)`, `x + ''`, a property key)
 * joins an array's items, and the items of the arrays inside it: an array that holds another one
 * many times is small in memory and huge as text.
 *
 * @throws InterpreterError when the text of the arrays among `values` is longer than the limit
 */
export function assertArrayTextWithinLimit(...values: unknown[]): void {
  let measure: TextMeasure | undefined;
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    measure ??= newTextMeasure();
    measureArrayText(value, 1, measure, 0);
    if (measure.length > MAX_JOIN_LENGTH) throw new InterpreterError(TEXT_TOO_LONG);
  }
}

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
  /**
   * How many calls deep the code of this scope runs: 0 for the program, and for the body of a
   * function one more than where it was called from. A block inside has the depth around it.
   */
  readonly depth: number;

  constructor(
    private readonly parent?: Scope,
    depth?: number,
  ) {
    this.depth = depth ?? parent?.depth ?? 0;
  }

  child(): Scope {
    return new Scope(this);
  }

  /** The scope of one call of a function defined in this scope, running `depth` calls deep. */
  activation(depth: number): Scope {
    return new Scope(this, depth);
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
  /**
   * How deep calls may nest: a call counts from where it is made to where it returns, along the
   * chain of calls it belongs to. A callback counts as a call of the function that invokes it,
   * so the tasks of one `parallel` batch each continue the chain that started the batch and do
   * not add up.
   */
  maxCallDepth: number;
  /**
   * How many calls of the whole execution may be unfinished at once, over all its chains: the
   * ones that are running and the ones waiting for something they await. This bounds what the
   * waiting calls hold. Default: {@link DEFAULT_MAX_PENDING_CALLS}.
   */
  maxPendingCalls?: number;
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

/** Unfinished calls an execution may have at once, when the host sets no `maxPendingCalls`. */
export const DEFAULT_MAX_PENDING_CALLS = 4096;

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
  /** Calls that have not returned: the running ones and the ones waiting on an `await` */
  private pendingCalls = 0;
  /**
   * The depth of whatever is making a call right now, for the function of the script that call
   * starts. A function of the script is a host function too, and a built-in, `parallel` or a
   * bound function invokes it without saying how deep it is: it reads this as it starts, in the
   * same synchronous step as the call, and runs one deeper. Set by {@link withCallerDepth} for
   * the synchronous part of a call only; a call that is waiting does not hold it, which is what
   * keeps the depth of one chain apart from the depth of another. 0 when the host itself calls.
   */
  private callerDepth = 0;
  private readonly maxPendingCalls: number;
  private readonly globals: Record<string, unknown>;
  /** The error that ended the run (step budget, abort, allocation budget); set once, never caught */
  private fatal: unknown;
  private readonly interpretedFunctions = new WeakSet<object>();
  private readonly errorCopies = new WeakMap<object, object>();

  constructor(private readonly options: InterpreterOptions) {
    this.globals = options.globals;
    this.maxPendingCalls = options.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS;
  }

  /**
   * Call a function for a script, with the checks that apply to a call the script writes itself.
   * For a host helper that is handed a callback (`parallel(items, fn)`): `fn` may be a function
   * of the script, or a built-in or host function the script passed along.
   */
  call(fn: unknown, args: unknown[]): unknown {
    // A helper that is still going when the run has been ended starts nothing more for the script
    if (this.fatal !== undefined) throw this.fatal;
    if (typeof fn !== 'function') throw new InterpreterError('Attempted to call a non-function');
    // The call continues the chain of the helper that makes it, one call deeper, when the helper
    // makes it while its own call is starting (`parallel` starts every task that way). A call a
    // helper makes later, after an `await`, starts a chain of its own.
    if (this.interpretedFunctions.has(fn)) return (fn as (...a: unknown[]) => unknown)(...args);
    return this.callFunction(fn, undefined, args, this.callerDepth);
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
   * End the run from outside: whatever of the script is still going (a callback waiting for a
   * tool call, a run that timed out while it waited) stops at its next step or its next call,
   * whichever comes first. The host calls this when the execution has returned, so that no
   * script code runs and no host function is called after it.
   */
  stop(): void {
    if (this.fatal === undefined) this.fatal = new InterpreterError('Execution ended');
  }

  /**
   * Charge an allocation that a runtime helper of the host made for the script (the helpers a
   * transformed `+` or template literal calls). The budget is one budget wherever it is asked:
   * a refusal ends the run here as it does for what the interpreter charges itself, and no
   * `catch` or `finally` of the script runs after it.
   */
  chargeAllocation(bytes: number): void {
    this.charge(bytes);
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
                  assertStorable(obj, k, v);
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
          const member = await this.evalExpr(prop.value as ESTree.Expression, scope);
          assertStorable(obj, key, member);
          obj[key] = member;
          count++;
        }
        this.charge(count * 16);
        return obj;
      }
      case 'UnaryExpression':
        return this.evalUnary(node, scope);
      case 'UpdateExpression': {
        const ref = await this.resolveReference(node.argument, scope);
        const current = ref.get();
        assertArrayTextWithinLimit(current);
        const before = Number(current);
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
        return readProperty(object, key);
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
      if (i < node.expressions.length) {
        const value = await this.evalExpr(node.expressions[i], scope);
        assertArrayTextWithinLimit(value);
        out += String(value);
        if (out.length > MAX_JOIN_LENGTH) throw new InterpreterError(TEXT_TOO_LONG);
      }
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
      assertKeyAllowed(key);
      return delete (object as Record<string, unknown>)[key];
    }
    const v = await this.evalExpr(node.argument, scope);
    switch (node.operator) {
      case '!':
        return !truthy(v);
      case '-':
        assertArrayTextWithinLimit(v);
        return -(v as number);
      case '+':
        assertArrayTextWithinLimit(v);
        return +(v as number);
      case 'typeof':
        return typeof v;
      case '~':
        assertArrayTextWithinLimit(v);
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
      assertArrayTextWithinLimit(l);
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
    // Every operator but the two strict comparisons converts an array operand to text.
    if (operator !== '===' && operator !== '!==') assertArrayTextWithinLimit(left, right);
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
      ? this.keyText(await this.evalExpr(node.property, scope))
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
        get: () => readProperty(object, key),
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
    assertKeyAllowed(key);
    assertStorable(object, key, value);
    if (Array.isArray(object)) {
      // A length is converted here, once: the number that is checked is the number that is set
      if (key === 'length') value = convertedOnce(value, Number);
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
    const args = await this.evalArguments(node.arguments, scope);
    if (!ARRAY_DATA_FUNCTIONS.has(callee as object)) assertArrayTextWithinLimit(...args);
    const value = construct(args);
    this.chargeValue(value);
    return value;
  }

  private async evalCall(node: ESTree.SimpleCallExpression, scope: Scope): Promise<unknown> {
    let fn: unknown;
    let thisArg: unknown;
    let member: (MemberTarget & { value: unknown }) | undefined;
    if (node.callee.type === 'MemberExpression') {
      const target = await this.evalMemberTarget(node.callee, scope);
      member = { ...target, value: readProperty(target.object, target.key) };
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
    if (typeof fn !== 'function') throw new InterpreterError('Attempted to call a non-function');
    return this.callFunction(fn, thisArg, args, scope.depth);
  }

  /**
   * Call a function with a receiver and arguments: an interpreted function, or a built-in or host
   * function after the checks that apply to it. `call` and `apply` are resolved to the function
   * they invoke first, so those checks cannot be passed by the way a call is written.
   *
   * @param depth - How many calls deep the code that makes this call runs
   */
  private async callFunction(fn: unknown, thisArg: unknown, args: unknown[], depth: number): Promise<unknown> {
    // Once the run has been ended no call is made for the script: a call is where a script
    // reaches the host (a tool, the console), and a chain that was waiting when the execution
    // returned may get here without passing a step.
    if (this.fatal !== undefined) throw this.fatal;
    for (let hops = 0; fn === FunctionProtoCall || fn === FunctionProtoApply || fn === FunctionProtoBind; hops++) {
      const name = fn === FunctionProtoCall ? 'call' : fn === FunctionProtoApply ? 'apply' : 'bind';
      if (typeof thisArg !== 'function' || hops >= 8) {
        throw new InterpreterError(`'${name}' works on a function only`);
      }
      // Generic built-ins write to their receiver (`[].push.call(target, value)` sets
      // `target[n]`), and the built-in functions are objects the whole host process shares: a
      // function is never accepted as that receiver.
      if (typeof args[0] === 'function') {
        throw new InterpreterError(`'${name}' cannot make a function the receiver of a call`);
      }
      const target: unknown = thisArg;
      if (fn === FunctionProtoBind) return this.bindFunction(target, args[0], args.slice(1));
      thisArg = args[0];
      args = fn === FunctionProtoCall ? args.slice(1) : this.argumentList(args[1]);
      fn = target;
    }
    if (typeof fn !== 'function') throw new InterpreterError('Attempted to call a non-function');

    // A function of the script counts itself as it starts (see makeFunction): it is told the
    // depth it is called from. What it returns was charged when it was made.
    if (this.interpretedFunctions.has(fn)) {
      const interpreted = fn as (...a: unknown[]) => unknown;
      return await this.withCallerDepth(depth, () => interpreted.apply(thisArg, args));
    }

    const own = this.enterCall(depth);
    try {
      args = this.checkBuiltinCall(fn, thisArg, args);
      // Higher-order array methods must AWAIT the (async) interpreter callbacks —
      // native Array.map/filter/sort don't await, so run our own implementations.
      const arrayMethod = ARRAY_METHODS.get(fn);
      if (arrayMethod !== undefined && HIGHER_ORDER_ARRAY_METHODS.has(arrayMethod) && typeof args[0] === 'function') {
        return await this.callArrayMethod(thisArg as unknown[], arrayMethod, args, own);
      }
      // A function of the script that the built-in invokes while it starts is its callee
      const builtin = fn as (...a: unknown[]) => unknown;
      const builtinArgs = args;
      const result = await this.withCallerDepth(own, () => builtin.apply(thisArg, builtinArgs));
      if (arrayMethod === undefined && STRING_METHODS.get(fn) === 'split' && Array.isArray(result)) {
        if (result.length > MAX_ARRAY_LENGTH) {
          throw new InterpreterError(`An array cannot be longer than ${MAX_ARRAY_LENGTH} items`);
        }
      }
      this.chargeValue(result);
      return result;
    } finally {
      this.pendingCalls--;
    }
  }

  /**
   * Count a call that starts `callerDepth` calls deep, until it returns.
   *
   * @returns The depth the call itself runs at
   */
  private enterCall(callerDepth: number): number {
    const depth = callerDepth + 1;
    if (depth > this.options.maxCallDepth) {
      throw new InterpreterError(`Max call depth exceeded (${this.options.maxCallDepth})`);
    }
    if (this.pendingCalls >= this.maxPendingCalls) {
      throw new InterpreterError(`Too many calls in progress at once (${this.maxPendingCalls})`);
    }
    this.pendingCalls++;
    return depth;
  }

  /**
   * Make a call with `depth` as the depth a function of the script is called from, if one starts
   * during it. It covers the synchronous part of the call, which is where a function starts.
   */
  private withCallerDepth<T>(depth: number, call: () => T): T {
    const previous = this.callerDepth;
    this.callerDepth = depth;
    try {
      return call();
    } finally {
      this.callerDepth = previous;
    }
  }

  /** The argument list of `apply`: an array, or nothing. */
  private argumentList(value: unknown): unknown[] {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw new InterpreterError("'apply' takes its arguments as an array");
    this.charge(value.length * 8);
    return [...value];
  }

  /**
   * `fn.bind(receiver, ...args)`: a function that calls `fn` through {@link callFunction}, so
   * that what is checked for a call of `fn` is checked for a call of the bound function too.
   */
  private bindFunction(target: unknown, boundThis: unknown, boundArgs: unknown[]): (...rest: unknown[]) => unknown {
    this.charge((boundArgs.length + 2) * 8);
    return (...rest: unknown[]): Promise<unknown> => {
      // The bound function is called as a built-in is: one call deep where it is called from,
      // and the function it stands for one deeper.
      const result = this.callFunction(target, boundThis, [...boundArgs, ...rest], this.callerDepth);
      // As for an interpreted function: a call nobody awaits must not become an unhandled rejection.
      result.then(undefined, ignoreRejection);
      return result;
    };
  }

  /**
   * The checks before a built-in or host function runs. The engine performs such a call in one
   * step, out of reach of the step budget, and what the call allocates is only known to the
   * budget when it exists: whatever could make that large is refused here, from the arguments.
   *
   * @returns The arguments to call the function with
   */
  private checkBuiltinCall(fn: object, thisArg: unknown, args: unknown[]): unknown[] {
    const arrayMethod = ARRAY_METHODS.get(fn);
    const stringMethod = arrayMethod === undefined ? STRING_METHODS.get(fn) : undefined;

    // Arrays where the function takes a text or a number: the engine joins them.
    let arrayText = 0;
    if (!ARRAY_DATA_FUNCTIONS.has(fn)) {
      const isData = arrayMethod === undefined ? undefined : ARRAY_DATA_ARGUMENTS.get(arrayMethod);
      const converted = CONVERTED_ARGUMENTS.get(fn) ?? args.length;
      let measure: TextMeasure | undefined;
      const measureArray = (value: unknown[]): void => {
        measure ??= newTextMeasure();
        measureArrayText(value, 1, measure, 0);
        if (measure.length > MAX_JOIN_LENGTH) throw new InterpreterError(TEXT_TOO_LONG);
      };
      for (let i = 0; i < args.length && i < converted; i++) {
        const arg: unknown = args[i];
        if (Array.isArray(arg) && !isData?.(i)) measureArray(arg);
      }
      if (arrayMethod === undefined && stringMethod === undefined && Array.isArray(thisArg)) measureArray(thisArg);
      arrayText = (measure as TextMeasure | undefined)?.length ?? 0;
    }

    if (stringMethod !== undefined) args = this.checkStringMethod(stringMethod, thisArg, args, arrayText);
    else if (arrayMethod !== undefined) args = this.checkArrayMethod(arrayMethod, thisArg, args);

    const convert = ARGUMENT_CONVERSIONS.get(fn);
    if (convert) args = convert(args);
    const cost = CALL_COSTS.get(fn);
    if (cost) this.charge(cost(args));
    return args;
  }

  private checkStringMethod(name: string, receiver: unknown, args: unknown[], arrayText: number): unknown[] {
    // These methods accept any receiver and convert it; a script has no use for that.
    if (typeof receiver !== 'string') throw new InterpreterError(`String '${name}' works on a string only`);

    // These build a regular expression from their STRING argument inside the engine: the
    // same uninterruptible matching as a literal, without a literal.
    if (name === 'match' || name === 'matchAll' || name === 'search') {
      throw new InterpreterError(`String '${name}' is not supported: it runs a regular expression`);
    }

    if (name === 'replace' || name === 'replaceAll') {
      const replacement: unknown = args[1];
      // The engine would call the function for every match and use the promise it returns.
      if (typeof replacement === 'function') {
        throw new InterpreterError(`String '${name}' does not take a function in the sandbox`);
      }
      if (typeof replacement === 'object' && replacement !== null) {
        throw new InterpreterError(`String '${name}' takes a text as the replacement`);
      }
      const text = String(replacement);
      // The replacement is written once per match, and each `$` in it can stand for a part of
      // the receiver as long as the receiver itself (`$&`, the text before or after the match).
      const search: unknown = args[0];
      const searchLength = typeof search === 'string' ? search.length : 0;
      const matches =
        name === 'replace' ? 1 : searchLength > 0 ? Math.floor(receiver.length / searchLength) : receiver.length + 1;
      let dollars = 0;
      for (let at = text.indexOf('$'); at !== -1; at = text.indexOf('$', at + 1)) dollars++;
      const perMatch = text.length + dollars * receiver.length;
      if (matches * perMatch > MAX_STRING_OP_LENGTH) {
        throw new InterpreterError(
          `String '${name}' could produce more than ${MAX_STRING_OP_LENGTH} chars with this replacement`,
        );
      }
      return args;
    }

    // Cap string-amplifying ops whose allocation the step budget can't see.
    if (name === 'repeat' || name === 'padStart' || name === 'padEnd') {
      // The count is converted once: the number that is checked is the number the engine gets
      const count = convertedOnce(args[0], Number);
      const n = Number(count);
      const produced = name === 'repeat' ? receiver.length * (n > 0 ? n : 0) : Math.max(receiver.length, n > 0 ? n : 0);
      if (produced > MAX_STRING_OP_LENGTH) {
        throw new InterpreterError(
          `String '${name}' would produce ${produced} chars, exceeding the ${MAX_STRING_OP_LENGTH} limit`,
        );
      }
      return args.length === 0 ? args : [count, ...args.slice(1)];
    }

    // One call appends every argument; with a spread that is one string, many times.
    if (name === 'concat') {
      let produced = receiver.length + arrayText;
      for (let i = 0; i < args.length && produced <= MAX_JOIN_LENGTH; i++) {
        const arg: unknown = args[i];
        if (typeof arg === 'string') produced += arg.length;
        else if (!Array.isArray(arg)) produced += scalarTextLength(arg, newTextMeasure());
      }
      if (produced > MAX_JOIN_LENGTH) {
        throw new InterpreterError(`String 'concat' would produce more than ${MAX_JOIN_LENGTH} chars`);
      }
      return args;
    }

    // The engine stops at the limit it is given: the array it builds is never longer than a
    // script's arrays may be, plus the one item that shows the limit was passed.
    if (name === 'split') {
      const asked = args[1] === undefined ? Number.POSITIVE_INFINITY : Number(args[1]) >>> 0;
      return [args[0], Math.min(asked, MAX_ARRAY_LENGTH + 1)];
    }

    return args;
  }

  private checkArrayMethod(name: string, receiver: unknown, args: unknown[]): unknown[] {
    // These methods accept any receiver with a `length`: `{ length: 1e9 }` is no array, and the
    // engine would work through it as if it were one.
    if (!Array.isArray(receiver)) throw new InterpreterError(`Array '${name}' works on an array only`);

    const tooLong = (): never => {
      throw new InterpreterError(`An array cannot be longer than ${MAX_ARRAY_LENGTH} items`);
    };

    switch (name) {
      // `join` writes every item and a separator between them into one string, in one step; so
      // do the two conversions to text.
      case 'join':
      case 'toString':
      case 'toLocaleString': {
        // The separator is converted once: the text that is measured is the text that is written
        const given = name !== 'join' || args.length === 0 ? undefined : convertedOnce(args[0], String);
        const separator = given === undefined ? ',' : String(given);
        const measure = newTextMeasure();
        measureArrayText(receiver, separator.length, measure, 0);
        if (measure.length > MAX_JOIN_LENGTH) {
          throw new InterpreterError(`Array '${name}' would produce more than ${MAX_JOIN_LENGTH} chars`);
        }
        return name === 'join' && args.length > 0 ? [given, ...args.slice(1)] : args;
      }
      // Without a comparison function the engine compares the items as text: strings as they
      // are, and an array among the items joined, again for every comparison.
      case 'sort':
      case 'toSorted': {
        if (typeof args[0] === 'function') return args;
        const measure = newTextMeasure();
        for (let i = 0; i < receiver.length && measure.length <= MAX_JOIN_LENGTH; i++) {
          const item: unknown = receiver[i];
          if (Array.isArray(item)) measureArrayText(item, 1, measure, 1);
        }
        if (measure.length > MAX_JOIN_LENGTH) throw new InterpreterError(TEXT_TOO_LONG);
        return args;
      }
      // Growth by the arguments (a spread makes them many): charged before it happens.
      case 'push':
      case 'unshift':
        if (receiver.length + args.length > MAX_ARRAY_LENGTH) tooLong();
        this.charge(args.length * 8);
        return args;
      case 'splice':
      case 'toSpliced': {
        const added = Math.max(0, args.length - 2);
        if (receiver.length + added > MAX_ARRAY_LENGTH) tooLong();
        if (name === 'splice') this.charge(added * 8);
        return args;
      }
      // A new array of the receiver and every array among the arguments: one array, given many
      // times, is small in memory and large once copied.
      case 'concat': {
        let length = receiver.length;
        for (let i = 0; i < args.length && length <= MAX_ARRAY_LENGTH; i++) {
          const arg: unknown = args[i];
          length += Array.isArray(arg) ? arg.length : 1;
        }
        if (length > MAX_ARRAY_LENGTH) tooLong();
        return args;
      }
      case 'flat': {
        // The depth is converted once: the depth that is measured is the depth the engine gets
        const given = convertedOnce(args[0], Number);
        const depth = given === undefined ? 1 : Number(given);
        if (flatLength(receiver, Number.isNaN(depth) ? 0 : depth, MAX_ARRAY_LENGTH) > MAX_ARRAY_LENGTH) tooLong();
        return args.length === 0 ? args : [given, ...args.slice(1)];
      }
      default:
        return args;
    }
  }

  /**
   * Async implementations of the higher-order array methods, so interpreter
   * callbacks (which are async — they may `await` tool calls) are awaited. Each
   * iteration ticks the step budget.
   */
  private async callArrayMethod(arr: unknown[], method: string, args: unknown[], depth: number): Promise<unknown> {
    // The callback is a call the array method makes, `depth` calls deep: every iteration says
    // so again, because the method waits for the callback in between. A function of the script
    // is called as it is. Anything else (a built-in such as `String`, a host function, a bound
    // function) is called the way a call the script writes is: with the checks of
    // {@link checkBuiltinCall}, and what it returns charged to the budget.
    const callback: unknown = args[0];
    const interpreted = this.interpretedFunctions.has(callback as object)
      ? (callback as (...callbackArgs: unknown[]) => unknown)
      : undefined;
    const invoke: (...callbackArgs: unknown[]) => unknown = interpreted
      ? (...callbackArgs: unknown[]) => this.withCallerDepth(depth, () => interpreted(...callbackArgs))
      : (...callbackArgs: unknown[]) => this.callFunction(callback, undefined, callbackArgs, depth);
    const cb = invoke as (value: unknown, index: number, array: unknown[]) => Promise<unknown>;
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
              if (taken.has(key) || BLOCKED_KEYS.has(key)) continue;
              assertStorable(rest, key, source[key]);
              rest[key] = source[key];
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
          await this.applyPattern(prop.value, readProperty(source, key), scope, mode);
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
    const call = async (args: unknown[], callerDepth: number): Promise<unknown> => {
      // Counted here, where the function starts, so that it holds whoever calls it: the
      // interpreter for a call the script writes, or a built-in that was handed the function.
      const fnScope = outer.activation(this.enterCall(callerDepth));
      try {
        for (let i = 0; i < node.params.length; i++) {
          const param = node.params[i];
          if (param.type === 'RestElement') {
            await this.applyPattern(param.argument, args.slice(i), fnScope, 'let');
            break;
          }
          await this.applyPattern(param, args[i], fnScope, 'let');
        }
        if (node.body.type === 'BlockStatement') {
          await this.execBlock(node.body.body, fnScope);
          return undefined;
        }
        return await this.evalExpr(node.body, fnScope); // arrow shorthand
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      } finally {
        this.pendingCalls--;
      }
    };
    // Read as the function is called, before anything of it is awaited
    const depthOfCaller = (): number => this.callerDepth;
    const interpreted = function interpreted(...args: unknown[]): Promise<unknown> {
      const result = call(args, depthOfCaller());
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

  /** A computed property key as text. An array as a key is its items, joined. */
  private keyText(value: unknown): string {
    assertArrayTextWithinLimit(value);
    return String(value);
  }

  private async propKey(prop: ESTree.Property, scope: Scope): Promise<string> {
    if (prop.computed) return this.keyText(await this.evalExpr(prop.key as ESTree.Expression, scope));
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    throw new InterpreterError('Unsupported property key');
  }

  private readGlobal(name: string): unknown {
    // `__proto__` is never a global, whatever the object that holds the globals was built from
    if (name !== '__proto__' && Object.prototype.hasOwnProperty.call(this.globals, name)) return this.globals[name];
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
 *
 * The two prototypes themselves fit that description (`Array.prototype` is an array, and the
 * prototype of `Object.prototype` is nothing) and are nobody's data: every object and array of the
 * process inherits from them.
 */
export function isScriptData(value: unknown): boolean {
  if (value === Object.prototype || value === Array.prototype) return false;
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * An argument a built-in converts, converted here instead when the conversion is one the engine
 * would repeat: of an object, whose answer need not be the same twice. Any other value is passed
 * on as it is, and the engine converts it (or refuses it) as it always does.
 */
function convertedOnce(value: unknown, convert: (value: unknown) => unknown): unknown {
  return typeof value === 'object' && value !== null ? convert(value) : value;
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
