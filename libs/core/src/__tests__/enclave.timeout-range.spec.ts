/**
 * The range of `timeout`: what a timer can hold.
 *
 * A timer takes a delay of at most 2,147,483,647 ms; a longer one fires after 1 ms. A timeout
 * above that would therefore end a script at once, so it is refused where the enclave is made,
 * and what the runtime adds to a timeout stays within the range.
 */

import { Enclave } from '../enclave';

const LARGEST = 2147483647;
const slowTool = () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 150));

describe('the range of timeout', () => {
  it('refuses a timeout a timer cannot hold', () => {
    expect(() => new Enclave({ timeout: LARGEST + 1 })).toThrow(TypeError);
    expect(() => new Enclave({ timeout: 4294967295 })).toThrow(/timeout/);
    expect(() => new Enclave({ doubleVm: { parentTimeoutBuffer: LARGEST + 1 } })).toThrow(/parentTimeoutBuffer/);
  });

  it('takes the largest timeout, and a script under it runs to its end', async () => {
    const enclave = new Enclave({ timeout: LARGEST, toolCallGraceMs: 0, toolHandler: slowTool });
    try {
      const result = await enclave.run("return await callTool('slow', {});");
      expect(result.error).toBeUndefined();
      expect(result.value).toBe('done');
    } finally {
      enclave.dispose();
    }
  });

  it('the same in the worker pool, whose own stop comes after the timeout', async () => {
    const enclave = new Enclave({ timeout: LARGEST, adapter: 'worker_threads', toolHandler: slowTool });
    try {
      const result = await enclave.run("return await callTool('slow', {});");
      expect(result.error).toBeUndefined();
      expect(result.value).toBe('done');
    } finally {
      enclave.dispose();
    }
  }, 20000);
});
