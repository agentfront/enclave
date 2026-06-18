// file: libs/core/src/__tests__/interpreter-transform-integration.spec.ts
//
// Integration coverage for the WORKER-SAFE execute path: pair the AgentScript
// transformer (`@enclave-vm/ast`) with the dependency-free `InterpreterAdapter`
// (no QuickJS / WASM / node:vm). This is the exact path FrontMCP runs on
// Cloudflare Workers for its `codecall` tool.
//
// Contract under test: the transformer must be invoked with
// `{ transformLoops: false }` for the interpreter target. The interpreter is
// secure-by-construction and enforces its OWN step budget (`maxSteps` via
// `tick()`), so the transformer's loop-rewrite helpers (`__safe_forOf`,
// `__safe_for`, `__safe_while`) are both redundant AND undefined in the
// interpreter's global scope. Leaving them in throws
// `'__safe_forOf' is not defined` at runtime.

import { transformAgentScript } from '@enclave-vm/ast';

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import type { ExecutionContext, ToolHandler } from '../types';

/** The transform config required for the interpreter target. */
const INTERPRETER_TRANSFORM = { transformLoops: false } as const;

function makeContext(toolHandler?: ToolHandler, overrides: { maxToolCalls?: number; timeout?: number } = {}): ExecutionContext {
  return {
    config: { maxToolCalls: overrides.maxToolCalls ?? 20, timeout: overrides.timeout ?? 8000 },
    stats: { duration: 0, toolCallCount: 0, iterationCount: 0, startTime: 0 },
    abortController: new AbortController(),
    aborted: false,
    toolHandler,
  } as unknown as ExecutionContext;
}

describe('AgentScript transform + Interpreter (worker codecall path)', () => {
  const handler: ToolHandler = async (name, args) => {
    const id = args['id'] as number;
    if (name === 'getTodo') return { id, done: id % 2 === 1 };
    if (name === 'add') return (args['a'] as number) + (args['b'] as number);
    throw new Error(`unknown tool: ${name}`);
  };

  it('runs untransformed user AgentScript (callTool + for-of) end-to-end', async () => {
    const script = `
      const ids = [1, 2, 3];
      let total = 0;
      for (const id of ids) {
        const t = await callTool('getTodo', { id });
        if (t.done) total += 1;
      }
      const sum = await callTool('add', { a: total, b: 100 });
      return { checked: ids.length, doneCount: total, sum };
    `;
    const transformed = transformAgentScript(script, INTERPRETER_TRANSFORM);
    const res = await new InterpreterAdapter().execute(transformed, makeContext(handler));
    expect(res.success).toBe(true);
    expect(res.value).toEqual({ checked: 3, doneCount: 2, sum: 102 });
    expect(res.stats.toolCallCount).toBe(4);
  });

  it('the transformer still rewrites callTool → __safe_callTool', async () => {
    const transformed = transformAgentScript("return await callTool('add', { a: 1, b: 2 });", INTERPRETER_TRANSFORM);
    expect(transformed).toContain('__safe_callTool');
    expect(transformed).toContain('__ag_main');
    const res = await new InterpreterAdapter().execute(transformed, makeContext(handler));
    expect(res.success).toBe(true);
    expect(res.value).toBe(3);
  });

  it('bounds an infinite loop via the interpreter step budget (no loop-guard helper needed)', async () => {
    const transformed = transformAgentScript('while (true) {}', INTERPRETER_TRANSFORM);
    const res = await new InterpreterAdapter({ maxSteps: 5_000 }).execute(transformed, makeContext(handler));
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('STEP_LIMIT_EXCEEDED');
  });

  it('blocks prototype-escape regardless of transform (secure by construction)', async () => {
    const transformed = transformAgentScript("return ({}).constructor.constructor('return 1')();", INTERPRETER_TRANSFORM);
    const res = await new InterpreterAdapter().execute(transformed, makeContext(handler));
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/constructor/i);
  });

  it('enforces maxToolCalls across transformed code', async () => {
    const script = `
      let n = 0;
      for (const id of [1, 2, 3, 4, 5]) { n += await callTool('add', { a: 1, b: 0 }); }
      return n;
    `;
    const transformed = transformAgentScript(script, INTERPRETER_TRANSFORM);
    const res = await new InterpreterAdapter().execute(transformed, makeContext(handler, { maxToolCalls: 2 }));
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/tool call limit/i);
  });
});
