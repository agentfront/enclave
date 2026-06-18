import * as acorn from 'acorn';
import type * as ESTree from 'estree';

import { Interpreter, InterpreterError, StepLimitError } from '../interpreter';

/** Parse AgentScript-shaped source and run it through the interpreter. */
async function run(
  source: string,
  globals: Record<string, unknown> = {},
  opts: { maxSteps?: number; maxCallDepth?: number } = {},
): Promise<unknown> {
  const program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as ESTree.Program;
  const interp = new Interpreter({
    globals: { Math, JSON, ...globals },
    maxSteps: opts.maxSteps ?? 100_000,
    maxCallDepth: opts.maxCallDepth ?? 100,
  });
  return interp.run(program);
}

/** Wrap a body in the `async function __ag_main()` the transformer produces. */
const main = (body: string): string => `async function __ag_main() {\n${body}\n}`;

describe('AgentScript interpreter — semantics', () => {
  it('evaluates arithmetic and returns a value', async () => {
    expect(await run(main('return 2 + 40 * 1;'))).toBe(42);
  });

  it('supports const/let, blocks, and if/else', async () => {
    const out = await run(
      main(`
        let total = 0;
        const items = [1, 2, 3, 4];
        for (const n of items) { if (n % 2 === 0) { total += n; } }
        return total;
      `),
    );
    expect(out).toBe(6);
  });

  it('supports array methods via arrow functions', async () => {
    const out = await run(main('return [1,2,3,4].filter((n) => n > 2).map((n) => n * 10);'));
    expect(out).toEqual([30, 40]);
  });

  it('supports template literals + Math/JSON globals', async () => {
    const out = await run(main('return `max=${Math.max(1, 9, 4)}|${JSON.stringify({ a: 1 })}`;'));
    expect(out).toBe('max=9|{"a":1}');
  });

  it('awaits async tool calls (__safe_callTool) and uses the result', async () => {
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    const __safe_callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      toolCalls.push({ name, args });
      if (name === 'users:list') return [{ id: 1 }, { id: 2 }];
      return null;
    };
    const out = await run(
      main(`
        const users = await __safe_callTool('users:list', {});
        return users.length;
      `),
      { __safe_callTool },
    );
    expect(out).toBe(2);
    expect(toolCalls).toEqual([{ name: 'users:list', args: {} }]);
  });

  it('enforces const immutability', async () => {
    await expect(run(main('const x = 1; x = 2; return x;'))).rejects.toThrow(/constant/i);
  });
});

describe('AgentScript interpreter — security boundary', () => {
  it('throws on unknown/undeclared identifiers (no ambient host globals)', async () => {
    await expect(run(main('return process;'))).rejects.toBeInstanceOf(InterpreterError);
    await expect(run(main('return globalThis;'))).rejects.toBeInstanceOf(InterpreterError);
    await expect(run(main('return Function;'))).rejects.toBeInstanceOf(InterpreterError);
  });

  it('blocks the prototype-escape keys (constructor / __proto__ / prototype)', async () => {
    await expect(run(main('return [].constructor;'))).rejects.toThrow(/Forbidden/);
    await expect(run(main("return ({})['__proto__'];"))).rejects.toThrow(/Forbidden/);
    await expect(run(main('return ([]).constructor.constructor("return 1")();'))).rejects.toThrow(/Forbidden/);
  });

  it('does not leak the host realm through array/object intrinsics', async () => {
    // The classic escape: ([]).constructor.constructor('return process')() — blocked above.
    // Confirm a plain method call stays in-sandbox and returns data only.
    const out = await run(main('return [3,1,2].slice().sort((a,b)=>a-b);'));
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('AgentScript interpreter — resource limits', () => {
  it('interrupts an infinite loop via the step budget', async () => {
    await expect(run(main('while (true) {}'), {}, { maxSteps: 5_000 })).rejects.toBeInstanceOf(StepLimitError);
  });

  it('interrupts deep/runaway recursion via call depth', async () => {
    await expect(
      run(main('function rec(n){ return rec(n+1); } return rec(0);'), {}, { maxCallDepth: 50 }),
    ).rejects.toThrow(/call depth/i);
  });
});
