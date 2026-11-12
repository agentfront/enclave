import { InterpreterAdapter } from '../interpreter-adapter';
import type { ExecutionContext, ToolHandler } from '../../types';

/** Minimal ExecutionContext for the fields the adapter reads. */
function makeContext(
  overrides: { maxToolCalls?: number; timeout?: number; toolHandler?: ToolHandler } = {},
): ExecutionContext {
  return {
    config: {
      maxToolCalls: overrides.maxToolCalls ?? 50,
      timeout: overrides.timeout ?? 5000,
    },
    stats: { duration: 0, toolCallCount: 0, iterationCount: 0, startTime: 0 },
    abortController: new AbortController(),
    aborted: false,
    toolHandler: overrides.toolHandler,
  } as unknown as ExecutionContext;
}

/** The transformer wraps code in `async function __ag_main()`. */
const main = (body: string): string => `async function __ag_main() {\n${body}\n}`;

describe('InterpreterAdapter (SandboxAdapter)', () => {
  const adapter = new InterpreterAdapter();

  it('executes transformed AgentScript and returns success + value + stats', async () => {
    const res = await adapter.execute(main('return [1,2,3].map((n) => n * 2);'), makeContext());
    expect(res.success).toBe(true);
    expect(res.value).toEqual([2, 4, 6]);
    expect(res.stats.toolCallCount).toBe(0);
    expect(res.stats.iterationCount).toBeGreaterThan(0);
    expect(res.stats.duration).toBeGreaterThanOrEqual(0);
  });

  it('returns a value of more than 100 items when the context sets no sanitize limits', async () => {
    // Without an Enclave nothing sets maxSanitizeProperties: the limit is the sanitizer's own
    // default, as with the double VM, not a smaller one of this adapter.
    const res = await adapter.execute(
      main('const items = []; for (let i = 0; i < 500; i++) { items.push(i); } return items;'),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect((res.value as number[]).length).toBe(500);
  });

  it('runs a full parallel batch whose tasks call a helper that awaits a tool', async () => {
    // 100 tasks, each two calls deep while it waits: the batch must not use up the call depth
    const res = await adapter.execute(
      main(`
        const double = async (n) => { const reply = await __safe_callTool('double', { n }); return reply.value; };
        const items = [];
        for (let i = 0; i < 100; i++) { items.push(i); }
        const results = await __safe_parallel(items, (n) => double(n));
        return [results.length, results[99]];
      `),
      makeContext({ maxToolCalls: 200, toolHandler: async (_name, args) => ({ value: (args['n'] as number) * 2 }) }),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([100, 198]);
  });

  it('counts the call depth along each chain: the tasks of a batch do not add up', async () => {
    // 100 tasks, each 12 calls deep while it waits for its tool: 1,200 calls in progress, with a
    // call depth of 20. One chain that nests deeper than 20 is still refused.
    const shallow = new InterpreterAdapter({ maxCallDepth: 20 });
    const down = `const down = async (n, left) => {
      if (left === 0) { const reply = await __safe_callTool('echo', { n }); return reply.value; }
      return down(n, left - 1);
    };`;
    const toolHandler: ToolHandler = async (_name, args) => ({ value: args['n'] });

    const batch = await shallow.execute(
      main(`${down}
        const items = [];
        for (let i = 0; i < 100; i++) { items.push(i); }
        const results = await __safe_parallel(items, (n) => down(n, 10));
        return [results.length, results[99]];`),
      makeContext({ maxToolCalls: 200, toolHandler }),
    );
    expect(batch.error).toBeUndefined();
    expect(batch.value).toEqual([100, 99]);

    const deep = await shallow.execute(main(`${down} return down(1, 30);`), makeContext({ toolHandler }));
    expect(deep.success).toBe(false);
    expect(deep.error?.message).toContain('Max call depth exceeded (20)');
  });

  it.each([
    ['the callback of an array method', 'const rec = (n) => [n].map((m) => rec(m + 1))[0]; return rec(0);'],
    ['a bound function', 'const rec = (n) => { const again = rec.bind(null, n + 1); return again(); }; return rec(0);'],
    [
      'a task of parallel',
      'const rec = async (n) => (await __safe_parallel([n], (m) => rec(m + 1)))[0]; return rec(0);',
    ],
  ])('keeps one chain through %s: the recursion ends at the call depth', async (_name, body) => {
    // A callback is a call of the function that invokes it, one call deeper
    const res = await new InterpreterAdapter({ maxCallDepth: 20 }).execute(main(body), makeContext());

    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('Max call depth exceeded (20)');
  });

  it('bounds the calls in progress over all chains with maxPendingCalls', async () => {
    const script = main(`
      const items = [];
      for (let i = 0; i < 100; i++) { items.push(i); }
      const results = await __safe_parallel(items, async (n) => (await __safe_callTool('echo', { n })).value);
      return results.length;`);
    const toolHandler: ToolHandler = async (_name, args) => ({ value: args['n'] });

    // Each task is a call that waits for a tool call: about 200 calls in progress
    const refused = await new InterpreterAdapter({ maxPendingCalls: 50 }).execute(
      script,
      makeContext({ maxToolCalls: 200, toolHandler }),
    );
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('Too many calls in progress at once (50)');

    const allowed = await new InterpreterAdapter().execute(script, makeContext({ maxToolCalls: 200, toolHandler }));
    expect(allowed.error).toBeUndefined();
    expect(allowed.value).toBe(100);
  });

  it('accepts a Math function as the callback of map on a large array', async () => {
    // floor is handed (item, index, array) and reads the item only
    const res = await new InterpreterAdapter({ maxSteps: 10_000_000 }).execute(
      main('return new Array(520000).fill(1.5).map(Math.floor).length;'),
      makeContext({ timeout: 20000 }),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toBe(520000);
  });

  it('routes tool calls to the toolHandler and counts them', async () => {
    const calls: string[] = [];
    const toolHandler: ToolHandler = async (name) => {
      calls.push(name);
      return { ok: true };
    };
    const res = await adapter.execute(
      main("const r = await __safe_callTool('billing:charge', { amount: 10 }); return r.ok;"),
      makeContext({ toolHandler }),
    );
    expect(res.success).toBe(true);
    expect(res.value).toBe(true);
    expect(calls).toEqual(['billing:charge']);
    expect(res.stats.toolCallCount).toBe(1);
  });

  it('enforces maxToolCalls', async () => {
    const toolHandler: ToolHandler = async () => 1;
    const res = await adapter.execute(
      main('for (const n of [1,2,3]) { await __safe_callTool("t", {}); } return 1;'),
      makeContext({ toolHandler, maxToolCalls: 2 }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/Tool call limit/i);
    expect(res.stats.toolCallCount).toBe(3); // attempted the 3rd, which threw
  });

  it('fails (not hangs) on an infinite loop via the step budget', async () => {
    const small = new InterpreterAdapter({ maxSteps: 5_000 });
    const res = await small.execute(main('while (true) {}'), makeContext());
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('STEP_LIMIT_EXCEEDED');
  });

  it('ends a script that only computes at its timeout', async () => {
    // The step budget alone would let this run on: the interpreter reads the clock itself
    const res = await new InterpreterAdapter({ maxSteps: 50_000_000 }).execute(
      main('let n = 0; while (true) { n = n + 1; }'),
      makeContext({ timeout: 100 }),
    );

    expect(res.success).toBe(false);
    expect(res.error?.name).toBe('TimeoutError');
    expect(res.error?.code).toBe('EXECUTION_TIMEOUT');
  });

  it('counts the work of a built-in by what it reads, not by the size of the value it is called on', async () => {
    // A million chars: a search goes through them, reading one char does not
    const steps = async (body: string): Promise<number> => {
      const res = await adapter.execute(main(`const text = 'x'.repeat(1000000); ${body}`), makeContext());
      expect(res.error).toBeUndefined();
      return res.stats.iterationCount;
    };
    const loop = (call: string): string =>
      `let n = 0; for (let i = 0; i < 1000; i++) { if (${call}) { n = n + 1; } } return n;`;

    const reading = await steps(loop('text.charCodeAt(i) === 120'));
    const searching = await steps(loop("text.includes('y')"));

    expect(searching - reading).toBeGreaterThan(50_000);
    expect(reading).toBeLessThan(20_000);
  });

  it('goes through iterators in loops, spreads and destructuring, and steps one with next', async () => {
    const res = await adapter.execute(
      main(`
        const seen = [];
        for (const [index, value] of ['a', 'b'].entries()) { seen.push(index + value); }
        const [first, second] = ['x', 'y'].values();
        const step = [7].values().next();
        return [seen, [...['a', 'b'].keys()], first + second, step.value, step.done];
      `),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([['0a', '1b'], [0, 1], 'xy', 7, false]);
  });

  it('calls the methods of the values a script holds, each on its own kind of value', async () => {
    const res = await adapter.execute(
      main(`
        const date = new Date(86400000);
        return [(3.14159).toFixed(2), (255).toString(16), true.toString(), (10n).toString(), date.getTime(),
                date.toISOString(), ({ a: 1 }).hasOwnProperty('a'), [1, [2, 3]].toString(), 'abc'.at(-1)];
      `),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual(['3.14', 'ff', 'true', '10', 86400000, '1970-01-02T00:00:00.000Z', true, '1,2,3', 'c']);
  });

  it('does not store a function under a name the engine calls by itself', async () => {
    for (const name of ['then', 'toString', 'valueOf', 'toJSON']) {
      const refused = await adapter.execute(main(`const o = { ${name}: () => 1 }; return 1;`), makeContext());

      expect(refused.success).toBe(false);
      expect(refused.error?.message).toContain(`A function cannot be stored under '${name}'`);
    }

    // Data under those names, functions under other names and the inherited conversions work
    const res = await adapter.execute(
      main(`
        const o = { then: 1, toString: 'text', format: (x) => 'f' + x };
        const plain = { a: 1 };
        return [o.then, o.toString, o.format(1), '' + plain, plain.toString(), String([1, 2])];
      `),
      makeContext(),
    );
    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([1, 'text', 'f1', '[object Object]', '[object Object]', '1,2']);
  });

  it('answers a search over a long text as the engine does', async () => {
    // Long enough for the interpreter to make the search in pieces
    const text = 'ab'.repeat(100000) + 'needle' + 'cd'.repeat(50000) + 'needle';
    const pattern = 'b' + 'needle' + 'cd'.repeat(197);
    const res = await adapter.execute(
      main(`
        const text = 'ab'.repeat(100000) + 'needle' + 'cd'.repeat(50000) + 'needle';
        const pattern = 'b' + 'needle' + 'cd'.repeat(197);
        const absent = 'ab'.repeat(200) + 'x';
        return [text.indexOf(pattern), text.indexOf(pattern, 200000), text.lastIndexOf(pattern), text.lastIndexOf(absent),
                text.includes(pattern), text.includes(absent), text.split(pattern).length, text.split(absent).length,
                text.replace(pattern, '<$&>').length, text.replaceAll(pattern, '').length, text.replace(absent, '').length];
      `),
      makeContext(),
    );
    const absent = 'ab'.repeat(200) + 'x';

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([
      text.indexOf(pattern),
      text.indexOf(pattern, 200000),
      text.lastIndexOf(pattern),
      text.lastIndexOf(absent),
      text.includes(pattern),
      text.includes(absent),
      text.split(pattern).length,
      text.split(absent).length,
      text.replace(pattern, '<$&>').length,
      text.replaceAll(pattern, '').length,
      text.replace(absent, '').length,
    ]);
  });

  it('normalizes and encodes long texts that stay within the longest text a script may make', async () => {
    // Three million letters: nine times as long in the worst case of an encoding, but letters stay as they are
    const res = await adapter.execute(
      main(`
        const part = 'abc'.repeat(333333);
        const text = part + part + part;
        return [encodeURIComponent(text).length, encodeURI(text + ' ').length, text.normalize('NFKC').length];
      `),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([2999997, 3000000, 2999997]);
  });

  it('writes the locale text of an array as the engine does', async () => {
    const res = await adapter.execute(
      main(`return [[1234.5, 'a', null, [2, [3000]]].toLocaleString('en-US'),
                    [1234.5, 6].toLocaleString('de-DE', { minimumFractionDigits: 2 }), [].toLocaleString()];`),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([
      [1234.5, 'a', null, [2, [3000]]].toLocaleString('en-US'),
      [1234.5, 6].toLocaleString('de-DE', { minimumFractionDigits: 2 }),
      '',
    ]);
  });

  it('charges a text that grows in a loop for what is appended', async () => {
    // The intermediate texts add up to tens of megabytes; what is appended to about 70 KB
    const res = await new InterpreterAdapter({ maxAllocationBytes: 1024 * 1024 }).execute(
      main(`
        let report = '';
        for (let i = 0; i < 3000; i++) {
          if (report.length > 0) { report += ', '; }
          report += 'item ' + i;
        }
        return report.length;
      `),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toBe(Array.from({ length: 3000 }, (_, i) => 'item ' + i).join(', ').length);
  });

  it('computes with BigInt values up to the size a BigInt may have', async () => {
    const res = await adapter.execute(
      main(`
        const a = 12345678901234567890n;
        let factorial = 1n;
        for (let i = 1n; i <= 30n; i = i + 1n) { factorial = factorial * i; }
        return [String(a * a), String(factorial), String(2n ** 200n), typeof (1n << 1000000n)];
      `),
      makeContext(),
    );

    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([
      String(12345678901234567890n * 12345678901234567890n),
      '265252859812191058636308480000000',
      String(2n ** 200n),
      'bigint',
    ]);

    const tooLarge = await adapter.execute(main('return typeof (1n << 2000000n);'), makeContext());
    expect(tooLarge.success).toBe(false);
    expect(tooLarge.error?.message).toContain('A BigInt cannot be larger than 1048576 bits');
  });

  it('reports a syntax error as a failed result', async () => {
    const res = await adapter.execute('this is not valid )(', makeContext());
    expect(res.success).toBe(false);
    expect(res.error?.name).toBe('SyntaxError');
  });

  it('fails cleanly when no toolHandler is configured', async () => {
    const res = await adapter.execute(main("return await __safe_callTool('x', {});"), makeContext());
    expect(res.success).toBe(false);
    // The same message as the VM adapters give.
    expect(res.error?.message).toBe('No tool handler configured. Cannot execute tool calls.');
  });
});
