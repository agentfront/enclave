import {
  DeadlineError,
  InterpreterError,
  StepLimitError,
  assertStorable,
  checkArrayWrite,
  isBlockedKey,
} from '../interpreter';
import type { Code, CompiledProgram } from './compiler';
import { ADDRESS_MASK, Op, UPDATE_DECREMENT, UPDATE_PREFIX } from './ops';
import {
  CALL_TOOL,
  Closure,
  CodeFrame,
  Env,
  Fiber,
  FiberStatus,
  Group,
  Hof,
  HofFrame,
  Intrinsic,
  IterState,
  PARALLEL,
  type Frame,
} from './values';

export interface MachineOptions {
  maxSteps: number;
  maxCallDepth?: number;
  deadline?: number;
  /** Asked before each statement runs; true pauses the run there. */
  pauseAt?: (statement: number, fiber: number, steps: number) => boolean;
}

export interface ToolRequest {
  callId: number;
  fiber: number;
  name: string;
  args: unknown;
}

export type Outcome = { kind: 'done'; value: unknown } | { kind: 'waiting'; calls: ToolRequest[] } | { kind: 'paused' };

export class ScriptThrow {
  constructor(readonly value: unknown) {}
}

const MAX_PARALLEL = 100;
const CLOCK_STEPS = 4096;

function pick(source: object, names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of names) out[n] = (source as Record<string, unknown>)[n];
  return Object.freeze(out);
}

export const GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({
  Math: pick(Math, ['abs', 'ceil', 'floor', 'round', 'max', 'min', 'pow', 'sqrt', 'sign', 'trunc', 'log', 'exp', 'PI']),
  JSON: pick(JSON, ['parse', 'stringify']),
  Object: pick(Object, ['keys', 'values', 'entries', 'fromEntries']),
  Array: pick(Array, ['isArray']),
  Number,
  String,
  Boolean,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  Set,
  Map,
  NaN,
  Infinity,
  callTool: CALL_TOOL,
  parallel: PARALLEL,
});

const PROTOTYPE_METHODS: Array<[object, string, string[]]> = [
  [
    Array.prototype,
    'Array.prototype',
    [
      'push',
      'pop',
      'shift',
      'unshift',
      'slice',
      'concat',
      'join',
      'indexOf',
      'includes',
      'reverse',
      'sort',
      'flat',
      'at',
    ],
  ],
  [
    String.prototype,
    'String.prototype',
    [
      'toUpperCase',
      'toLowerCase',
      'trim',
      'split',
      'slice',
      'substring',
      'includes',
      'startsWith',
      'endsWith',
      'indexOf',
      'charAt',
      'replace',
      'at',
    ],
  ],
  [Number.prototype, 'Number.prototype', ['toFixed', 'toString']],
  [Set.prototype, 'Set.prototype', ['add', 'has', 'delete']],
  [Map.prototype, 'Map.prototype', ['get', 'set', 'has', 'delete']],
];

/** Every host value a script can hold, by a stable name: what a saved state refers to. */
export const HOST_NAMES = new Map<unknown, string>();
export const HOST_VALUES = new Map<string, unknown>();

function register(name: string, value: unknown): void {
  HOST_NAMES.set(value, name);
  HOST_VALUES.set(name, value);
}

for (const [name, value] of Object.entries(GLOBALS)) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (!(value instanceof Intrinsic)) register(name, value);
    if (typeof value === 'object' && !(value instanceof Intrinsic)) {
      for (const [member, fn] of Object.entries(value)) if (typeof fn === 'function') register(`${name}.${member}`, fn);
    }
  }
}
const HOF_METHODS = new Map<unknown, Hof>([
  [Array.prototype.map, Hof.MAP],
  [Array.prototype.filter, Hof.FILTER],
  [Array.prototype.forEach, Hof.FOREACH],
  [Array.prototype.reduce, Hof.REDUCE],
  [Array.prototype.find, Hof.FIND],
  [Array.prototype.findIndex, Hof.FINDINDEX],
  [Array.prototype.some, Hof.SOME],
  [Array.prototype.every, Hof.EVERY],
  [Array.prototype.sort, Hof.SORT],
  [Array.prototype.flatMap, Hof.FLATMAP],
]);
for (const [fn] of HOF_METHODS) register(`Array.prototype.${(fn as { name: string }).name}`, fn);
for (const [proto, prefix, names] of PROTOTYPE_METHODS) {
  for (const n of names) register(`${prefix}.${n}`, (proto as Record<string, unknown>)[n]);
}

