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
