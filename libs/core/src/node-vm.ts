/**
 * Node.js `vm` availability check
 *
 * The built-in adapters need `node:vm`. Bundled for a browser or an edge runtime, `vm` is often
 * mapped to an empty module, and the first call into it fails with an opaque
 * `TypeError: (void 0) is not a function`; this check names the problem and the way out.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';

/**
 * Throw a descriptive error when this runtime does not provide `node:vm`.
 */
export function assertNodeVmAvailable(): void {
  if (typeof vm.createContext === 'function' && typeof vm.Script === 'function') {
    return;
  }
  throw new Error(
    '@enclave-vm/core needs node:vm, which this runtime does not provide. In a browser, use ' +
      '@enclave-vm/browser; elsewhere, pass a sandboxAdapter (for example new InterpreterAdapter()).',
  );
}
