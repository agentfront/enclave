// Security regression tests for the run_workflow execution path (the EXACT
// transform + interpreter + globals FrontMCP runs on the edge). Each test pins a
// previously-exploitable escape/DoS and asserts it is now contained. See the
// adversarial review that motivated these (prototype-pollution via legacy
// accessors, unmetered string allocation, await-past-timeout).
import { transformAgentScript } from '@enclave-vm/ast';

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import type { ExecutionContext, ToolHandler } from '../types';

const TRANSFORM = { transformLoops: false } as const;

function ctx(over: { toolHandler?: ToolHandler; timeout?: number; maxToolCalls?: number } = {}): ExecutionContext {
  return {
    config: { maxToolCalls: over.maxToolCalls ?? 25, timeout: over.timeout ?? 8000 },
    stats: { duration: 0, toolCallCount: 0, iterationCount: 0, startTime: 0 },
    abortController: new AbortController(),
    aborted: false,
    toolHandler: over.toolHandler,
  } as unknown as ExecutionContext;
}

const run = (script: string, over = {}) =>
  new InterpreterAdapter({ maxSteps: 2_000_000 }).execute(transformAgentScript(script, TRANSFORM), ctx(over));

describe('interpreter security — prototype pollution via legacy accessors (CRITICAL)', () => {
  for (const accessor of ['__lookupGetter__', '__defineGetter__', '__lookupSetter__', '__defineSetter__']) {
    it(`blocks ${accessor} (host-intrinsic reach)`, async () => {
      const res = await run(`const o = {}; return o.${accessor}('__proto__');`);
      expect(res.success).toBe(false);
      expect(res.error?.message).toMatch(/Forbidden property access/i);
    });
  }

  it('host Object.prototype is NOT polluted after an attempted escape', async () => {
    await run(
      `const o = {}; const p = o.__lookupGetter__('__proto__').call(o); p.__defineGetter__('__pwned__', Math.random); return 1;`,
    );
    expect(({} as Record<string, unknown>)['__pwned__']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('__pwned__')).toBe(false);
  });

  it('still blocks the classic constructor/proto trio', async () => {
    for (const s of [
      `return ({}).constructor;`,
      `return ({}).__proto__;`,
      `const k = 'constr'+'uctor'; return ({})[k];`,
    ]) {
      const res = await run(s);
      expect(res.success).toBe(false);
      expect(res.error?.message).toMatch(/Forbidden property/i);
    }
  });
});

describe('interpreter security — unmetered allocation DoS (HIGH)', () => {
  it('rejects String.repeat that would exceed the size cap', async () => {
    const res = await run(`return ('x').repeat(500000000).length;`);
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/repeat.*exceed|exceed.*limit/i);
  });
  it('rejects padStart/padEnd blowups', async () => {
    expect((await run(`return ('x').padStart(500000000,'y').length;`)).success).toBe(false);
    expect((await run(`return ('x').padEnd(500000000,'y').length;`)).success).toBe(false);
  });
  it('rejects a repeat blowup inside a loop on the FIRST iteration', async () => {
    const res = await run(`let t=0; let i=0; while(i<20){ t += ('x').repeat(50000000).length; i+=1; } return t;`);
    expect(res.success).toBe(false);
  });
  it('still allows reasonable string work', async () => {
    const res = await run(`return ('ab').repeat(1000).length;`);
    expect(res.success).toBe(true);
    expect(res.value).toBe(2000);
  });
});

describe('interpreter security — wall-clock timeout enforced across await (HIGH)', () => {
  it('returns a timeout (does not hang) when a tool call never settles', async () => {
    const neverSettles: ToolHandler = () => new Promise(() => {});
    const started = Date.now();
    const res = await run(`return await callTool('hang', {});`, { toolHandler: neverSettles, timeout: 500 });
    const elapsed = Date.now() - started;
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(elapsed).toBeLessThan(3000); // bounded by the 500ms deadline, not hung
  }, 8000);

  it('still bounds an infinite CPU loop via the step budget', async () => {
    const res = await new InterpreterAdapter({ maxSteps: 5000 }).execute(
      transformAgentScript('while (true) {}', TRANSFORM),
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('STEP_LIMIT_EXCEEDED');
  });
});
