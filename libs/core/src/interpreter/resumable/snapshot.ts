import type { CompiledProgram } from './compiler';
import { HOST_NAMES, HOST_VALUES, Machine, type MachineOptions } from './machine';
import {
  CALL_TOOL,
  Closure,
  CodeFrame,
  Env,
  Fiber,
  Group,
  HOF_FIELDS,
  HofFrame,
  Intrinsic,
  IterState,
  PARALLEL,
  type FiberStatus,
  type Frame,
  type Hof,
} from './values';

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

type Encoded = unknown;

interface EncodedFrame {
  c?: number;
  pc?: number;
  e?: Encoded;
  s?: Encoded[];
  h?: Hof;
  f?: Encoded;
  a?: Encoded;
  i?: number;
  x?: Record<string, Encoded>;
}

interface EncodedFiber {
  id: number;
  st: FiberStatus;
  fr: EncodedFrame[];
  w: { callId: number; name: string; args: Encoded } | null;
  g: number;
  x: number;
}

interface EncodedGroup {
  id: number;
  p: number;
  r: Encoded;
  err: string[];
  rem: number;
}

export interface Snapshot {
  version: 1;
  hash: string;
  steps: number;
  nextCallId: number;
  nextFiberId: number;
  nextGroupId: number;
  queue: number[];
  fibers: EncodedFiber[];
  groups: EncodedGroup[];
  heap: unknown[];
}

class Encoder {
  readonly heap: unknown[] = [];
  private readonly ids = new Map<object, number>();
  private readonly todo: object[] = [];

  value(v: unknown): Encoded {
    switch (typeof v) {
      case 'number':
        if (Number.isFinite(v) && !Object.is(v, -0)) return v;
        return { n: Object.is(v, -0) ? '-0' : String(v) };
      case 'string':
      case 'boolean':
        return v;
      case 'undefined':
        return { u: 1 };
      case 'bigint':
        return { b: v.toString() };
      case 'object':
      case 'function':
        if (v === null) return null;
        return { r: this.ref(v) };
      default:
        throw new SnapshotError(`A value of type ${typeof v} cannot be saved`);
    }
  }

  private ref(o: object): number {
    let id = this.ids.get(o);
    if (id !== undefined) return id;
    id = this.heap.length;
    this.ids.set(o, id);
    this.heap.push(null);
    this.todo.push(o);
    return id;
  }

  drain(): void {
    while (this.todo.length > 0) {
      const o = this.todo.pop()!;
      this.heap[this.ids.get(o)!] = this.entry(o);
    }
  }

  private entry(o: object): unknown {
    const host = HOST_NAMES.get(o);
    if (host !== undefined) return { h: host };
    if (Array.isArray(o)) {
      const items: Encoded[] = [];
      for (let i = 0; i < o.length; i++) items.push(this.value(o[i]));
      return { a: items };
    }
    if (o instanceof Env) return { e: o.vars.map((v) => this.value(v)), p: o.parent ? this.ref(o.parent) : null };
    if (o instanceof Closure) return { f: Closure.code(o).id, e: this.ref(Closure.env(o)) };
    if (o instanceof IterState) return { it: this.ref(o.items), i: o.i };
    if (o instanceof Intrinsic) return { x: o.name };
    const proto: unknown = Object.getPrototypeOf(o);
    if (proto === Set.prototype) return { s: [...(o as Set<unknown>)].map((v) => this.value(v)) };
    if (proto === Map.prototype) {
      return { m: [...(o as Map<unknown, unknown>)].map(([k, v]) => [this.value(k), this.value(v)]) };
    }
    if (proto === Object.prototype || proto === null) {
      const props: Record<string, Encoded> = {};
      for (const k of Object.keys(o)) props[k] = this.value((o as Record<string, unknown>)[k]);
      return proto === null ? { o: props, z: 1 } : { o: props };
    }
    const kind =
      typeof o === 'function'
        ? 'host function'
        : ((proto as { constructor?: { name?: string } })?.constructor?.name ?? 'object');
    throw new SnapshotError(`A ${kind} the host did not register cannot be saved`);
  }

  frame(f: Frame): EncodedFrame {
    if (f instanceof CodeFrame)
      return { c: f.code.id, pc: f.pc, e: this.value(f.env), s: f.stack.map((v) => this.value(v)) };
    const x: Record<string, Encoded> = {};
    for (const k of HOF_FIELDS) x[k] = this.value(f[k]);
    return { h: f.kind, f: this.value(f.fn), a: this.value(f.arr), i: f.i, x };
  }
}

export function save(machine: Machine): Snapshot {
  const enc = new Encoder();
  const fibers: EncodedFiber[] = [];
  for (const fiber of machine.fibers.values()) {
    fibers.push({
      id: fiber.id,
      st: fiber.status,
      fr: fiber.frames.map((f) => enc.frame(f)),
      w: fiber.wait ? { callId: fiber.wait.callId, name: fiber.wait.name, args: enc.value(fiber.wait.args) } : null,
      g: fiber.group,
      x: fiber.index,
    });
  }
  const groups: EncodedGroup[] = [];
  for (const g of machine.groups.values()) {
    groups.push({ id: g.id, p: g.parent, r: enc.value(g.results), err: g.errors.map(String), rem: g.remaining });
  }
  enc.drain();
  return {
    version: 1,
    hash: machine.program.hash,
    steps: machine.steps,
    nextCallId: machine.nextCallId,
    nextFiberId: machine.nextFiberId,
    nextGroupId: machine.nextGroupId,
    queue: [...machine.queue],
    fibers,
    groups,
    heap: enc.heap,
  };
}

