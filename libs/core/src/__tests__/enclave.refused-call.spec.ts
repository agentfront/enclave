import { Enclave } from '../enclave';
import { PortableEnclave } from '../portable-enclave';
import type { CreateEnclaveOptions, ExecutionResult, ToolHandler } from '../types';

interface Runner {
  run(code: string): Promise<ExecutionResult>;
  dispose(): void;
}

const answer: ToolHandler = async (toolName) => toolName;

const RUNTIMES: Array<[string, (options: CreateEnclaveOptions) => Runner]> = [
  ['double VM', (options) => new Enclave({ toolHandler: answer, ...options })],
  ['PortableEnclave', (options) => new PortableEnclave({ toolHandler: answer, ...options })],
  [
    'worker pool',
    (options) =>
      new Enclave({
        adapter: 'worker_threads',
        workerPoolConfig: { minWorkers: 1, maxWorkers: 1 },
        toolHandler: answer,
        ...options,
      }),
  ],
];

describe.each(RUNTIMES)('refusedCall on the %s', (_name, create) => {
  async function runOnce(code: string, options: CreateEnclaveOptions = {}): Promise<ExecutionResult> {
    const enclave = create(options);
    try {
      return await enclave.run(code);
    } finally {
      enclave.dispose();
    }
  }

  it('reports a refusal the script did not catch', async () => {
    const steps = "for (let i = 0; i < 5; i++) await callTool('step', { i }); return 'done';";
    const result = await runOnce(steps, { doubleVm: { parentValidation: { maxOperationsPerSecond: 2 } } });
    expect(result.success).toBe(false);
    expect(result.refusedCall).toEqual({ code: 'RATE_LIMIT_EXCEEDED', toolName: 'step' });
  });

  it('reports the first refusal also when the script caught it', async () => {
    const code = `
      try { await callTool('admin.drop', {}); } catch (error) {}
      await callTool('users.list', {});
      try { await callTool('users.delete', {}); } catch (error) {}
      return 'caught';
    `;
    const result = await runOnce(code, { doubleVm: { parentValidation: { blockedOperationPatterns: [/^admin\./] } } });
    expect(result.value).toBe('caught');
    expect(result.refusedCall).toEqual({ code: 'OPERATION_BLOCKED', toolName: 'admin.drop' });
  });

  it('names the detector of a suspicious sequence', async () => {
    const code = "await callTool('users.list', {}); await callTool('users.delete', {}); return 'done';";
    expect((await runOnce(code)).refusedCall).toEqual({
      code: 'SUSPICIOUS_SEQUENCE',
      toolName: 'users.delete',
      pattern: 'DELETE_AFTER_ACCESS',
    });
  });

  it('reports a name outside the allowed pattern and a call over maxToolCalls', async () => {
    const allowed = { doubleVm: { parentValidation: { allowedOperationPattern: /^safe\./ } } };
    expect((await runOnce("return await callTool('other', {});", allowed)).refusedCall).toEqual({
      code: 'OPERATION_NOT_ALLOWED',
      toolName: 'other',
    });
    const overCap = "for (let i = 0; i < 3; i++) await callTool('step', { i }); return 'done';";
    expect((await runOnce(overCap, { maxToolCalls: 2 })).refusedCall).toMatchObject({
      code: 'MAX_TOOL_CALLS_EXCEEDED',
    });
  });

  it('is not set by an error the script throws itself, nor by a run without refusals', async () => {
    const imitation = `
      try { throw new Error('Suspicious pattern detected: Delete operation after data access [DELETE_AFTER_ACCESS]'); }
      catch (error) {}
      throw new Error('Operation rate limit exceeded (100 operations/second)');
    `;
    const imitated = await runOnce(imitation);
    expect(imitated.success).toBe(false);
    expect(imitated.error?.message).toContain('Operation rate limit exceeded');
    expect(imitated.refusedCall).toBeUndefined();

    const clean = await runOnce("await callTool('users.list', {}); return 'done';");
    expect(clean.value).toBe('done');
    expect(clean).not.toHaveProperty('refusedCall');
  });
});

describe('refusedCall on the single VM', () => {
  it('reports a call over maxToolCalls', async () => {
    const enclave = new Enclave({ toolHandler: answer, doubleVm: { enabled: false }, maxToolCalls: 1 });
    try {
      const result = await enclave.run("await callTool('a', {}); await callTool('b', {}); return 'done';");
      expect(result.refusedCall).toEqual({ code: 'MAX_TOOL_CALLS_EXCEEDED' });
    } finally {
      enclave.dispose();
    }
  });
});
