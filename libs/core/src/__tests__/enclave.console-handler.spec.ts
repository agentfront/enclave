/**
 * consoleHandler: a script's console calls reach a host callback as (level, message) strings,
 * bounded by maxConsoleCalls / maxConsoleOutputBytes, without the script reaching the handler
 * or any host object through `console`.
 */

import { Enclave } from '../enclave';
import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { createConsoleSink, type ConsoleHandler, type ConsoleLevel } from '../console-handler';
import type { CreateEnclaveOptions, ExecutionContext, ExecutionResult, SandboxAdapter } from '../types';

type ConsoleCall = [ConsoleLevel, string];

function recordingHandler(): { calls: ConsoleCall[]; handler: ConsoleHandler } {
  const calls: ConsoleCall[] = [];
  return { calls, handler: (level, message) => void calls.push([level, message]) };
}

const HOST_CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function spyOnHostConsole(): { output: () => string; restore: () => void } {
  const spies = HOST_CONSOLE_METHODS.map((method) => jest.spyOn(console, method).mockImplementation(() => undefined));
  return {
    output: () => JSON.stringify(spies.map((spy) => spy.mock.calls)),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

const ADAPTERS: Array<[string, CreateEnclaveOptions]> = [
  ['double VM', {}],
  ['single VM', { doubleVm: { enabled: false } }],
  [
    'worker_threads',
    {
      adapter: 'worker_threads',
      doubleVm: { enabled: false },
      memoryLimit: 0,
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1, memoryLimitPerWorker: 0 },
    },
  ],
];

/** Script helper: whether a value leads to a Function constructor that can run code. */
const REACH_HELPER = `
  const reach = (value) => {
    try {
      const evaluated = value.constructor.constructor('return typeof process')();
      return evaluated === 'object' ? 'ESCAPED' : 'evaluated';
    } catch (e) {
      return 'blocked';
    }
  };
`;

describe.each(ADAPTERS)('consoleHandler (%s)', (_name, adapterOptions) => {
  jest.setTimeout(30000);

  let hostConsole: ReturnType<typeof spyOnHostConsole>;
  let enclave: Enclave | undefined;

  beforeEach(() => {
    hostConsole = spyOnHostConsole();
  });

  afterEach(() => {
    enclave?.dispose();
    enclave = undefined;
    hostConsole.restore();
  });

  function createEnclave(options: CreateEnclaveOptions): Enclave {
    enclave = new Enclave({ ...adapterOptions, ...options });
    return enclave;
  }

  it.each(['STRICT', 'SECURE', 'STANDARD', 'PERMISSIVE'] as const)(
    'routes every level to the handler as formatted strings at %s, not to the host console',
    async (securityLevel) => {
      const { calls, handler } = recordingHandler();
      const result = await createEnclave({ securityLevel, consoleHandler: handler }).run(`
        console.log('marker-log', 1, true, null, undefined, { a: [1, 'two'] });
        console.info('marker-info');
        console.warn('marker-warn');
        console.error('marker-error');
        console.debug('marker-debug');
        console.log();
        return 'done';
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toBe('done');
      expect(calls).toEqual([
        ['log', 'marker-log 1 true null undefined {"a":[1,"two"]}'],
        ['info', 'marker-info'],
        ['warn', 'marker-warn'],
        ['error', 'marker-error'],
        ['debug', 'marker-debug'],
        ['log', ''],
      ]);
      expect(hostConsole.output()).not.toContain('marker-');
    },
  );

  it('formats tool results and caught errors like any other value', async () => {
    const { calls, handler } = recordingHandler();
    const toolHandler = async (name: string) => {
      if (name === 'users:fail') throw new Error('tool failed');
      return { items: [{ id: 1 }, { id: 2 }] };
    };
    const result = await createEnclave({ consoleHandler: handler, toolHandler }).run(`
      const users = await callTool('users:list', {});
      console.log('users', users, users.items.length);
      try {
        await callTool('users:fail', {});
      } catch (e) {
        console.error('failed', e.message);
      }
      return 'done';
    `);

    expect(result.value).toBe('done');
    expect(calls).toEqual([
      ['log', 'users {"items":[{"id":1},{"id":2}]} 2'],
      ['error', expect.stringMatching(/^failed .*tool failed/)],
    ]);
  });

  it('ignores the handler return value and swallows what it throws', async () => {
    const handler = jest.fn(() => {
      throw new Error('host secret /etc/passwd');
    });
    const result = await createEnclave({ consoleHandler: handler }).run(`
      try {
        const returned = console.log('first');
        console.warn('second');
        return 'no-throw:' + typeof returned;
      } catch (e) {
        return 'threw';
      }
    `);

    expect(result.value).toBe('no-throw:undefined');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('host secret');
  });

  it('never hands a value the handler returns to the script', async () => {
    const consoleHandler = (() => ({ leaked: process })) as unknown as ConsoleHandler;
    const result = await createEnclave({ consoleHandler }).run(`
      return typeof console.log('x');
    `);

    expect(result.value).toBe('undefined');
  });

  it('swallows a rejected promise from an async handler', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const consoleHandler = (async () => {
        throw new Error('async failure');
      }) as ConsoleHandler;
      const result = await createEnclave({ consoleHandler }).run(`console.log('x'); return 'ok';`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.value).toBe('ok');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('applies maxConsoleCalls before the handler runs', async () => {
    const { calls, handler } = recordingHandler();
    const result = await createEnclave({ consoleHandler: handler, maxConsoleCalls: 2 }).run(`
      console.log('one');
      console.info('two');
      console.warn('three');
      return 'unreachable';
    `);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Console call limit exceeded');
    expect(calls).toEqual([
      ['log', 'one'],
      ['info', 'two'],
    ]);
  });

  it('applies maxConsoleOutputBytes before the handler runs', async () => {
    const { calls, handler } = recordingHandler();
    const result = await createEnclave({ consoleHandler: handler, maxConsoleOutputBytes: 8 }).run(`
      console.log('12345');
      console.log('67890');
      return 'unreachable';
    `);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Console output size limit exceeded');
    expect(calls).toEqual([['log', '12345']]);
  });

  it('gives each run its own console and its own limits', async () => {
    const { calls, handler } = recordingHandler();
    const shared = createEnclave({ consoleHandler: handler, maxConsoleCalls: 1, validate: false });

    const first = await shared.run(`try { console.log = () => {}; } catch (e) {} console.log('run-1'); return 1;`);
    const second = await shared.run(`console.log('run-2'); return 2;`);

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(calls).toEqual([
      ['log', 'run-1'],
      ['log', 'run-2'],
    ]);
  });

  describe('isolation (runtime, validation off)', () => {
    function runUnvalidated(code: string, options: CreateEnclaveOptions = {}): Promise<ExecutionResult> {
      const { handler } = recordingHandler();
      return createEnclave({ consoleHandler: handler, validate: false, ...options }).run(REACH_HELPER + code);
    }

    it('does not reach a working Function constructor through a console method', async () => {
      const result = await runUnvalidated(`
        return [reach(console.log), reach(console), reach(console.log.call), reach(console.log.bind(null))];
      `);

      expect(result.value).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
    });

    it('exposes a frozen, null-prototype console', async () => {
      const result = await runUnvalidated(`
        try { console.log = () => 'hijacked'; } catch (e) {}
        try { console.extra = 1; } catch (e) {}
        return {
          proto: Object.getPrototypeOf(console) === null,
          dunderProto: typeof console.__proto__,
          frozen: Object.isFrozen(console),
          keys: Object.keys(console),
          logStillWorks: console.log('after') === undefined,
          extra: typeof console.extra,
        };
      `);

      expect(result.value).toEqual({
        proto: true,
        dunderProto: 'undefined',
        frozen: true,
        keys: ['log', 'info', 'warn', 'error', 'debug'],
        logStillWorks: true,
        extra: 'undefined',
      });
    });

    it('supports call/apply/bind on console methods and still routes to the handler', async () => {
      const { calls, handler } = recordingHandler();
      const result = await createEnclave({ consoleHandler: handler, validate: false }).run(`
        console.log.call(null, 'via-call');
        console.warn.apply(undefined, ['via-apply', 2]);
        console.error.bind(null, 'via-bind')();
        return 'ok';
      `);

      expect(result.value).toBe('ok');
      expect(calls).toEqual([
        ['log', 'via-call'],
        ['warn', 'via-apply 2'],
        ['error', 'via-bind'],
      ]);
    });

    it('runs argument getters in the sandbox and passes only the resulting string', async () => {
      const { calls, handler } = recordingHandler();
      const result = await createEnclave({ consoleHandler: handler, validate: false }).run(`
        const withGetter = { get secret() { return 'from-getter'; } };
        console.log(withGetter);
        return 'ok';
      `);

      expect(result.value).toBe('ok');
      expect(calls).toEqual([['log', '{"secret":"from-getter"}']]);
    });

    it('surfaces formatting errors as sandbox errors, never host errors', async () => {
      const { calls, handler } = recordingHandler();
      const result = await createEnclave({ consoleHandler: handler, validate: false }).run(
        REACH_HELPER +
          `
        const outcomes = [];
        const unprintable = { toJSON() { throw 1; }, toString() { return {}; }, valueOf() { return {}; } };
        try { console.log(unprintable); outcomes.push('printed'); } catch (e) { outcomes.push(reach(e)); }
        const throwingToString = { toJSON() { throw 1; }, toString() { throw 'own error'; } };
        try { console.log(throwingToString); } catch (e) { outcomes.push(e); }
        return outcomes;
      `,
      );

      expect(result.value).toEqual(['blocked', 'own error']);
      expect(calls).toEqual([]);
    });

    it('does not expose host bridges on the sandbox global', async () => {
      const result = await runUnvalidated(`
        const sandboxGlobal = this;
        return Object.getOwnPropertyNames(sandboxGlobal).filter((name) => /host|sink|handler/i.test(name));
      `);

      expect(result.value).toEqual([]);
    });
  });
});

describe('consoleHandler validation', () => {
  it('refuses console without a handler outside PERMISSIVE (unchanged)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD' });
    const result = await enclave.run(`console.log('x'); return 1;`);
    enclave.dispose();

    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('UNKNOWN_GLOBAL');
  });

  it('allows console with a handler under the babel preset', async () => {
    const { calls, handler } = recordingHandler();
    const enclave = new Enclave({ securityLevel: 'STRICT', preset: 'babel', consoleHandler: handler });
    const result = await enclave.run(`console.info('from-babel'); return 1;`);
    enclave.dispose();

    expect(result.value).toBe(1);
    expect(calls).toEqual([['info', 'from-babel']]);
  });

  it('rejects a consoleHandler that is not a function', () => {
    expect(() => new Enclave({ consoleHandler: 'log' as unknown as ConsoleHandler })).toThrow(TypeError);
  });

  it('rejects a consoleHandler combined with a console global', () => {
    expect(
      () =>
        new Enclave({ consoleHandler: () => undefined, globals: { console: { log: 1 } }, securityLevel: 'PERMISSIVE' }),
    ).toThrow(/consoleHandler/);
  });
});

describe('without consoleHandler (unchanged)', () => {
  let hostConsole: ReturnType<typeof spyOnHostConsole>;

  beforeEach(() => {
    hostConsole = spyOnHostConsole();
  });

  afterEach(() => hostConsole.restore());

  it.each([
    ['double VM', {}],
    ['single VM', { doubleVm: { enabled: false } }],
  ] as Array<[string, CreateEnclaveOptions]>)(
    'PERMISSIVE writes to the host console and has no console.debug (%s)',
    async (_name, adapterOptions) => {
      const enclave = new Enclave({ ...adapterOptions, securityLevel: 'PERMISSIVE' });
      const result = await enclave.run(`
        console.log('unchanged', { a: 1 });
        return typeof console.debug;
      `);
      enclave.dispose();

      expect(result.value).toBe('undefined');
      expect(console.log).toHaveBeenCalledWith('unchanged {"a":1}');
    },
  );
});

describe('consoleHandler with a sandboxAdapter', () => {
  it('hands the handler to a custom adapter through the execution context', async () => {
    const handler: ConsoleHandler = () => undefined;
    let received: ExecutionContext | undefined;
    const adapter: SandboxAdapter = {
      async execute<T>(_code: string, context: ExecutionContext): Promise<ExecutionResult<T>> {
        received = context;
        return { success: true, value: undefined as T, stats: context.stats };
      },
      dispose: () => undefined,
    };
    const enclave = new Enclave({ sandboxAdapter: adapter, consoleHandler: handler });
    await enclave.run(`console.log('x'); return 1;`);
    enclave.dispose();

    expect(received?.consoleHandler).toBe(handler);
  });

  it('InterpreterAdapter has no console: a script that logs fails without calling the handler', async () => {
    const { calls, handler } = recordingHandler();
    const enclave = new Enclave({ sandboxAdapter: new InterpreterAdapter(), consoleHandler: handler });
    const result = await enclave.run(`console.log('x'); return 1;`);
    enclave.dispose();

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("'__safe_console' is not defined");
    expect(calls).toEqual([]);
  });
});

describe('createConsoleSink', () => {
  const limits = { maxConsoleCalls: 2, maxConsoleOutputBytes: 10 };

  it('passes known levels and string messages to the handler, within the limits', () => {
    const { calls, handler } = recordingHandler();
    const sink = createConsoleSink(handler, limits);

    sink('log', 'one');
    sink('trace', 'unknown level');
    sink('info', { toString: () => 'object' });
    sink('warn', 'two');
    sink('error', 'over the call limit');

    expect(calls).toEqual([
      ['log', 'one'],
      ['warn', 'two'],
    ]);
  });

  it('stops at maxConsoleOutputBytes', () => {
    const { calls, handler } = recordingHandler();
    const sink = createConsoleSink(handler, { maxConsoleCalls: 10, maxConsoleOutputBytes: 10 });

    sink('log', '123456');
    sink('log', '7890x');
    sink('log', 'y');

    expect(calls).toEqual([['log', '123456']]);
  });

  it('returns undefined and never throws, whatever the handler does', () => {
    const throwing = createConsoleSink(() => {
      throw new Error('boom');
    }, limits);
    const returning = createConsoleSink((() => ({ host: true })) as unknown as ConsoleHandler, limits);

    expect(throwing('log', 'x')).toBeUndefined();
    expect(returning('log', 'x')).toBeUndefined();
  });
});
