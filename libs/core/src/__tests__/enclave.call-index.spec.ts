import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { WorkerPoolAdapter } from '../adapters/worker-pool';
import { Enclave } from '../enclave';
import { PortableEnclave } from '../portable-enclave';
import { inCallOrder } from '../tool-call-order';
import type { CreateEnclaveOptions, ExecutionResult, ToolCall, ToolHandler, ToolResultOrder } from '../types';

interface Runner {
  run(code: string, handler?: ToolHandler): Promise<ExecutionResult>;
  dispose(): void;
}

type Parallel = (items: string, callback: string) => string;

const withCallback: Parallel = (items, callback) => `parallel(${items}, ${callback})`;
const withTasks: Parallel = (items, callback) => `parallel(${items}.map((item) => () => (${callback})(item)))`;

const RUNTIMES: Array<[string, (options: CreateEnclaveOptions) => Runner, Parallel]> = [
  ['double VM', (options) => new Enclave(options), withCallback],
  ['single VM', (options) => new Enclave({ ...options, doubleVm: { enabled: false } }), withTasks],
  [
    'InterpreterAdapter',
    (options) => new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() }),
    withCallback,
  ],
  ['PortableEnclave', (options) => new PortableEnclave(options), withCallback],
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnce(create: (options: CreateEnclaveOptions) => Runner, options: CreateEnclaveOptions, code: string) {
  const enclave = create(options);
  try {
    return await enclave.run(code);
  } finally {
    enclave.dispose();
  }
}

describe.each(RUNTIMES)('call positions on the %s', (_name, create, parallel) => {
  const BRANCHES = `
    await callTool('first', {});
    await callTool('second', {});
    await callTool('third', {});
    return await ${parallel(
      "['a', 'b']",
      `async (name) => {
        const head = await callTool('head', { name });
        return callTool('tail', { name, head });
      }`,
    )};
  `;

  function recordingHandler(slow: string) {
    const calls: Array<[number, string, unknown]> = [];
    const handler: ToolHandler = async (toolName, args, call: ToolCall) => {
      calls.push([call.callIndex, toolName, args]);
      if (args['name'] === slow && toolName === 'head') await delay(30);
      return toolName === 'head' ? `${String(args['name'])}-head` : toolName;
    };
    return { calls, handler };
  }

  it('numbers sequential calls and the calls of a parallel() in call order, whichever finishes first', async () => {
    const runs: Array<Array<[number, string, unknown]>> = [];
    for (const slow of ['a', 'b']) {
      const { calls, handler } = recordingHandler(slow);
      const result = await runOnce(create, { toolHandler: handler, toolResultOrder: 'call' }, BRANCHES);
      expect(result.success).toBe(true);
      expect(result.value).toEqual(['tail', 'tail']);
      runs.push(calls.sort((x, y) => x[0] - y[0]));
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]).toEqual([
      [0, 'first', {}],
      [1, 'second', {}],
      [2, 'third', {}],
      [3, 'head', { name: 'a' }],
      [4, 'head', { name: 'b' }],
      [5, 'tail', { name: 'a', head: 'a-head' }],
      [6, 'tail', { name: 'b', head: 'b-head' }],
    ]);
  });

  it('numbers calls as they reach the host when results arrive as they finish', async () => {
    const { calls, handler } = recordingHandler('a');
    const result = await runOnce(create, { toolHandler: handler }, BRANCHES);
    expect(result.success).toBe(true);
    expect(calls.map(([index, toolName, args]) => [index, toolName, (args as { name?: string }).name])).toEqual([
      [0, 'first', undefined],
      [1, 'second', undefined],
      [2, 'third', undefined],
      [3, 'head', 'a'],
      [4, 'head', 'b'],
      [5, 'tail', 'b'],
      [6, 'tail', 'a'],
    ]);
  });

  it('gives the review hooks the same callIndex as the handler', async () => {
    const reviewed: number[] = [];
    const handled: number[] = [];
    const result = await runOnce(
      create,
      {
        toolHandler: async (_toolName, _args, call) => {
          handled.push(call.callIndex);
          return 1;
        },
        review: {
          pre: (input) => {
            if (input.phase === 'call') reviewed.push(input.callIndex);
            return { decision: 'allow' };
          },
        },
      },
      `await callTool('a', {}); await ${parallel('[1, 2]', "(n) => callTool('b', { n })")}; return 0;`,
    );
    expect(result.success).toBe(true);
    expect(handled).toEqual([0, 1, 2]);
    expect(reviewed).toEqual(handled);
    expect(result.review?.decisions.filter((d) => d.phase === 'call').map((d) => d.callIndex)).toEqual([0, 1, 2]);
  });

  it('reads Date and Math.random from the host at every read', async () => {
    let now = 1_700_000_000_000;
    const result = await runOnce(
      create,
      { clock: () => (now += 1000), random: () => 0.25 },
      `
        const a = Date.now();
        const b = new Date().getTime();
        const c = Date();
        const d = new Date(0).getTime();
        return [a, b, typeof c, c === String(new Date(b + 1000)), d, Math.random(), new Date(1, 2).getMonth()];
      `,
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual([1_700_000_001_000, 1_700_000_002_000, 'string', true, 0, 0.25, 2]);
  });

  it('fails the read when the host clock or random source fails', async () => {
    const result = await runOnce(
      create,
      {
        clock: () => {
          throw new Error('broken clock');
        },
        random: () => 2,
      },
      `
        const errors = [];
        try { Date.now(); } catch (e) { errors.push(e.message); }
        try { Math.random(); } catch (e) { errors.push(e.message); }
        return errors;
      `,
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual(['The host clock failed', 'The host random source failed']);
  });

  it('makes the same calls in two runs that get the same clock, random and results', async () => {
    const code = `
      const seeds = await ${parallel(
        '[1, 2, 3]',
        `async (n) => {
          const seed = await callTool('seed', { n });
          return callTool('stamp', { n, seed, at: Date.now(), pick: Math.floor(Math.random() * 100) });
        }`,
      )};
      return await callTool('total', { seeds, at: new Date().toISOString() });
    `;
    const record = async (delays: number[], toolResultOrder: ToolResultOrder = 'call') => {
      const values = [1_000, 2_000, 3_000, 4_000];
      const randoms = [0.11, 0.52, 0.93];
      const calls: Array<[number, string, unknown]> = [];
      const result = await runOnce(
        create,
        {
          toolResultOrder,
          clock: () => values.shift() ?? 0,
          random: () => randoms.shift() ?? 0,
          toolHandler: async (toolName, args, call) => {
            calls.push([call.callIndex, toolName, args]);
            if (toolName === 'seed') await delay(delays[(args['n'] as number) - 1]);
            return toolName === 'total' ? 'done' : args['n'];
          },
        },
        code,
      );
      expect(result.success).toBe(true);
      return calls.sort((x, y) => x[0] - y[0]);
    };
    expect(await record([30, 0, 10])).toEqual(await record([0, 20, 5]));
    expect(await record([30, 0, 10], 'completion')).not.toEqual(await record([0, 20, 5], 'completion'));
  });
});

describe('call positions on the worker pool', () => {
  it('delivers results in call order across the thread boundary', async () => {
    const enclave = new Enclave({
      adapter: 'worker_threads',
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1 },
      toolResultOrder: 'call',
    });
    const code = `return await parallel(['a', 'b'], async (name) => {
      const head = await callTool('head', { name });
      return callTool('tail', { name, head });
    });`;
    try {
      const runs: string[][] = [];
      for (const slow of ['a', 'b']) {
        const calls: string[] = [];
        const result = await enclave.run(code, async (toolName, args, call) => {
          calls[call.callIndex] = `${toolName}:${String(args['name'])}`;
          if (toolName === 'head' && args['name'] === slow) await delay(30);
          return toolName;
        });
        expect(result.success).toBe(true);
        runs.push(calls);
      }
      expect(runs).toEqual([
        ['head:a', 'head:b', 'tail:a', 'tail:b'],
        ['head:a', 'head:b', 'tail:a', 'tail:b'],
      ]);
    } finally {
      enclave.dispose();
    }
  });
});