const CONSTRUCTORS = new Set<unknown>([Set, Map]);

/** Host methods that only store or compare what they are given: a function of the script may be among it. */
const KEEPS_FUNCTIONS_AS_DATA = new Set<unknown>([
  Array.prototype.push,
  Array.prototype.unshift,
  Array.prototype.concat,
  Array.prototype.includes,
  Array.prototype.indexOf,
  Set.prototype.add,
  Set.prototype.has,
  Set.prototype.delete,
  Map.prototype.set,
  Map.prototype.get,
  Map.prototype.has,
  Map.prototype.delete,
]);

function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function read(obj: unknown, key: string): unknown {
  if (isBlockedKey(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
  switch (typeof obj) {
    case 'string':
    case 'number':
    case 'boolean':
      return (obj as unknown as Record<string, unknown>)[key];
    case 'object': {
      if (obj === null) break;
      if (Array.isArray(obj)) return (obj as unknown as Record<string, unknown>)[key];
      const proto: unknown = Object.getPrototypeOf(obj);
      if (proto === Object.prototype || proto === null || proto === Set.prototype || proto === Map.prototype) {
        return (obj as Record<string, unknown>)[key];
      }
      throw new InterpreterError(`Cannot read property '${key}' of this value`);
    }
    case 'undefined':
      break;
    default:
      throw new InterpreterError(`Cannot read property '${key}' of this value`);
  }
  throw new InterpreterError(`Cannot read properties of ${String(obj)} (reading '${key}')`);
}

function toKey(key: unknown): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return String(key);
  if (typeof key === 'object' && key !== null && !Array.isArray(key)) return '[object Object]';
  return String(key);
}

function readElement(obj: unknown, key: unknown): unknown {
  if (typeof key === 'number' && Array.isArray(obj)) return obj[key];
  return read(obj, toKey(key));
}

function write(obj: unknown, key: string, value: unknown): void {
  if (isBlockedKey(key)) throw new InterpreterError(`Forbidden property access: ${key}`);
  if (Array.isArray(obj)) {
    const checked = checkArrayWrite(obj, key, value);
    (obj as unknown as Record<string, unknown>)[key] = checked.value;
    return;
  }
  if (typeof obj === 'object' && obj !== null && isPlain(obj) && !Object.isFrozen(obj)) {
    assertStorable(obj, key, value);
    (obj as Record<string, unknown>)[key] = value;
    return;
  }
  throw new InterpreterError(`Cannot set property '${key}' of this value`);
}

function writeElement(obj: unknown, key: unknown, value: unknown): void {
  if (typeof key === 'number' && Array.isArray(obj) && key >= 0 && key <= obj.length && Number.isInteger(key)) {
    obj[key] = value;
    return;
  }
  write(obj, toKey(key), value);
}

function itemsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (value instanceof Set || value instanceof Map) return [...value];
  throw new InterpreterError('Value is not iterable');
}

function binary(code: number, a: unknown, b: unknown): unknown {
  const x = a as number;
  const y = b as number;
  switch (code) {
    case 0:
      return x + y;
    case 1:
      return x - y;
    case 2:
      return x * y;
    case 3:
      return x / y;
    case 4:
      return x % y;
    case 5:
      return x ** y;
    case 6:
      return a == b;
    case 7:
      return a != b;
    case 8:
      return a === b;
    case 9:
      return a !== b;
    case 10:
      return x < y;
    case 11:
      return x <= y;
    case 12:
      return x > y;
    case 13:
      return x >= y;
    case 14:
      return x & y;
    case 15:
      return x | y;
    case 16:
      return x ^ y;
    case 17:
      return x << y;
    case 18:
      return x >> y;
    default:
      return x >>> y;
  }
}

function unary(code: number, v: unknown): unknown {
  switch (code) {
    case 0:
      return !v;
    case 1:
      return -(v as number);
    case 2:
      return +(v as number);
    case 3:
      return v instanceof Closure || v instanceof Intrinsic ? 'function' : typeof v;
    case 4:
      return undefined;
    default:
      return ~(v as number);
  }
}

