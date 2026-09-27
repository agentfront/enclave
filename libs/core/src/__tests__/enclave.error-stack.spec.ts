/**
 * Returned-Error Stack Sanitization Regression Tests
 *
 * `sanitizeStackTraces` promised that no error the enclave returns carries host file paths or
 * line numbers. Errors raised on the host before the script runs (a parse error in the
 * transformer, reported as `ENCLAVE_ERROR`) and adapter-level failures (`EXECUTION_ERROR`) were
 * returned with the raw host `stack`, e.g. `.../node_modules/@enclave-vm/ast/index.js:126:15`.
 *
 * Every error `Enclave.run()` returns must obey the option on every adapter: sanitized when it is
 * on, untouched when it is off.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import type { CreateEnclaveOptions } from '../types';

type AdapterCase = { name: string; options: CreateEnclaveOptions };

const ADAPTERS: AdapterCase[] = [
  { name: 'double VM', options: {} },
  { name: 'single VM', options: { doubleVm: { enabled: false } } },
  {
    name: 'worker_threads',
    options: {
      adapter: 'worker_threads',
      doubleVm: { enabled: false },
      memoryLimit: 0,
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1, warmOnInit: true, memoryLimitPerWorker: 0 },
    },
  },
];

/** Anything that looks like a host file location: an absolute path or `file.ext:line:col`. */
const HOST_LOCATION = /(\/[\w.@-]+){2,}|\\[\w.@-]+\\|\.[cm]?[jt]s:\d+|:\d+:\d+/;

const created: Enclave[] = [];

function makeEnclave(adapter: AdapterCase, options: CreateEnclaveOptions): Enclave {
  const enclave = new Enclave({ ...adapter.options, ...options });
  created.push(enclave);
  return enclave;
}

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

afterEach(() => {
  while (created.length > 0) {
    created.pop()?.dispose();
  }
});

jest.setTimeout(30000);

describe('errors returned by Enclave.run obey sanitizeStackTraces', () => {
  describe.each(ADAPTERS)('$name', (adapter) => {
    it('sanitizes the stack of a transform (parse) error', async () => {
      const enclave = makeEnclave(adapter, { sanitizeStackTraces: true });

      const result = await enclave.run('const x = ;');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ENCLAVE_ERROR');
      expect(result.error?.message).toMatch(/parse/i);
      expect(result.error?.stack ?? '').not.toMatch(HOST_LOCATION);
    });

    it('sanitizes the stack of a compile error in the sandbox', async () => {
      const enclave = makeEnclave(adapter, { sanitizeStackTraces: true, validate: false, transform: false });

      const result = await enclave.run('return (;');

      expect(result.success).toBe(false);
      expect(result.error?.stack ?? '').not.toMatch(HOST_LOCATION);
    });

    it('sanitizes the stack of a runtime error raised by the enclave runtime', async () => {
      const enclave = makeEnclave(adapter, {
        sanitizeStackTraces: true,
        maxToolCalls: 1,
        toolHandler: async () => 'ok',
      });

      const result = await enclave.run(`
        await callTool('a', {});
        await callTool('b', {});
        return 'unreachable';
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/tool call limit/i);
      expect(result.error?.stack ?? '').not.toMatch(HOST_LOCATION);
    });

    it('sanitizes the stack of a failing tool call', async () => {
      const enclave = makeEnclave(adapter, {
        sanitizeStackTraces: true,
        toolHandler: async () => {
          throw new Error('tool exploded');
        },
      });

      const result = await enclave.run(`return await callTool('explode', {});`);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('tool exploded');
      expect(result.error?.stack ?? '').not.toMatch(HOST_LOCATION);
    });

    it('returns the stack untouched when sanitizeStackTraces is off', async () => {
      const enclave = makeEnclave(adapter, { sanitizeStackTraces: false });

      const result = await enclave.run('const x = ;');

      expect(result.success).toBe(false);
      expect(result.error?.stack).toMatch(HOST_LOCATION);
    });
  });
});
