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

  describe('a limit that holds fewer than 64 slots', () => {
    const guarded = (code: string, unguardedBelow?: number): number => {
      const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
      return guardArrayWrites(ast, unguardedBelow === undefined ? undefined : { unguardedBelow }).guardedCount;
    };

    it('a literal index is left as it is only below the number of slots the limit holds', () => {
      expect(guarded('a[7] = v;', 8)).toBe(0);
      expect(guarded('a[8] = v;', 8)).toBe(1);
      expect(guarded('a[8]++;', 8)).toBe(1);
      expect(guarded('[a[8]] = p;', 8)).toBe(1);
      expect(guarded('a[0] = v;', 1)).toBe(0);
      expect(guarded('a[1] = v;', 1)).toBe(1);
    });

    it('with no slot at all every literal index is guarded', () => {
      expect(guarded('a[0] = v;', 0)).toBe(1);
    });

    it('a limit that holds more does not widen what is left as it is', () => {
      expect(guarded('a[63] = v;', 1000)).toBe(0);
      expect(guarded('a[64] = v;', 1000)).toBe(1);
      expect(guarded('a[63] = v;')).toBe(0);
      expect(guarded('a[64] = v;')).toBe(1);
    });

    it.each([-1, 1.5, NaN, Infinity, '8'])('refuses %p as the number', (value) => {
      const ast = acorn.parse('a[k] = v;', { ecmaVersion: 'latest', sourceType: 'script' });
      expect(() => guardArrayWrites(ast, { unguardedBelow: value as number })).toThrow(TypeError);
    });
  });

  describe('a program that begins with directives', () => {
    it('keeps them first: the bindings follow the directive prologue', () => {
      const ast = acorn.parse(`'use strict'; 'another directive'; a[k] = v;`, {
        ecmaVersion: 'latest',
        sourceType: 'script',
      }) as unknown as { body: Array<{ type: string; directive?: string }> };
      guardArrayWrites(ast as unknown as acorn.Node);

      expect(ast.body.map((statement) => statement.directive ?? statement.type)).toEqual([
        'use strict',
        'another directive',
        'VariableDeclaration',
        'ExpressionStatement',
      ]);
    });

    it('the rewritten program is still strict', () => {
      const ast = acorn.parse(`'use strict'; holder[key] = function () { return this === undefined; };`, {
        ecmaVersion: 'latest',
        sourceType: 'script',
      });
      guardArrayWrites(ast);
      // In sloppy code the function would be called with the global object as its receiver
      const holder: Record<string, () => boolean> = {};
      const set = (target: Record<string, unknown>, key: string, value: unknown) => (target[key] = value);
      new Function('holder', 'key', '__safe_set', '__safe_slot', generate(ast))(holder, 'probe', set, undefined);
      const probe = holder['probe'];
      expect(probe()).toBe(true);
    });

    it('a string statement that is not a directive stays where it is, after the bindings', () => {
      const ast = acorn.parse(`a[k] = v; 'use strict';`, {
        ecmaVersion: 'latest',
        sourceType: 'script',
      }) as unknown as { body: Array<{ type: string }> };
      guardArrayWrites(ast as unknown as acorn.Node);
      expect(ast.body[0]?.type).toBe('VariableDeclaration');
    });
  });
});