describe('call positions and the host clock, from the host side', () => {
  it('keeps a subclass of Date a subclass with a host clock', async () => {
    const enclave = new Enclave({ preset: 'standard', clock: () => 86_400_000 });
    try {
      const result = await enclave.run(`
        class Stamp extends Date {
          day() { return this.getTime() / 86400000; }
        }
        return [new Stamp().day(), new Stamp(0).day(), new Stamp() instanceof Stamp];
      `);
      expect(result.value).toEqual([1, 0, true]);
    } finally {
      enclave.dispose();
    }
  });

  it('delivers a result in call order as it was when the handler returned it', async () => {
    const shared = { n: 0 };
    const enclave = new Enclave({
      toolResultOrder: 'call',
      toolHandler: async (_toolName, args) => {
        if (args['name'] === 'slow') await delay(30);
        shared.n++;
        return shared;
      },
    });
    try {
      const result = await enclave.run(
        "return await parallel(['slow', 'fast'], async (name) => { const r = await callTool('t', { name }); return r.n; });",
      );
      expect(result.value).toEqual([2, 1]);
    } finally {
      enclave.dispose();
    }
  });

  it('refuses an ordered result over maxToolResultBytes when it settles, and delivers a failure as it was', async () => {
    const failure = new Error('first message');
    const enclave = new Enclave({
      toolResultOrder: 'call',
      toolHandler: async (_toolName, args) => {
        if (args['kind'] === 'large') return 'x'.repeat(5000);
        await delay(20);
        throw failure;
      },
    });
    try {
      const pending = enclave.run(
        `return await parallel(['slow', 'large'], async (kind) => {
          const r = await callTool('t', { kind }, { throwOnError: false });
          return r.success ? 'delivered' : [r.error.code, r.error.message];
        });`,
        undefined,
        { maxToolResultBytes: 1000 },
      );
      await delay(60);
      failure.message = 'changed later';
      expect((await pending).value).toEqual([
        ['TOOL_CALL_FAILED', 'first message'],
        ['TOOL_RESULT_TOO_LARGE', 'Tool result exceeds the limit of 1000 bytes'],
      ]);
    } finally {
      enclave.dispose();
    }
  });

  it('stores large results in the sidecar in call order, so the order decides which call meets a full sidecar', async () => {
    const enclave = new Enclave({
      toolResultOrder: 'call',
      sidecar: { enabled: true, extractionThreshold: 100, maxReferenceCount: 1 },
      toolHandler: async (_toolName, args) => {
        if (args['n'] === 0) await delay(40);
        return 'x'.repeat(200);
      },
    });
    try {
      const result = await enclave.run(`
        return await parallel([0, 1], async (n) => {
          const r = await callTool('t', { n }, { throwOnError: false });
          return r.success ? 'stored' : r.error.code;
        });
      `);
      expect(result.value).toEqual(['stored', 'TOOL_RESULT_NOT_STORED']);
    } finally {
      enclave.dispose();
    }
  });

  it('delivers the replies that wait as soon as the run is aborted', async () => {
    const abortController = new AbortController();
    let releaseFirst: (reply: string) => void = () => undefined;
    const bridge = inCallOrder(
      (request) =>
        request === 'first'
          ? new Promise<string>((resolve) => (releaseFirst = resolve))
          : Promise.resolve('second-reply'),
      abortController.signal,
      { maxHeldBytes: 1024, overflow: 'overflow', failed: 'failed' },
    );
    const first = bridge('first');
    const second = bridge('second');
    await delay(10);
    abortController.abort();
    await expect(second).resolves.toBe('second-reply');
    releaseFirst('first-reply');
    await expect(first).resolves.toBe('first-reply');
  });

  it('delivers the calls after one whose failure cannot be read, in call order', async () => {
    const unreadable = {
      get message(): string {
        throw new Error('no message');
      },
    };
    const enclave = new Enclave({
      toolResultOrder: 'call',
      toolHandler: async (toolName) => {
        if (toolName === 'broken') throw unreadable;
        return toolName;
      },
    });
    try {
      const result = await enclave.run(`
        let failed = false;
        try { await callTool('broken', {}); } catch (error) { failed = true; }
        return [failed, await callTool('after', {})];
      `);
      expect(result.value).toEqual([true, 'after']);
    } finally {
      enclave.dispose();
    }
  });

  it('fails a read of an async clock that rejects, and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    const enclave = new Enclave({ clock: (async () => Promise.reject(new Error('down'))) as never });
    try {
      const result = await enclave.run('try { return Date.now(); } catch (e) { return e.message; }');
      await delay(20);
      expect(result.value).toBe('The host clock failed');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
      enclave.dispose();
    }
  });

  it('records the callIndex the review saw, whatever the handler does to its ToolCall', async () => {
    const enclave = new Enclave({
      toolHandler: async (_toolName, _args, call) => {
        call.callIndex = 99;
        return 1;
      },
      review: { post: () => ({ action: 'pass' }) },
    });
    try {
      const result = await enclave.run("return await callTool('t', {});");
      expect(result.review?.decisions.map((decision) => decision.callIndex)).toEqual([0, undefined]);
    } finally {
      enclave.dispose();
    }
  });
});

describe('call position and clock options', () => {
  it('refuses a clock, a random source or an order of the wrong type', () => {
    expect(() => new Enclave({ clock: 5 as never })).toThrow('clock must be a function');
    expect(() => new PortableEnclave({ random: 'x' as never })).toThrow('random must be a function');
    expect(() => new Enclave({ toolResultOrder: 'arrival' as never })).toThrow('toolResultOrder must be one of');
    expect(
      () => new Enclave({ toolResultOrder: 'call', toolBridge: { mode: 'direct', acknowledgeInsecureDirect: true } }),
    ).toThrow("toolResultOrder: 'call' needs the string tool bridge");
  });

  it('refuses a clock for the worker_threads adapter, also given as a sandboxAdapter', () => {
    expect(() => new Enclave({ adapter: 'worker_threads', clock: () => 0 })).toThrow('cannot reach a worker thread');
    const pool = new WorkerPoolAdapter({ minWorkers: 0, maxWorkers: 1 }, 'STANDARD');
    try {
      expect(() => new Enclave({ sandboxAdapter: pool, random: () => 0 })).toThrow('cannot reach a worker thread');
    } finally {
      pool.dispose();
    }
  });
});
