/**
 * Script results are sanitized the same way whichever realm built them.
 *
 * The sanitizer used to recognize Dates, Maps, Sets and RegExps with `instanceof`, which is false
 * for values built in the sandbox realm, so a script's `new Date(0)` came back as `{}`. It now
 * checks the builtin's internal slot, as `@enclave-vm/browser` does inside its iframe. The single
 * VM's membrane wraps the script's Dates in a proxy, which has no slot, so that adapter hands the
 * sanitizer `unwrapSecureProxy` to reach the Date behind it. The worker sanitizes in the worker and
 * sends Dates, NaN, Infinity and undefined next to the JSON result (see result-encoding).
 */

import * as vm from 'vm';
import { Enclave } from '../enclave';
import { createSecureProxy, unwrapSecureProxy } from '../secure-proxy';
import { sanitizeValue } from '../value-sanitizer';
import type { CreateEnclaveOptions } from '../types';

describe('sanitizeValue with values from another realm', () => {
  const foreign = vm.runInNewContext(`({
    date: new Date(0),
    map: new Map([['a', 1], ['__proto__', 2]]),
    set: new Set([1, 2]),
    pattern: /ab+c/gi,
  })`);

  it('converts them as it converts host values', () => {
    const sanitized = sanitizeValue(foreign) as Record<string, unknown>;

    expect(sanitized['date']).toBeInstanceOf(Date);
    expect((sanitized['date'] as Date).getTime()).toBe(0);
    expect({ ...(sanitized['map'] as object) }).toEqual({ a: 1 });
    expect(sanitized['set']).toEqual([1, 2]);
    expect(sanitized['pattern']).toBe('/ab+c/gi');
  });

  it("reads a RegExp's source and flags without running the value's own accessors", () => {
    const onRead = jest.fn(() => 'forged');
    const pattern = vm.runInNewContext(
      `const pattern = /ab+c/gi;
       Object.defineProperty(pattern, 'source', { get: onRead });
       Object.defineProperty(pattern, 'flags', { get: onRead });
       pattern`,
      { onRead },
    );

    expect(sanitizeValue(pattern)).toBe('/ab+c/gi');
    expect(onRead).not.toHaveBeenCalled();
  });

  it('turns a Proxy over a Date into a plain object without calling its traps', () => {
    const get = jest.fn();
    const sanitized = sanitizeValue(new Proxy(new Date(0), { get }));

    expect(sanitized).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });
});

describe('unwrapSecureProxy', () => {
  it('returns the object a secure proxy wraps', () => {
    const date = new Date(0);

    expect(unwrapSecureProxy(createSecureProxy(date))).toBe(date);
  });

  it('returns any other value unchanged', () => {
    const plain = { a: 1 };
    const foreignProxy = new Proxy(new Date(0), {});

    expect(unwrapSecureProxy(plain)).toBe(plain);
    expect(unwrapSecureProxy(foreignProxy)).toBe(foreignProxy);
    expect(unwrapSecureProxy(null)).toBeNull();
    expect(unwrapSecureProxy(1)).toBe(1);
  });

  it('lets sanitizeValue read a wrapped Date', () => {
    const wrapped = { date: createSecureProxy(new Date(0)) };

    expect(sanitizeValue(wrapped)).toEqual({ date: {} });
    expect(sanitizeValue(wrapped, { unwrap: unwrapSecureProxy })).toEqual({ date: new Date(0) });
  });
});

describe.each<[string, CreateEnclaveOptions]>([
  ['double VM', {}],
  ['single VM', { doubleVm: { enabled: false } }],
  [
    'worker_threads',
    {
      adapter: 'worker_threads',
      doubleVm: { enabled: false },
      memoryLimit: 0,
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1, warmOnInit: true, memoryLimitPerWorker: 0 },
    },
  ],
])('script results on the %s', (_name, adapterOptions) => {
  let enclave: Enclave;

  beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    enclave = new Enclave({ timeout: 5000, ...adapterOptions });
  });

  afterEach(() => {
    enclave.dispose();
  });

  it('returns a Date as a Date', async () => {
    const result = await enclave.run<{ date: Date; nested: Date[] }>(
      'return { date: new Date(0), nested: [new Date(1)] };',
    );

    expect(result.error).toBeUndefined();
    expect(result.value?.date).toBeInstanceOf(Date);
    expect(result.value?.date.getTime()).toBe(0);
    expect(result.value?.nested[0].getTime()).toBe(1);
  });

  it('keeps the other conversions', async () => {
    const result = await enclave.run('const a = { name: "a" }; a.self = a; return { a, nan: NaN, big: 10n };');

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ a: { name: 'a', self: '[Circular]' }, nan: NaN, big: '10' });
  });
});