function newVars(n: number): unknown[] {
  const vars: unknown[] = [];
  for (let i = 0; i < n; i++) vars.push(undefined);
  return vars;
}

function failureMessage(error: unknown): string {
  if (error instanceof ScriptThrow) return String(error.value);
  if (error instanceof Error) return error.message;
  return String(error);
}

export class Machine {
  steps = 0;
  nextCallId = 0;
  nextFiberId = 1;
  nextGroupId = 0;
  readonly fibers = new Map<number, Fiber>();
  readonly groups = new Map<number, Group>();
  queue: number[] = [];
  private nextClock = CLOCK_STEPS;
  private paused = false;
  private readonly maxSteps: number;
  private readonly maxCallDepth: number;

  constructor(
    readonly program: CompiledProgram,
    readonly options: MachineOptions,
  ) {
    this.maxSteps = options.maxSteps;
    this.maxCallDepth = options.maxCallDepth ?? 200;
  }

  static start(program: CompiledProgram, options: MachineOptions): Machine {
    const machine = new Machine(program, options);
    const main = program.codes[0];
    const fiber = new Fiber(0, [new CodeFrame(main, 0, new Env(newVars(main.nlocals), null), [])], -1, 0);
    machine.fibers.set(0, fiber);
    machine.queue.push(0);
    return machine;
  }

  run(): Outcome {
    this.paused = false;
    for (;;) {
      const main = this.fibers.get(0)!;
      if (main.status === FiberStatus.FAILED) throw this.surface(main.value);
      if (main.status === FiberStatus.DONE) return { kind: 'done', value: main.value };
      if (this.queue.length === 0) return { kind: 'waiting', calls: this.pending() };
      this.exec(this.fibers.get(this.queue[0])!);
      if (this.paused) return { kind: 'paused' };
      this.queue.shift();
    }
  }

  pending(): ToolRequest[] {
    const calls: ToolRequest[] = [];
    for (const fiber of this.fibers.values()) {
      if (fiber.status === FiberStatus.TOOL && fiber.wait) {
        calls.push({ callId: fiber.wait.callId, fiber: fiber.id, name: fiber.wait.name, args: fiber.wait.args });
      }
    }
    return calls.sort((a, b) => a.callId - b.callId);
  }

  resolve(callId: number, ok: boolean, value: unknown): void {
    for (const fiber of this.fibers.values()) {
      if (fiber.status !== FiberStatus.TOOL || fiber.wait?.callId !== callId) continue;
      fiber.wait = null;
      fiber.status = FiberStatus.READY;
      if (ok) {
        (fiber.frames[fiber.frames.length - 1] as CodeFrame).stack.push(value);
        this.queue.push(fiber.id);
      } else {
        this.fail(fiber, new InterpreterError(failureMessage(value)));
      }
      return;
    }
    throw new Error(`No call ${callId} is waiting`);
  }

  private surface(error: unknown): unknown {
    return error instanceof ScriptThrow ? error.value : error;
  }

  private checkClock(): void {
    this.nextClock = this.steps + CLOCK_STEPS;
    const deadline = this.options.deadline;
    if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineError();
  }

