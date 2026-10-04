/**
 * Without `node:vm` (core bundled for a browser with `vm` mapped to an empty module), `run()`
 * explains what is missing instead of failing with `(void 0) is not a function`, and a
 * `sandboxAdapter` still works.
 */

import { Enclave } from '../enclave';
import { InterpreterAdapter } from '../adapters/interpreter-adapter';

jest.mock('vm', () => ({}));

describe('without node:vm', () => {
  it.each([
    ['the double VM', {}],
    ['the single VM', { doubleVm: { enabled: false } }],
  ])('%s fails with a message naming node:vm and the alternatives', async (_name, options) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enclave = new Enclave(options);

    const result = await enclave.run('return 1;');

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('@enclave-vm/core needs node:vm');
    expect(result.error?.message).toContain('@enclave-vm/browser');
    expect(result.error?.message).toContain('sandboxAdapter');
    enclave.dispose();
  });

  it('runs scripts with a sandboxAdapter', async () => {
    const enclave = new Enclave({ sandboxAdapter: new InterpreterAdapter() });

    const result = await enclave.run('return 1;');

    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
    enclave.dispose();
  });
});
