import { InterpreterAdapter } from '../interpreter-adapter';
import type { ExecutionContext, ToolHandler } from '../../types';

/** Minimal ExecutionContext for the fields the adapter reads. */
function makeContext(overrides: { maxToolCalls?: number; timeout?: number; toolHandler?: ToolHandler } = {}): ExecutionContext {
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
    expect(res.error?.message).toMatch(/toolHandler/i);
  });
});
