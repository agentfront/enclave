import { AgentScriptRunner, PortableEnclave } from '../portable-enclave';

describe('PortableEnclave AgentScript', () => {
  it('runs a regular AgentScript calculation', async () => {
    const enclave = new PortableEnclave();
    try {
      const result = await enclave.run('let total = 0; for (const value of [2, 3, 5]) total += value; return total;');
      expect(result.success).toBe(true);
      expect(result.value).toBe(10);
    } finally {
      enclave.dispose();
    }
  });

  it('copies arguments and results across the tool bridge', async () => {
    const enclave = new PortableEnclave();
    const handler = jest.fn(async (_name: string, args: Record<string, unknown>) => ({ total: Number(args['a']) + 4 }));
    try {
      const result = await enclave.run("return await callTool('add', { a: 3 });", handler);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ total: 7 });
      expect(result.stats.toolCallCount).toBe(1);
      expect(handler).toHaveBeenCalledWith('add', { a: 3 });
    } finally {
      enclave.dispose();
    }
  });

  it('exposes bounded host functions and plain data', async () => {
    const enclave = new PortableEnclave({
      allowFunctionsInGlobals: true,
      globals: { lookup: (key: string) => ({ key, value: 8 }), settings: { multiplier: 2 } },
    });
    try {
      const result = await enclave.run("const item = lookup('a'); return item.value * settings.multiplier;");
      expect(result.success).toBe(true);
      expect(result.value).toBe(16);
    } finally {
      enclave.dispose();
    }
  });

  it('can run a second script after the first', async () => {
    const enclave = new PortableEnclave();
    try {
      expect((await enclave.run('return 1;')).value).toBe(1);
      expect((await enclave.run('return 2;')).value).toBe(2);
    } finally {
      enclave.dispose();
    }
  });

  it('provides the worker entry contract used by CodeCall', async () => {
    const runner = new AgentScriptRunner({
      securityLevel: 'STANDARD',
      timeout: 1000,
      maxToolCalls: 2,
      maxIterations: 100,
      maxSteps: 100_000,
      maxHostFunctionCalls: 20,
      hostFunctions: { lookup: (name: string) => ({ name }) },
    });
    try {
      expect(AgentScriptRunner.capabilities).toContain('validated-agentscript');
      const result = await runner.run("return lookup('item').name;");
      expect(result.success).toBe(true);
      expect(result.value).toBe('item');
    } finally {
      runner.dispose();
    }
  });
});
