/**
 * The script's console on the single-VM and worker_threads paths is built inside the sandbox realm: its methods, the
 * console object and the errors its limits throw are all sandbox-realm values, while what reaches the host console is
 * unchanged. Validation is off, so the checks run against the runtime alone.
 */

import { Enclave } from '../enclave';
import type { CreateEnclaveOptions } from '../types';

const WORKER: CreateEnclaveOptions = {
  adapter: 'worker_threads',
  doubleVm: { enabled: false },
  memoryLimit: 0,
  workerPoolConfig: { minWorkers: 1, maxWorkers: 1, memoryLimitPerWorker: 0 },
};

const PATHS: Array<[string, CreateEnclaveOptions, Array<'STANDARD' | 'PERMISSIVE'>]> = [
  ['single VM', { doubleVm: { enabled: false } }, ['STANDARD', 'PERMISSIVE']],
  ['worker_threads', WORKER, ['PERMISSIVE']],
];

/** Script helper: what a value's constructor chain leads to when called with code. */
const REALM_HELPER = `
  const realmOf = (value) => {
    try {
      return value.constructor.constructor('return typeof process')() === 'object' ? 'host' : 'sandbox';
    } catch (e) {
      return 'sandbox';
    }
  };
`;

function spyOnHostConsole() {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(() => undefined),
  );
  return {
    calls: (method: 'log' | 'info' | 'warn' | 'error') =>
      spies[['log', 'info', 'warn', 'error'].indexOf(method)].mock.calls,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

describe.each(PATHS)('console built in the sandbox realm (%s)', (_name, pathOptions, levels) => {
  jest.setTimeout(30000);

  let enclave: Enclave | undefined;
  let hostConsole: ReturnType<typeof spyOnHostConsole>;

  beforeEach(() => {
    hostConsole = spyOnHostConsole();
  });

  afterEach(() => {
    enclave?.dispose();
    enclave = undefined;
    hostConsole.restore();
  });

  function run(code: string, options: CreateEnclaveOptions = {}) {
    enclave = new Enclave({ ...pathOptions, validate: false, ...options });
    return enclave.run(REALM_HELPER + code);
  }

  it.each(levels)(
    'gives console methods, call and bind, and the console object from the sandbox realm at %s',
    async (securityLevel) => {
      const result = await run(
        `
      return [
        realmOf(console.log),
        realmOf(console.warn),
        realmOf(console),
        realmOf(console.log.call),
        realmOf(console.log.apply),
        realmOf(console.log.bind(null)),
        realmOf(console.__proto__),
        realmOf(console.info),
      ];
    `,
        { securityLevel },
      );

      expect(result.error?.message).toBeUndefined();
      expect(result.value).toEqual(Array(8).fill('sandbox'));
    },
  );

  it('throws its limit errors as sandbox-realm errors', async () => {
    const result = await run(
      `
      let caught;
      try {
        console.log('first');
        console.log('second');
      } catch (e) {
        caught = e;
      }
      return { realm: realmOf(caught), name: caught.name, message: caught.message };
    `,
      { securityLevel: 'PERMISSIVE', maxConsoleCalls: 1 },
    );

    expect(result.value).toEqual({
      realm: 'sandbox',
      name: pathOptions.adapter ? 'Error' : 'SecurityError',
      message: pathOptions.adapter
        ? 'Console call limit exceeded (1)'
        : 'Console call limit exceeded (max: 1). This limit prevents I/O flood attacks.',
    });
  });

  it('exposes a frozen, null-prototype console with the same methods', async () => {
    const result = await run(
      `
      try { console.log = () => 'replaced'; } catch (e) {}
      return { keys: Object.keys(console), frozen: Object.isFrozen(console), proto: console.__proto__ === undefined };
    `,
      { securityLevel: 'PERMISSIVE' },
    );

    expect(result.value).toEqual({
      keys: pathOptions.adapter ? ['log', 'warn', 'error', 'info'] : ['log', 'error', 'warn', 'info'],
      frozen: true,
      proto: true,
    });
  });

  it('passes a value the script throws while its arguments are formatted as it is', async () => {
    const result = await run(
      `
      const unprintable = { toJSON() { throw 1; }, toString() { throw 'own error'; } };
      try {
        console.log(unprintable);
        return 'printed';
      } catch (e) {
        return e;
      }
    `,
      { securityLevel: 'PERMISSIVE' },
    );

    expect(result.value).toBe('own error');
  });

  it('writes the same output to the host console', async () => {
    const result = await run(`console.log('a', { b: 1 }, 2); console.error('oops'); return 'ok';`, {
      securityLevel: 'PERMISSIVE',
    });

    expect(result.value).toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (pathOptions.adapter) {
      expect(hostConsole.calls('log')).toEqual([['[Worker]', '"a"', '{"b":1}', '2']]);
      expect(hostConsole.calls('error')).toEqual([['[Worker]', '"oops"']]);
    } else {
      expect(hostConsole.calls('log')).toEqual([['a {"b":1} 2']]);
      expect(hostConsole.calls('error')).toEqual([['oops']]);
    }
  });
});

describe('console on the double VM', () => {
  it('writes the same output to the host console', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const enclave = new Enclave({ securityLevel: 'PERMISSIVE' });
    try {
      const result = await enclave.run(`console.log('a', { b: 1 }, 2); return 'ok';`);
      expect(result.value).toBe('ok');
      expect(log.mock.calls).toEqual([['a {"b":1} 2']]);
    } finally {
      enclave.dispose();
      log.mockRestore();
    }
  });
});
