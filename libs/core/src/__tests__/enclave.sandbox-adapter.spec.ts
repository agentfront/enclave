/**
 * A host-supplied `sandboxAdapter` runs scripts in place of the double VM, for hosts without
 * `node:vm`. The enclave still validates and transforms every script first.
 */

import { Enclave } from '../enclave';
import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import type { ExecutionContext, ExecutionResult, SandboxAdapter } from '../types';

class RecordingAdapter implements SandboxAdapter {
  readonly calls: Array<{ code: string; context: ExecutionContext }> = [];
  disposed = false;

  constructor(private readonly value: unknown) {}

  async execute<T>(code: string, context: ExecutionContext): Promise<ExecutionResult<T>> {
    this.calls.push({ code, context });
    return { success: true, value: this.value as T, stats: context.stats };
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe('sandboxAdapter', () => {
  it('runs the transformed script with the supplied adapter, even with the double VM on', async () => {
    const adapter = new RecordingAdapter(42);
    const enclave = new Enclave({ timeout: 1234, sandboxAdapter: adapter, doubleVm: { enabled: true } });

    const result = await enclave.run("return await callTool('users:list', {});");

    expect(result.value).toBe(42);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].code).toContain('__ag_main');
    expect(adapter.calls[0].code).toContain('__safe_callTool');
    expect(adapter.calls[0].context.config.timeout).toBe(1234);
    enclave.dispose();
  });

  it('validates the script before the adapter sees it', async () => {
    const adapter = new RecordingAdapter(1);
    const enclave = new Enclave({ sandboxAdapter: adapter });

    const result = await enclave.run('return eval("1");');

    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(adapter.calls).toHaveLength(0);
    enclave.dispose();
  });

  it('is not disposed by the enclave, so several enclaves can share it', async () => {
    const adapter = new RecordingAdapter('shared');
    const first = new Enclave({ sandboxAdapter: adapter });
    const second = new Enclave({ sandboxAdapter: adapter });

    await first.run('return 1;');
    first.dispose();
    const result = await second.run('return 1;');

    expect(adapter.disposed).toBe(false);
    expect(result.value).toBe('shared');
    second.dispose();
  });

  it('accepts the exported InterpreterAdapter', async () => {
    const interpreter = new InterpreterAdapter();
    const execute = jest.spyOn(interpreter, 'execute');
    const enclave = new Enclave({
      sandboxAdapter: interpreter,
      toolHandler: async (_name, args) => ({ doubled: (args['n'] as number) * 2 }),
    });

    const result = await enclave.run("const reply = await callTool('double', { n: 21 }); return reply.doubled;");

    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
    enclave.dispose();
  });

  it.each([{}, { execute: () => undefined }, null, 'vm'])('rejects %p at construction', (sandboxAdapter) => {
    expect(() => new Enclave({ sandboxAdapter: sandboxAdapter as unknown as SandboxAdapter })).toThrow(
      'sandboxAdapter must have execute(code, context) and dispose() methods',
    );
  });
});