  private exec(fiber: Fiber): void {
    const frames = fiber.frames;
    const codes = this.program.codes;
    const pauseAt = this.options.pauseAt;
    try {
      outer: while (fiber.status === FiberStatus.READY) {
        const frame = frames[frames.length - 1];
        if (frame instanceof HofFrame) {
          this.stepHof(fiber, frame);
          continue;
        }
        const ops = frame.code.ops;
        const consts = frame.code.consts;
        const stack = frame.stack;
        let pc = frame.pc;
        let env = frame.env;
        for (;;) {
          if (++this.steps > this.maxSteps) throw new StepLimitError(this.maxSteps);
          if (this.steps >= this.nextClock) this.checkClock();
          const op = ops[pc];
          const arg = ops[pc + 1];
          pc += 2;
          switch (op) {
            case Op.CONST:
              stack.push(consts[arg]);
              break;
            case Op.UNDEF:
              stack.push(undefined);
              break;
            case Op.POP:
              stack.pop();
              break;
            case Op.DUP:
              stack.push(stack[stack.length - 1]);
              break;
            case Op.DUP2: {
              const n = stack.length;
              stack.push(stack[n - 2], stack[n - 1]);
              break;
            }
            case Op.NIP: {
              const v = stack.pop();
              stack.length -= arg;
              stack.push(v);
              break;
            }
            case Op.LOAD: {
              let e = env;
              for (let d = arg >>> 16; d > 0; d--) e = e.parent!;
              stack.push(e.vars[arg & 0xffff]);
              break;
            }
            case Op.STORE: {
              let e = env;
              for (let d = arg >>> 16; d > 0; d--) e = e.parent!;
              e.vars[arg & 0xffff] = stack[stack.length - 1];
              break;
            }
            case Op.STOREPOP:
            case Op.DECL: {
              let e = env;
              for (let d = arg >>> 16; d > 0; d--) e = e.parent!;
              e.vars[arg & 0xffff] = stack.pop();
              break;
            }
            case Op.GLOBAL: {
              const name = consts[arg] as string;
              if (!Object.prototype.hasOwnProperty.call(GLOBALS, name)) {
                throw new InterpreterError(`'${name}' is not defined`);
              }
              stack.push(GLOBALS[name]);
              break;
            }
            case Op.GETPROP:
              stack.push(read(stack.pop(), consts[arg] as string));
              break;
            case Op.GETELEM: {
              const key = stack.pop();
              stack.push(readElement(stack.pop(), key));
              break;
            }
            case Op.SETPROP: {
              const v = stack.pop();
              write(stack.pop(), consts[arg] as string, v);
              stack.push(v);
              break;
            }
            case Op.SETELEM: {
              const v = stack.pop();
              const key = stack.pop();
              writeElement(stack.pop(), key, v);
              stack.push(v);
              break;
            }
            case Op.NEWARR:
              stack.push([]);
              break;
            case Op.APPEND: {
              const v = stack.pop();
              (stack[stack.length - 1] as unknown[]).push(v);
              break;
            }
            case Op.SPREAD: {
              const items = itemsOf(stack.pop());
              const target = stack[stack.length - 1] as unknown[];
              checkArrayWrite(target, 'length', target.length + items.length);
              for (let i = 0; i < items.length; i++) target.push(items[i]);
              break;
            }
            case Op.NEWOBJ:
              stack.push({});
              break;
            case Op.DEFPROP: {
              const v = stack.pop();
              write(stack[stack.length - 1], consts[arg] as string, v);
              break;
            }
            case Op.DEFELEM: {
              const v = stack.pop();
              const key = toKey(stack.pop());
              write(stack[stack.length - 1], key, v);
              break;
            }
            case Op.OBJSPREAD: {
              const source = stack.pop();
              if (source === null || source === undefined) break;
              if (typeof source !== 'object' || !(Array.isArray(source) || isPlain(source))) {
                throw new InterpreterError('Only objects and arrays can be spread into an object');
              }
              const target = stack[stack.length - 1] as Record<string, unknown>;
              for (const k of Object.keys(source)) {
                if (!isBlockedKey(k)) target[k] = (source as Record<string, unknown>)[k];
              }
              break;
            }
            case Op.BIN: {
              const b = stack.pop();
              stack.push(binary(arg, stack.pop(), b));
              break;
            }
            case Op.UN:
              stack.push(unary(arg, stack.pop()));
              break;
            case Op.JMP:
              pc = arg;
              break;
            case Op.JF:
              if (!stack.pop()) pc = arg;
              break;
            case Op.JFK:
              if (!stack[stack.length - 1]) pc = arg;
              else stack.pop();
              break;
            case Op.JTK:
              if (stack[stack.length - 1]) pc = arg;
              else stack.pop();
              break;
            case Op.JNNK:
              if (stack[stack.length - 1] != null) pc = arg;
              else stack.pop();
              break;
            case Op.JNUK:
              if (stack[stack.length - 1] !== undefined) pc = arg;
              else stack.pop();
              break;
            case Op.OPTJ:
              if (stack[stack.length - 1] == null) {
                stack[stack.length - 1] = undefined;
                pc = arg;
              }
              break;
            case Op.CALL:
            case Op.CALLM:
            case Op.CALLA:
            case Op.CALLMA: {
              let args: unknown[];
              if (op === Op.CALLA || op === Op.CALLMA) args = stack.pop() as unknown[];
              else args = arg === 0 ? [] : stack.splice(stack.length - arg, arg);
              const fn = stack.pop();
              const self = op === Op.CALLM || op === Op.CALLMA ? stack.pop() : undefined;
              frame.pc = pc;
              frame.env = env;
              if (this.invoke(fiber, fn, self, args, stack)) continue outer;
              break;
            }
            case Op.NEW: {
              const args = arg === 0 ? [] : stack.splice(stack.length - arg, arg);
              const ctor = stack.pop();
              if (!CONSTRUCTORS.has(ctor)) throw new InterpreterError('new is not supported for this value');
              if (args.length > 0 && args[0] !== undefined) args[0] = itemsOf(args[0]);
              stack.push(new (ctor as new (items?: unknown) => unknown)(args[0]));
              break;
            }
            case Op.CLOSURE:
              stack.push(new Closure(codes[arg], env));
              break;
            case Op.RET: {
              const v = stack.pop();
              frames.pop();
              if (frames.length === 0) {
                this.finish(fiber, v);
                return;
              }
              this.deliver(fiber, v);
              continue outer;
            }
            case Op.AWAIT:
              break;
            case Op.STMT:
              if (pauseAt !== undefined && pauseAt(arg, fiber.id, this.steps)) {
                frame.pc = pc;
                frame.env = env;
                this.paused = true;
                return;
              }
              break;
            case Op.PUSHENV:
              env = new Env(newVars(arg), env);
              break;
            case Op.POPENV:
              env = env.parent!;
              break;
            case Op.COPYENV:
              env = new Env(env.vars.slice(), env.parent);
              break;
            case Op.ITERINIT:
              stack.push(new IterState(itemsOf(stack.pop()), 0));
              break;
            case Op.ITERNEXT: {
              const it = stack[stack.length - 1] as IterState;
              if (it.i < it.items.length) stack.push(it.items[it.i++]);
              else {
                stack.pop();
                pc = arg;
              }
              break;
            }
            case Op.TPL: {
              const quasis = consts[arg] as string[];
              const n = quasis.length - 1;
              const values = n === 0 ? [] : stack.splice(stack.length - n, n);
              let text = quasis[0];
              for (let i = 0; i < n; i++) text += String(values[i]) + quasis[i + 1];
              stack.push(text);
              break;
            }
            case Op.UPDVAR: {
              const addr = arg & ADDRESS_MASK;
              let e = env;
              for (let d = addr >>> 16; d > 0; d--) e = e.parent!;
              const old = Number(e.vars[addr & 0xffff]);
              const next = arg & UPDATE_DECREMENT ? old - 1 : old + 1;
              e.vars[addr & 0xffff] = next;
              stack.push(arg & UPDATE_PREFIX ? next : old);
              break;
            }
            case Op.UPDPROP:
            case Op.UPDELEM: {
              const key = op === Op.UPDPROP ? (consts[arg & ADDRESS_MASK] as string) : toKey(stack.pop());
              const obj = stack.pop();
              const old = Number(read(obj, key));
              const next = arg & UPDATE_DECREMENT ? old - 1 : old + 1;
              write(obj, key, next);
              stack.push(arg & UPDATE_PREFIX ? next : old);
              break;
            }
            case Op.REST: {
              const source = stack.pop();
              if (!Array.isArray(source)) throw new InterpreterError('Rest element needs an array');
              stack.push(source.slice(arg));
              break;
            }
            case Op.THROW:
              throw new ScriptThrow(stack.pop());
            default:
              throw new InterpreterError(`Bad instruction ${op}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof StepLimitError || error instanceof DeadlineError) throw error;
      this.fail(fiber, error);
    }
  }

  private enter(fn: Closure, args: unknown[]): CodeFrame {
    const code: Code = Closure.code(fn);
    const vars = newVars(code.nlocals);
    if (code.simpleParams >= 0) {
      const n = Math.min(code.simpleParams, args.length);
      for (let i = 0; i < n; i++) vars[i] = args[i];
      return new CodeFrame(code, 0, new Env(vars, Closure.env(fn)), []);
    }
    return new CodeFrame(code, 0, new Env(vars, Closure.env(fn)), [args]);
  }

  private push(fiber: Fiber, frame: Frame): void {
    if (fiber.frames.length >= this.maxCallDepth) throw new InterpreterError('Maximum call depth exceeded');
    fiber.frames.push(frame);
  }

  /** @returns true when the fiber's frames changed or it stopped to wait */
  private invoke(fiber: Fiber, fn: unknown, self: unknown, args: unknown[], stack: unknown[]): boolean {
    if (fn instanceof Closure) {
      this.push(fiber, this.enter(fn, args));
      return true;
    }
    if (fn === CALL_TOOL) {
      if (typeof args[0] !== 'string') throw new InterpreterError('callTool needs a tool name');
      fiber.status = FiberStatus.TOOL;
      fiber.wait = { callId: this.nextCallId++, name: args[0], args: args[1] };
      return true;
    }
    if (fn === PARALLEL) return this.parallel(fiber, args, stack);
    if (typeof fn === 'function' && HOST_NAMES.has(fn)) {
      if (CONSTRUCTORS.has(fn)) throw new InterpreterError('Use new with this constructor');
      const hof = HOF_METHODS.get(fn);
      if (hof !== undefined && args[0] instanceof Closure) {
        if (!Array.isArray(self)) throw new InterpreterError('Array method called on a value that is not an array');
        this.startHof(fiber, hof, args[0], self, args);
        return true;
      }
      if (!KEEPS_FUNCTIONS_AS_DATA.has(fn))
        for (const a of args) {
          if (a instanceof Closure || a instanceof Intrinsic) {
            throw new InterpreterError('A function of the script can be passed only to array methods and parallel');
          }
        }
      stack.push((fn as (...a: unknown[]) => unknown).apply(self, args));
      return false;
    }
    throw new InterpreterError('Attempted to call a non-function');
  }

  private parallel(fiber: Fiber, args: unknown[], stack: unknown[]): boolean {
    const [first, second] = args;
    if (!Array.isArray(first)) throw new InterpreterError('parallel requires an array');
    let tasks: Array<[Closure, unknown[]]>;
    if (second !== undefined) {
      if (!(second instanceof Closure)) throw new InterpreterError('parallel requires a function');
      tasks = first.map((item, i): [Closure, unknown[]] => [second, [item, i]]);
    } else {
      if (!first.every((t) => t instanceof Closure)) throw new InterpreterError('parallel requires functions');
      tasks = first.map((t): [Closure, unknown[]] => [t as Closure, []]);
    }
    if (tasks.length > MAX_PARALLEL) throw new InterpreterError(`Cannot run more than ${MAX_PARALLEL} in parallel`);
    if (tasks.length === 0) {
      stack.push([]);
      return false;
    }
    const group = new Group(this.nextGroupId++, fiber.id, newVars(tasks.length), tasks.length);
    this.groups.set(group.id, group);
    tasks.forEach(([fn, taskArgs], i) => {
      const child = new Fiber(this.nextFiberId++, [this.enter(fn, taskArgs)], group.id, i);
      this.fibers.set(child.id, child);
      this.queue.push(child.id);
    });
    fiber.status = FiberStatus.JOIN;
    return true;
  }

  private finish(fiber: Fiber, value: unknown): void {
    fiber.status = FiberStatus.DONE;
    fiber.value = value;
    this.settle(fiber);
  }

  private fail(fiber: Fiber, error: unknown): void {
    fiber.status = FiberStatus.FAILED;
    fiber.value = error;
    fiber.frames.length = 0;
    this.settle(fiber);
  }

  private settle(fiber: Fiber): void {
    if (fiber.group < 0) return;
    const group = this.groups.get(fiber.group)!;
    if (fiber.status === FiberStatus.FAILED) group.errors.push(failureMessage(fiber.value));
    else group.results[fiber.index] = fiber.value;
    this.fibers.delete(fiber.id);
    if (--group.remaining > 0) return;
    this.groups.delete(group.id);
    const parent = this.fibers.get(group.parent)!;
    if (group.errors.length > 0) {
      const message = `${group.errors.length} of ${group.results.length} parallel operations failed:\n${group.errors.join('\n')}`;
      this.fail(parent, new InterpreterError(message));
      return;
    }
    parent.status = FiberStatus.READY;
    (parent.frames[parent.frames.length - 1] as CodeFrame).stack.push(group.results);
    this.queue.push(parent.id);
  }

  private deliver(fiber: Fiber, value: unknown): void {
    const top = fiber.frames[fiber.frames.length - 1];
    if (top instanceof CodeFrame) top.stack.push(value);
    else this.receive(fiber, top, value);
  }

  private startHof(fiber: Fiber, kind: Hof, fn: Closure, arr: unknown[], args: unknown[]): void {
    const frame = new HofFrame(kind, fn, arr, 0);
    switch (kind) {
      case Hof.MAP:
      case Hof.FILTER:
      case Hof.FLATMAP:
        frame.out = [];
        break;
      case Hof.REDUCE:
        if (args.length >= 2) frame.acc = args[1];
        else {
          if (arr.length === 0) throw new InterpreterError('Reduce of empty array with no initial value');
          frame.acc = arr[0];
          frame.i = 1;
        }
        break;
      case Hof.SORT:
        frame.src = arr.slice();
        frame.dst = newVars(arr.length);
        break;
    }
    this.push(fiber, frame);
  }

  private stepHof(fiber: Fiber, f: HofFrame): void {
    const arr = f.arr;
    if (f.kind === Hof.SORT) {
      this.stepSort(fiber, f);
      return;
    }
    if (f.i < arr.length) {
      const args = f.kind === Hof.REDUCE ? [f.acc, arr[f.i], f.i, arr] : [arr[f.i], f.i, arr];
      this.push(fiber, this.enter(f.fn, args));
      return;
    }
    switch (f.kind) {
      case Hof.REDUCE:
        return this.endHof(fiber, f.acc);
      case Hof.FINDINDEX:
        return this.endHof(fiber, -1);
      case Hof.SOME:
        return this.endHof(fiber, false);
      case Hof.EVERY:
        return this.endHof(fiber, true);
      case Hof.FOREACH:
      case Hof.FIND:
        return this.endHof(fiber, undefined);
      default:
        return this.endHof(fiber, f.out);
    }
  }

  private receive(fiber: Fiber, f: HofFrame, v: unknown): void {
    switch (f.kind) {
      case Hof.MAP:
        (f.out as unknown[]).push(v);
        break;
      case Hof.FILTER:
        if (v) (f.out as unknown[]).push(f.arr[f.i]);
        break;
      case Hof.FLATMAP:
        if (Array.isArray(v)) (f.out as unknown[]).push(...v);
        else (f.out as unknown[]).push(v);
        break;
      case Hof.REDUCE:
        f.acc = v;
        break;
      case Hof.FIND:
        if (v) return this.endHof(fiber, f.arr[f.i]);
        break;
      case Hof.FINDINDEX:
        if (v) return this.endHof(fiber, f.i);
        break;
      case Hof.SOME:
        if (v) return this.endHof(fiber, true);
        break;
      case Hof.EVERY:
        if (!v) return this.endHof(fiber, false);
        break;
      case Hof.SORT:
        if ((v as number) > 0) f.dst[f.k++] = f.src[f.j++];
        else f.dst[f.k++] = f.src[f.i++];
        return;
    }
    f.i++;
  }

  private stepSort(fiber: Fiber, f: HofFrame): void {
    const n = f.src.length;
    for (;;) {
      if (!f.merging) {
        if (f.width >= n) {
          for (let i = 0; i < n; i++) f.arr[i] = f.src[i];
          return this.endHof(fiber, f.arr);
        }
        if (f.lo >= n) {
          const t = f.src;
          f.src = f.dst;
          f.dst = t;
          f.width *= 2;
          f.lo = 0;
          continue;
        }
        f.mid = Math.min(f.lo + f.width, n);
        f.hi = Math.min(f.lo + 2 * f.width, n);
        f.i = f.lo;
        f.j = f.mid;
        f.k = f.lo;
        f.merging = true;
      }
      if (f.i < f.mid && f.j < f.hi) {
        this.push(fiber, this.enter(f.fn, [f.src[f.i], f.src[f.j]]));
        return;
      }
      while (f.i < f.mid) f.dst[f.k++] = f.src[f.i++];
      while (f.j < f.hi) f.dst[f.k++] = f.src[f.j++];
      f.merging = false;
      f.lo = f.hi;
    }
  }

  private endHof(fiber: Fiber, value: unknown): void {
    fiber.frames.pop();
    (fiber.frames[fiber.frames.length - 1] as CodeFrame).stack.push(value);
  }
}
