/**
 * Worker results travel as JSON; Dates, NaN, Infinity and undefined travel next to them as
 * special values and are put back on the main thread.
 */

import { decodeResult, encodeResult } from '../adapters/worker-pool/result-encoding';
import { safeDeserialize, safeSerialize } from '../adapters/worker-pool/safe-deserialize';

/** Encode, send through the worker transport, decode. */
function roundTrip(value: unknown): unknown {
  const message = safeDeserialize(safeSerialize(encodeResult(value))) as {
    value: unknown;
    specialValues: unknown;
  };
  return decodeResult(message.value, message.specialValues);
}

describe('worker result encoding', () => {
  it('restores the values JSON cannot carry', () => {
    const value = {
      date: new Date(0),
      nan: NaN,
      inf: Infinity,
      negInf: -Infinity,
      undef: undefined,
      list: [1, undefined, new Date(1), { deep: [NaN] }],
      text: 'plain',
    };

    const decoded = roundTrip(value) as typeof value;

    expect(decoded).toEqual(value);
    expect(decoded.date).toBeInstanceOf(Date);
    expect('undef' in decoded).toBe(true);
  });

  it('restores an invalid Date', () => {
    const decoded = roundTrip({ when: new Date(NaN) }) as { when: Date };

    expect(decoded.when).toBeInstanceOf(Date);
    expect(decoded.when.getTime()).toBeNaN();
  });

  it('restores a special value at the root', () => {
    expect(roundTrip(new Date(5))).toEqual(new Date(5));
    expect(roundTrip(undefined)).toBeUndefined();
    expect(roundTrip(NaN)).toBeNaN();
  });

  it('sends plain JSON data without special values', () => {
    expect(encodeResult({ a: [1, 'x', null, true] }).specialValues).toEqual([]);
  });

  it('leaves out keys the transport strips', () => {
    const encoded = encodeResult({ prototype: new Date(0), ok: 1 });

    expect(encoded.specialValues).toEqual([]);
    expect(roundTrip({ prototype: new Date(0), ok: 1 })).toEqual({ ok: 1 });
  });

  describe('refuses special values that do not match the result', () => {
    const value = safeDeserialize(JSON.stringify({ a: null, b: 1, nested: { c: null } }));

    it.each([
      ['not an array', { path: ['a'], kind: 'nan' }],
      ['a path to a non-null value', [{ path: ['b'], kind: 'nan' }]],
      ['a path to a missing key', [{ path: ['missing'], kind: 'nan' }]],
      ['a path through a non-container', [{ path: ['b', 'x'], kind: 'nan' }]],
      ['a path through __proto__', [{ path: ['__proto__', 'a'], kind: 'nan' }]],
      ['an unknown kind', [{ path: ['a'], kind: 'function' }]],
      ['an invalid path segment', [{ path: [{}], kind: 'nan' }]],
      ['a negative index', [{ path: [-1], kind: 'nan' }]],
    ])('%s', (_name, specialValues) => {
      expect(() => decodeResult(value, specialValues)).toThrow('Worker result');
    });

    it('accepts a valid nested path', () => {
      expect(decodeResult(value, [{ path: ['nested', 'c'], kind: 'infinity' }])).toEqual({
        a: null,
        b: 1,
        nested: { c: Infinity },
      });
    });
  });
});
