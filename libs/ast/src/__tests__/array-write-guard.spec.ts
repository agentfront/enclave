/**
 * What the array write guard rewrites, and what it leaves as it is.
 */

import * as acorn from 'acorn';
import { generate } from 'astring';
import { guardArrayWrites } from '../transforms';

/** What the transform puts at the top of a program it rewrote something in */
const BINDINGS = 'const __ag_arraySet = __safe_set, __ag_arraySlot = __safe_slot; ';

/** The program after the transform, without that statement and with the runtime names in the calls. */
function rewrite(code: string): { code: string; guardedCount: number; bound: boolean } {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const { guardedCount } = guardArrayWrites(ast);
  const printed = generate(ast).trim().replace(/\s+/g, ' ');
  const bound = printed.startsWith(BINDINGS);
  return {
    code: (bound ? printed.slice(BINDINGS.length) : printed)
      .replace(/__ag_arraySet\(/g, '__safe_set(')
      .replace(/__ag_arraySlot\(/g, '__safe_slot('),
    guardedCount,
    bound,
  };
}

describe('guardArrayWrites', () => {
  describe('an assignment to a member with a computed key, or to length, becomes a call', () => {
    it.each([
      ['a[k] = v;', '__safe_set(a, k, v);'],
      ['a[1000] = v;', '__safe_set(a, 1000, v);'],
      ["a['1000'] = v;", "__safe_set(a, '1000', v);"],
      ["a['length'] = n;", "__safe_set(a, 'length', n);"],
      ['a.length = n;', "__safe_set(a, 'length', n);"],
      ['a.b[k].length = 0;', "__safe_set(a.b[k], 'length', 0);"],
      ['const r = a[k] = v;', 'const r = __safe_set(a, k, v);'],
      ['a[i] = b[j] = v;', '__safe_set(a, i, __safe_set(b, j, v));'],
      ['a[f(b[k] = 1)] = v;', '__safe_set(a, f(__safe_set(b, k, 1)), v);'],
      [
        'async function f() { (await g())[k] = await h(); }',
        'async function f() { __safe_set(await g(), k, await h()); }',
      ],
    ])('%s', (code, expected) => {
      expect(rewrite(code).code).toBe(expected);
    });
  });

  describe('every other write keeps its form, with the target behind a slot', () => {
    it.each([
      ['a[k] += v;', '__safe_slot(a, k).v += v;'],
      ['a[k] ||= v;', '__safe_slot(a, k).v ||= v;'],
      ['a.length -= 1;', "__safe_slot(a, 'length').v -= 1;"],
      ['a[k]++;', '__safe_slot(a, k).v++;'],
      ['--a.length;', "--__safe_slot(a, 'length').v;"],
      ['[a[k], b] = pair;', '[__safe_slot(a, k).v, b] = pair;'],
      ['[x, ...a[k]] = list;', '[x, ...__safe_slot(a, k).v] = list;'],
      ['({ p: a[k], q: { r: a.length } } = o);', "({p: __safe_slot(a, k).v, q: {r: __safe_slot(a, 'length').v}} = o);"],
      ['[a[k] = 1] = list;', '[__safe_slot(a, k).v = 1] = list;'],
      ['for (a[k] of list) {}', 'for (__safe_slot(a, k).v of list) {}'],
      ['for (a[k] in o) {}', 'for (__safe_slot(a, k).v in o) {}'],
      ['for ([a[k]] of pairs) {}', 'for ([__safe_slot(a, k).v] of pairs) {}'],
    ])('%s', (code, expected) => {
      expect(rewrite(code).code).toBe(expected);
    });
  });

  describe('what cannot take an array past a limit is left as it is', () => {
    it.each([
      'a.b = v;',
      'a[0] = v;',
      'a[63] = v;',
      "a['name'] = v;",
      "a['01'] = v;",
      'a.b += v;',
      'a.b++;',
      'const x = a[k];',
      'x = a[k] + a.length;',
      'delete a[k];',
      'for (const x of a) {}',
      '[x, y] = pair;',
      'class C extends B { m() { super[k] = 1; } }',
      'class C { #p; m(o) { o.#p = 1; } }',
    ])('%s', (code) => {
      const { guardedCount, bound } = rewrite(code);
      expect(guardedCount).toBe(0);
      expect(bound).toBe(false);
    });
  });

  it('counts what it rewrote, and binds the two runtime functions once at the top', () => {
    const { guardedCount, bound } = rewrite('a[k] = 1; a[k]++; [a[i], a[j]] = p; a.x = 2;');
    expect(guardedCount).toBe(4);
    expect(bound).toBe(true);
  });
});