const INTRINSICS: Record<string, Intrinsic> = { callTool: CALL_TOOL, parallel: PARALLEL };

class Decoder {
  private readonly objects: unknown[];

  constructor(
    private readonly heap: unknown[],
    private readonly program: CompiledProgram,
  ) {
    this.objects = heap.map((raw) => this.allocate(raw as Record<string, unknown>));
    heap.forEach((raw, i) => this.fill(this.objects[i], raw as Record<string, unknown>));
  }

  value(e: Encoded): unknown {
    if (e === null || typeof e !== 'object') return e;
    const tagged = e as Record<string, unknown>;
    if ('r' in tagged) return this.objects[tagged['r'] as number];
    if ('u' in tagged) return undefined;
    if ('b' in tagged) return BigInt(tagged['b'] as string);
    if ('n' in tagged) return tagged['n'] === '-0' ? -0 : Number(tagged['n']);
    throw new SnapshotError('Malformed value');
  }

  private allocate(raw: Record<string, unknown>): unknown {
    if ('h' in raw) {
      const name = raw['h'] as string;
      if (!HOST_VALUES.has(name)) throw new SnapshotError(`Unknown host value ${name}`);
      return HOST_VALUES.get(name);
    }
    if ('a' in raw) return [];
    if ('o' in raw) return raw['z'] ? Object.create(null) : {};
    if ('e' in raw && !('f' in raw)) return new Env([], null);
    if ('f' in raw) {
      const code = this.program.codes[raw['f'] as number];
      if (!code) throw new SnapshotError('Unknown function');
      return new Closure(code, new Env([], null));
    }
    if ('it' in raw) return new IterState([], raw['i'] as number);
    if ('x' in raw) {
      const intrinsic = INTRINSICS[raw['x'] as string];
      if (!intrinsic) throw new SnapshotError('Unknown intrinsic');
      return intrinsic;
    }
    if ('s' in raw) return new Set();
    if ('m' in raw) return new Map();
    throw new SnapshotError('Malformed heap entry');
  }

  private fill(target: unknown, raw: Record<string, unknown>): void {
    if ('h' in raw || 'x' in raw) return;
    if ('a' in raw) {
      for (const v of raw['a'] as Encoded[]) (target as unknown[]).push(this.value(v));
    } else if ('o' in raw) {
      const props = raw['o'] as Record<string, Encoded>;
      for (const k of Object.keys(props)) {
        Object.defineProperty(target, k, {
          value: this.value(props[k]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    } else if ('f' in raw) {
      Closure.relink(target as Closure, this.objects[raw['e'] as number] as Env);
    } else if ('e' in raw) {
      const env = target as Env;
      env.vars = (raw['e'] as Encoded[]).map((v) => this.value(v));
      env.parent = raw['p'] === null ? null : (this.objects[raw['p'] as number] as Env);
    } else if ('it' in raw) {
      (target as IterState).items = this.objects[raw['it'] as number] as unknown[];
    } else if ('s' in raw) {
      for (const v of raw['s'] as Encoded[]) (target as Set<unknown>).add(this.value(v));
    } else if ('m' in raw) {
      for (const [k, v] of raw['m'] as Array<[Encoded, Encoded]>)
        (target as Map<unknown, unknown>).set(this.value(k), this.value(v));
    }
  }

  frame(e: EncodedFrame): Frame {
    if (e.c !== undefined) {
      return new CodeFrame(
        this.program.codes[e.c],
        e.pc!,
        this.value(e.e) as Env,
        e.s!.map((v) => this.value(v)),
      );
    }
    const frame = new HofFrame(e.h!, this.value(e.f) as Closure, this.value(e.a) as unknown[], e.i!);
    const fields = frame as unknown as Record<string, unknown>;
    for (const k of HOF_FIELDS) fields[k] = this.value(e.x![k]);
    return frame;
  }
}

export function restore(program: CompiledProgram, snapshot: Snapshot, options: MachineOptions): Machine {
  if (snapshot.version !== 1) throw new SnapshotError('Unknown snapshot version');
  if (snapshot.hash !== program.hash) throw new SnapshotError('The snapshot was saved for another script');
  const dec = new Decoder(snapshot.heap, program);
  const machine = new Machine(program, options);
  machine.steps = snapshot.steps;
  machine.nextCallId = snapshot.nextCallId;
  machine.nextFiberId = snapshot.nextFiberId;
  machine.nextGroupId = snapshot.nextGroupId;
  machine.queue = [...snapshot.queue];
  for (const ef of snapshot.fibers) {
    const fiber = new Fiber(
      ef.id,
      ef.fr.map((f) => dec.frame(f)),
      ef.g,
      ef.x,
    );
    fiber.status = ef.st;
    fiber.wait = ef.w ? { callId: ef.w.callId, name: ef.w.name, args: dec.value(ef.w.args) } : null;
    machine.fibers.set(fiber.id, fiber);
  }
  for (const eg of snapshot.groups) {
    const group = new Group(eg.id, eg.p, dec.value(eg.r) as unknown[], eg.rem);
    group.errors.push(...eg.err);
    machine.groups.set(group.id, group);
  }
  return machine;
}
