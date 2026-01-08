import { Enclave } from '../enclave';

describe('Tool Bridge', () => {
  it('should require acknowledgement for toolBridge.mode=direct', () => {
    expect(() => new Enclave({ toolBridge: { mode: 'direct' } })).toThrow(/acknowledgeInsecureDirect/i);
  });

  it('should allow toolBridge.mode=direct when acknowledged', async () => {
    const enclave = new Enclave({
      toolBridge: { mode: 'direct', acknowledgeInsecureDirect: true },
      toolHandler: async () => ({ ok: true }),
    });

    const result = await enclave.run(`
      const out = await callTool('test', {});
      return out.ok;
    `);

    expect(result.success).toBe(true);
    expect(result.value).toBe(true);

    enclave.dispose();
  });

  it('should enforce toolBridge.maxPayloadBytes on tool responses', async () => {
    const enclave = new Enclave({
      toolBridge: { maxPayloadBytes: 1024 },
      toolHandler: async () => 'a'.repeat(10_000),
    });

    const result = await enclave.run(`
      return await callTool('test', {});
    `);

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Tool response exceeds maximum size/i);

    enclave.dispose();
  });

  it('should enforce toolBridge.maxPayloadBytes on tool requests', async () => {
    const enclave = new Enclave({
      toolBridge: { maxPayloadBytes: 512 },
      toolHandler: async () => 'ok',
    });

    const result = await enclave.run(`
      const big = 'x'.repeat(5000);
      return await callTool('test', { big });
    `);

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Tool request exceeds maximum size/i);

    enclave.dispose();
  });

  it('should not expose the host bridge global in single-vm (doubleVm disabled)', async () => {
    const enclave = new Enclave({
      doubleVm: { enabled: false },
      validate: false,
      toolHandler: async () => 'ok',
    });

    const result = await enclave.run(`
      return typeof __host_callToolBridge__;
    `);

    expect(result.success).toBe(true);
    expect(result.value).toBe('undefined');

    enclave.dispose();
  });
});
