import type { Code } from './compiler';

export class Env {
  constructor(
    public vars: unknown[],
    public parent: Env | null,
  ) {}
}

export class Closure {
  #code: Code;
  #env: Env;
  constructor(code: Code, env: Env) {
    this.#code = code;
    this.#env = env;
  }
  static code(fn: Closure): Code {
    return fn.#code;
  }
  static env(fn: Closure): Env {
    return fn.#env;
  }
  static relink(fn: Closure, env: Env): void {
    fn.#env = env;
  }
}

export class Intrinsic {
  constructor(readonly name: 'callTool' | 'parallel') {}
}

export class IterState {
  constructor(
    public items: unknown[],
    public i: number,
  ) {}
}

export const CALL_TOOL = new Intrinsic('callTool');
export const PARALLEL = new Intrinsic('parallel');

export class CodeFrame {
  constructor(
    public code: Code,
    public pc: number,
    public env: Env,
    public stack: unknown[],
  ) {}
}

export const enum Hof {
  MAP,
  FILTER,
  FOREACH,
  REDUCE,
  FIND,
  FINDINDEX,
  SOME,
  EVERY,
  SORT,
  FLATMAP,
}

export class HofFrame {
  out: unknown = undefined;
  acc: unknown = undefined;
  src: unknown[] = [];
  dst: unknown[] = [];
  width = 1;
  lo = 0;
  mid = 0;
  hi = 0;
  j = 0;
  k = 0;
  merging = false;
  constructor(
    public kind: Hof,
    public fn: Closure,
    public arr: unknown[],
    public i: number,
  ) {}
}

export const HOF_FIELDS = ['out', 'acc', 'src', 'dst', 'width', 'lo', 'mid', 'hi', 'j', 'k', 'merging'] as const;

export type Frame = CodeFrame | HofFrame;

export const enum FiberStatus {
  READY,
  TOOL,
  JOIN,
  DONE,
  FAILED,
}

export interface ToolWait {
  callId: number;
  name: string;
  args: unknown;
}

export class Fiber {
  status = FiberStatus.READY;
  value: unknown = undefined;
  wait: ToolWait | null = null;
  constructor(
    readonly id: number,
    readonly frames: Frame[],
    readonly group: number,
    readonly index: number,
  ) {}
}

export class Group {
  readonly errors: unknown[] = [];
  constructor(
    readonly id: number,
    readonly parent: number,
    readonly results: unknown[],
    public remaining: number,
  ) {}
}
