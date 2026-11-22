import * as acorn from 'acorn';

import { JSAstValidator } from '../validator';
import { ValidationSeverity } from '../interfaces';
import {
  DisallowedIdentifierRule,
  NoEvalRule,
  NoGlobalAccessRule,
  NoRegexMethodsRule,
  ResourceExhaustionRule,
} from '../rules';
import { createStrictPreset, createSecurePreset, createAgentScriptPreset } from '../presets';
import { evaluateStatic, resolveStaticKey } from '../utils/static-eval';

/**
 * Functional tests of the static evaluation of property keys: what it resolves, what it calls
 * unresolved, what it leaves to run time, and what the rules do with each answer.
 *
 * The names used here are ordinary ones (`alpha`, `secret`). The tests that hold attempts to
 * reach a refused name, or to make the evaluation cost more than it may, are with the security
 * tests (see SECURITY-TESTS.md, ATK-PCHAIN and ATK-VBOUND).
 */

/** The key of the last `o[<key>]` in `source` */
function lastKey(source: string) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  let key: unknown;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    const candidate = node as { type?: string; computed?: boolean; object?: { name?: string }; property?: unknown };
    if (candidate.type === 'MemberExpression' && candidate.computed && candidate.object?.name === 'o') {
      key = candidate.property;
    }
    for (const [name, child] of Object.entries(node)) {
      if (name !== 'loc') visit(child);
    }
  };
  visit(ast);
  if (key === undefined) throw new Error(`no o[...] in: ${source}`);
  return { ast, key };
}

function keyOf(expression: string, options?: { variables?: boolean; prelude?: string }) {
  const { ast, key } = lastKey(`const o = {}; ${options?.prelude ?? ''} o[${expression}];`);
  return resolveStaticKey(ast, key, { variables: options?.variables });
}

function typesOf(expression: string, options?: { variables?: boolean; prelude?: string }): string[] {
  const { ast, key } = lastKey(`const o = {}; ${options?.prelude ?? ''} o[${expression}];`);
  return evaluateStatic(ast, key, { variables: options?.variables }).map((alternative) => alternative.type);
}

async function codesOf(rules: ConstructorParameters<typeof JSAstValidator>[0], source: string): Promise<string[]> {
  const result = await new JSAstValidator(rules).validate(source, { preScan: { enabled: false } });
  return result.issues.filter((issue) => issue.severity === ValidationSeverity.ERROR).map((issue) => issue.code);
}

describe('static evaluation of a property key', () => {
  describe('a key made of constants is computed', () => {
    it.each([
      ['a string literal', `'alpha'`, ['alpha']],
      ['a number', `7`, ['7']],
      ['a negative number', `-1`, ['-1']],
      ['a concatenation', `'al' + 'pha'`, ['alpha']],
      ['a concatenation with a number', `'item' + 1`, ['item1']],
      ['a sum', `1 + 2`, ['3']],
      ['a template literal', '`al${"pha"}`', ['alpha']],
      ['a joined array', `['al', 'pha'].join('')`, ['alpha']],
      ['a joined array with a separator', `['al', 'pha'].join('_')`, ['al_pha']],
      ['a join with an argument it ignores', `['al', 'pha'].join('', 0)`, ['alpha']],
      ['an array converted to a string', `['alpha']`, ['alpha']],
      ['an element of an array', `['x', 'alpha'][1]`, ['alpha']],
      ['a method of a string', `'ALPHA'.toLowerCase()`, ['alpha']],
      ['a slice of a string', `'xalpha'.slice(1)`, ['alpha']],
      ['a chain of methods', `'ahpla'.split('').reverse().join('')`, ['alpha']],
      ['a conversion', `String(5)`, ['5']],
      ['character codes', `String.fromCharCode(97, 98)`, ['ab']],
      ['a decoded string', `decodeURIComponent('%61b')`, ['ab']],
      ['a member of an object', `({ a: 'alpha' }).a`, ['alpha']],
      ['an object converted by toString', `({ toString: () => 'alpha' })`, ['alpha']],
      ['a function called in place', `(() => 'alpha')()`, ['alpha']],
      ['a function called with arguments', `((a, b) => a + b)('al', 'pha')`, ['alpha']],
      ['a sequence', `(0, 'alpha')`, ['alpha']],
      ['a condition that is decided', `1 > 0 ? 'alpha' : 'beta'`, ['alpha']],
      ['a length', `'alpha'.length`, ['5']],
      ['parsed JSON', `JSON.parse('["alpha"]')[0]`, ['alpha']],
      ['the keys of an object', `Object.keys({ alpha: 1 })[0]`, ['alpha']],
      ['a regular expression', `/x/`, ['/x/']],
      ['an object', `{}`, ['[object Object]']],
      ['null', `null`, ['null']],
      ['a list made by Array.from', `Array.from(['al', 'pha']).join('')`, ['alpha']],
      [
        'a list mapped by Array.from',
        `Array.from(['al', 'pha'], (piece, index) => piece + index).join('')`,
        ['al0pha1'],
      ],
      ['Array.from with a mapper that is undefined', `Array.from(['alpha'], undefined)[0]`, ['alpha']],
      // (`Array.from` calls its mapper with the value and the index, and nothing else)
      [
        'a parameter the mapper of Array.from is not given',
        `Array.from(['x'], (v, i, rest = 'alpha') => rest)[0]`,
        ['alpha'],
      ],
      ['a member of a frozen object', `Object.freeze({ a: 'alpha' }).a`, ['alpha']],
      // (A sealed list keeps its length; its elements can still be written)
      ['a sealed list reversed in place', `Object.seal(['beta', 'alpha']).reverse()[0]`, ['alpha']],
      ['a replacement where nothing matches', `'a'.repeat(100).replaceAll('z', 'xy'.repeat(30)).length`, ['100']],
      ['a copy of a frozen list', `Object.freeze(['pha', 'al']).slice().reverse().join('')`, ['alpha']],
      [
        'a frozen list read under its other name',
        `(() => { const list = ['alpha', 'beta']; const frozen = Object.freeze(list); return list[0]; })()`,
        ['alpha'],
      ],
      // (An object spread copies the code units of a string: two for this character)
      ['the code units of a string spread into an object', `Object.keys({ ...'a\u{1F600}' }).length`, ['3']],
      ['the characters of a string spread into a list', `[...'a\u{1F600}'].length`, ['2']],
    ])('%s', (_name, expression, names) => {
      expect(keyOf(expression)).toEqual({ names, unresolved: false });
    });

    it('lists every value a condition that is not decided may give', () => {
      expect(keyOf(`flag ? 'alpha' : 'beta'`, { prelude: 'const f = (flag) =>' }).names).toEqual(['alpha', 'beta']);
      expect(keyOf(`name || 'alpha'`, { prelude: 'const f = (name) =>' }).names).toEqual(['alpha']);
    });

    it('has no name for a symbol or a function', () => {
      expect(keyOf(`Symbol.iterator`)).toEqual({ names: [], unresolved: false });
      expect(keyOf(`() => 1`)).toEqual({ names: [], unresolved: false });
      expect(typesOf(`Symbol.iterator`)).toEqual(['symbol']);
      expect(typesOf(`() => 1`)).toEqual(['function']);
    });
  });

  describe('a key made of constants that is not computed is unresolved', () => {
    it.each([
      ['a collection', `new Map([['a', 'b']]).get('a')`],
      ['a method that runs a pattern', `'ab'.match('a')[0]`],
      [
        'a loop in a function called in place',
        `(() => { let s = ''; for (const c of ['a', 'b']) s += c; return s; })()`,
      ],
      ['a class', `(class { static k = 'ab'; }).k`],
      ['a function that calls itself', `(function again() { return again(); })()`],
      // (A write to a frozen object throws: it is not computed as one that succeeds)
      ['a copy onto a frozen object', `Object.assign(Object.freeze({}), { a: 'alpha' }).a`],
      ['a frozen list changed in place', `Object.freeze(['a', 'b']).reverse()[0]`],
      // (Frozen is what the object is, whichever name it is reached by)
      [
        'a frozen list changed in place under its other name',
        `(() => { const list = ['a', 'b']; const frozen = Object.freeze(list); return list.reverse()[0]; })()`,
      ],
    ])('%s', (_name, expression) => {
      // (What the search for names saw in it is listed next to that: it is not the value)
      expect(keyOf(expression).unresolved).toBe(true);
    });

    it('names what a function that is not followed can be seen returning, and stays unresolved', () => {
      // The body branches, so it is not followed: what its `return` statements give are names
      // to compare, not the value of the call
      const key = keyOf(`(() => { if (1) { return 'alpha'; } return 'beta'; })()`);

      expect(key.unresolved).toBe(true);
      expect(key.names.sort()).toEqual(['alpha', 'beta', 'undefined']);
    });

    it('does not read what the statements of such a function may have changed', () => {
      // `name` is assigned in a statement that is not followed: what it holds is not known
      const key = keyOf(`((name) => { if (1) { name = 'alpha'; } return name; })('beta')`);

      expect(key.unresolved).toBe(true);
    });
  });

  describe('a value that could be wrong is not given', () => {
    it.each([
      ['a parameter that is assigned inside the key', `((name) => (name = 'beta', name))('alpha')`],
      ['a list that is added to inside the key', `((list) => (list.push('beta'), list[0]))(['alpha'])`],
      ['a list that is sorted in place', `((list) => (list.sort(), list[0]))(['beta', 'alpha'])`],
      ['a property that is assigned inside the key', `((table) => (table.a = 'beta', table.a))({ a: 'alpha' })`],
      ['typeof a built-in', `typeof Math`],
      ['two parameters of one name', `(function (a, a) { return a; })('alpha', 'beta')`],
      ['this of a function that is called without an object', `(function () { return typeof this; })()`],
      [
        'a default that may assign, after an argument that is not known',
        `((name, other = (name = 'beta')) => name)('alpha', new Map().size)`,
      ],
    ])('%s', (_name, expression) => {
      // (What the search for names saw in it is listed next to that: it is not the value)
      expect(keyOf(expression).unresolved).toBe(true);
    });

    it('an expression in which anything assigned has no computed value, whatever it reads after', () => {
      // The assignment does not reach what is read; the key is not computed all the same
      expect(keyOf(`((name, other) => (other = 'beta', name))('alpha', 'gamma')`).unresolved).toBe(true);
      // After a call that is not followed, a list is read for names only
      const touched = keyOf(`((list) => (touch(list), list[0]))(['alpha'])`);
      expect(touched.unresolved).toBe(true);
      expect(typesOf(`((list) => (touch(list), list[0]))(['alpha'])`)).toContain('dynamic');
    });

    it('an assignment that nothing is evaluated after is the value that was assigned', () => {
      expect(keyOf(`(name = 'alpha')`, { prelude: 'let name;' })).toEqual({ names: ['alpha'], unresolved: false });
    });

    it('a method that changes the list it is called on is computed', () => {
      expect(keyOf(`'ahpla'.split('').reverse().join('')`)).toEqual({ names: ['alpha'], unresolved: false });
      expect(keyOf(`['b', 'a'].sort().join('')`)).toEqual({ names: ['ab'], unresolved: false });
    });

    it('a function that changes nothing is computed', () => {
      expect(keyOf(`((name) => name + '!')('alpha')`)).toEqual({ names: ['alpha!'], unresolved: false });
      expect(keyOf(`((list) => list.concat(['beta']).join('-'))(['alpha'])`).names).toEqual(['alpha-beta']);
    });

    it('what goes through a built-in is not computed in a script that can have changed one', () => {
      for (const prelude of [
        `Math.max = () => 'beta';`,
        `const M = Math; M.max = () => 'beta';`,
        `const change = (m) => { m.max = () => 'beta'; }; change(Math);`,
        `parseInt = () => 'beta';`,
      ]) {
        expect(keyOf(`Math.max(1, 2)`, { prelude }).unresolved).toBe(true);
        expect(keyOf(`'AB'.toLowerCase()`, { prelude }).unresolved).toBe(true);
        // What does not go through a built-in is computed all the same
        expect(keyOf(`'al' + 'pha'`, { prelude })).toEqual({ names: ['alpha'], unresolved: false });
      }
    });

    it('a built-in that is handed on, in a script that writes only to its own objects, is unchanged', () => {
      const prelude = `const labels = [1, 2].map(String); const totals = {}; totals.count = labels.length;`;

      expect(keyOf(`'AB'.toLowerCase()`, { prelude })).toEqual({ names: ['ab'], unresolved: false });
      expect(keyOf(`Math.max(1, 2)`, { prelude })).toEqual({ names: ['2'], unresolved: false });
    });

    it('whether a method of the engine exists is not assumed', () => {
      // An engine older than the one that validates may not have it
      expect(keyOf(`''.at ? 'alpha' : 'beta'`).names.sort()).toEqual(['alpha', 'beta']);
    });

    it('a built-in that is only called, or read for a number, is left as the language defines it', () => {
      const prelude = `const tau = Math.PI * 2; const big = Number.MAX_SAFE_INTEGER; const n = Math.round(1.5);`;

      expect(keyOf(`Math.max(1, 2)`, { prelude })).toEqual({ names: ['2'], unresolved: false });
    });

    it('casing in the locale of the host gives both answers where they differ', () => {
      expect(keyOf(`'ab'.toLocaleUpperCase()`)).toEqual({ names: ['AB'], unresolved: false });
      expect(keyOf(`'hi'.toLocaleUpperCase()`).names).toEqual(['HI', 'H\u0130']);
    });
  });

  describe('a key that depends on a run-time value is dynamic', () => {
    it.each([
      ['a parameter', `key`, 'const f = (key) =>'],
      ['a parameter in a concatenation', `'item_' + key`, 'const f = (key) =>'],
      ['a method of a parameter', `key.toLowerCase()`, 'const f = (key) =>'],
      ['a global the language does not define', `input.field`, ''],
      ['the result of a call into the host', `lookup('a')`, ''],
      ['the clock', `Date.now()`, ''],
      ['a date, which is read in the time zone of the host', `new Date(2024, 0, 1).getFullYear()`, ''],
      ['a random number', `Math.floor(Math.random() * 3)`, ''],
    ])('%s', (_name, expression, prelude) => {
      expect(keyOf(expression, { prelude })).toEqual({ names: [], unresolved: false });
      expect(typesOf(expression, { prelude })).toEqual(['dynamic']);
    });
  });

  describe('variables', () => {
    it('are run-time values unless they are followed', () => {
      const prelude = `const key = 'al' + 'pha';`;

      expect(keyOf('key', { prelude })).toEqual({ names: [], unresolved: false });
      expect(keyOf('key', { prelude, variables: true })).toEqual({ names: ['alpha'], unresolved: false });
    });

    it('a const that holds a constant is that constant, through other constants', () => {
      const prelude = `const head = 'al'; const key = head + 'pha';`;

      expect(keyOf(`key + '!'`, { prelude, variables: true })).toEqual({ names: ['alpha!'], unresolved: false });
      expect(typesOf('key', { prelude, variables: true })).toEqual(['primitive']);
    });

    it('a const whose value is not computed makes the key unresolved', () => {
      const prelude = `const key = new Map().size;`;

      expect(keyOf('key', { prelude, variables: true })).toEqual({ names: [], unresolved: true });
    });

    it('any other variable is a run-time value, with the constants it can be seen holding', () => {
      const reassigned = keyOf('key', { prelude: `let key = 'alpha'; key = 'beta';`, variables: true });
      expect(reassigned).toEqual({ names: ['alpha', 'beta'], unresolved: false });
      expect(typesOf('key', { prelude: `let key = 'alpha'; key = 'beta';`, variables: true })).toContain('dynamic');

      // A default value, an element a pattern or a loop takes from a literal
      expect(keyOf('key', { prelude: `const f = (key = 'alpha') =>`, variables: true }).names).toEqual(['alpha']);
      expect(keyOf('key', { prelude: `const [key] = ['alpha'];`, variables: true }).names).toEqual(['alpha']);
      expect(keyOf('key', { prelude: `for (const key of ['alpha', 'beta'])`, variables: true }).names).toEqual([
        'alpha',
        'beta',
      ]);

      // What a variable holds can change: read through it, it is never "unresolved"
      const held = keyOf('fields.toLocaleString()', { prelude: `const fields = ['alpha'];`, variables: true });
      expect(held).toEqual({ names: [], unresolved: false });
    });

    it('finds a constant a variable is given in steps', () => {
      expect(keyOf('key', { prelude: `let key = 'al'; key += 'pha';`, variables: true }).names).toContain('alpha');
      expect(keyOf('key', { prelude: `let key = 'al'; key = key + 'pha';`, variables: true }).names).toContain('alpha');
    });

    it('finds what a parameter is given by the calls that can be seen', () => {
      const called = lastKey(`const o = {}; const read = (key) => o[key]; read('alpha'); read('beta');`);
      expect(resolveStaticKey(called.ast, called.key, { variables: true }).names).toEqual(['alpha', 'beta']);

      const walked = lastKey(`const o = {}; ['alpha', 'beta'].forEach((key) => o[key]);`);
      expect(resolveStaticKey(walked.ast, walked.key, { variables: true }).names).toEqual(['alpha', 'beta']);

      // Not followed, a parameter is a run-time value
      expect(resolveStaticKey(called.ast, called.key).names).toEqual([]);
    });

    it('finds what is stored into the list or the object a variable holds', () => {
      const list = keyOf('list[0]', { prelude: `const list = []; list.push('alpha');`, variables: true });
      expect(list.names).toContain('alpha');

      const table = keyOf('table.name', { prelude: `const table = {}; table.name = 'alpha';`, variables: true });
      expect(table.names).toContain('alpha');
    });

    it('an object that is not read is a run-time value where something is read from it', () => {
      const prelude = `const index = new Map();`;

      expect(keyOf(`index.get('a')`, { prelude, variables: true })).toEqual({ names: [], unresolved: false });
      // Used as a key itself it is converted to a string that is not known
      expect(keyOf(`index`, { prelude, variables: true }).unresolved).toBe(true);
    });

    it('names the pieces of a short constant that is cut at a run-time position', () => {
      const cut = keyOf(`'alpha'.slice(start)`, { prelude: `const f = (start) =>` });

      expect(cut.unresolved).toBe(false);
      expect(cut.names).toEqual(expect.arrayContaining(['alpha', 'lpha', 'a']));
    });

    it('a parameter the body declares again with var holds what the call gave it', () => {
      const declared = lastKey(`const o = {}; function read(key) { var key; return o[key]; } read('alpha');`);
      expect(resolveStaticKey(declared.ast, declared.key, { variables: true }).names).toContain('alpha');
    });

    it('a var in a catch block under the name of the catch parameter gives the parameter its value', () => {
      const caught = lastKey(`const o = {}; try { run(); } catch (key) { var key = 'alpha'; o[key]; }`);
      expect(resolveStaticKey(caught.ast, caught.key, { variables: true }).names).toContain('alpha');
    });

    it('inside with, a name is not read as the variable of that name', () => {
      // (The object of `with` may have a property of that name)
      const prelude = `const key = 'alpha'; with (table)`;

      expect(keyOf('key', { prelude, variables: true }).unresolved).toBe(true);
      expect(keyOf('key', { prelude: `const key = 'alpha'; with (table) {}`, variables: true }).names).toEqual([
        'alpha',
      ]);
    });

    it('a parameter shadows a constant of the same name', () => {
      const prelude = `const key = 'alpha'; const f = (key) =>`;

      expect(keyOf('key', { prelude, variables: true })).toEqual({ names: [], unresolved: false });
    });
  });

  // (What a key may cost, and what happens past that, is pinned by the security tests: ATK-VBOUND)
  describe('bounds', () => {
    it('reads a long literal without building anything from it', () => {
      const long = 'x'.repeat(5000);

      expect(keyOf(`'${long}'`).names).toEqual([long]);
      expect(keyOf(`\`${long}\``).names).toEqual([long]);
      expect(keyOf(`[].join('${long}')`).names).toEqual(['']);
    });

    it('is the same answer however often it is asked', () => {
      const { ast, key } = lastKey(`const o = {}; o[['al', 'pha'].join('')];`);

      expect(resolveStaticKey(ast, key)).toEqual(resolveStaticKey(ast, key));
      expect(resolveStaticKey(undefined, key)).toEqual({ names: ['alpha'], unresolved: false });
    });
  });
});

describe('how the rules read a key', () => {
  const rule = (options = {}) => [new DisallowedIdentifierRule({ disallowed: ['secret'], ...options })];

  it.each([
    ['a member', 'const v = o.secret;'],
    ['a string key', "const v = o['secret'];"],
    ['a key in pieces', "const v = o['sec' + 'ret'];"],
    ['a joined key', "const v = o[['sec', 'ret'].join('')];"],
    ['a key built by a method', "const v = o['SECRET'.toLowerCase()];"],
    ['a key held in a const', "const k = 'secret'; const v = o[k];"],
    ['a destructuring key', 'const { secret: v } = o;'],
    ['a destructuring shorthand', 'const { secret } = o;'],
    ['a computed destructuring key', "const { ['sec' + 'ret']: v } = o;"],
    ['a parameter pattern', 'const f = ({ secret: v }) => v;'],
  ])('DisallowedIdentifierRule refuses the name as %s', async (_name, source) => {
    expect(await codesOf(rule(), `const o = {}; ${source}`)).toEqual(['DISALLOWED_IDENTIFIER']);
  });

  it.each([
    ['another name', 'const v = o.public;'],
    ['a name that contains it', "const v = o['secrets'];"],
    ['a key in pieces that is another name', "const v = o['pub' + 'lic'];"],
    ['a run-time key', 'const f = (key) => o[key];'],
    ['the name as data', "const names = ['secret']; const has = names.includes('secret');"],
    ['the name as a key of an object literal', 'const data = { secret: 1 };'],
  ])('DisallowedIdentifierRule accepts %s', async (_name, source) => {
    expect(await codesOf(rule(), `const o = {}; ${source}`)).toEqual([]);
  });

  it('resolveVariableKeys: false leaves a key held in a variable to run time', async () => {
    const source = "const o = {}; const k = 'secret'; const v = o[k];";

    expect(await codesOf(rule(), source)).toEqual(['DISALLOWED_IDENTIFIER']);
    expect(await codesOf(rule({ resolveVariableKeys: false }), source)).toEqual([]);
    // The key as it is written where it stands is read all the same
    expect(await codesOf(rule({ resolveVariableKeys: false }), "const o = {}; const v = o['sec' + 'ret'];")).toEqual([
      'DISALLOWED_IDENTIFIER',
    ]);
  });

  it('checkDestructuringKeys: false leaves the keys of a pattern to another rule', async () => {
    const source = 'const o = {}; const { secret: v } = o;';

    expect(await codesOf(rule(), source)).toEqual(['DISALLOWED_IDENTIFIER']);
    expect(await codesOf(rule({ checkDestructuringKeys: false }), source)).toEqual([]);
    expect(await codesOf(rule({ checkDestructuringKeys: false }), 'const o = {}; const v = o.secret;')).toEqual([
      'DISALLOWED_IDENTIFIER',
    ]);
  });

  it('disallowedProperties are refused in the same spellings and positions, and stay usable as variables', async () => {
    const rules = [new DisallowedIdentifierRule({ disallowed: ['secret'], disallowedProperties: ['hidden'] })];

    for (const source of ['const v = o.hidden;', "const v = o['hid' + 'den'];", 'const { hidden: v } = o;']) {
      expect(await codesOf(rules, `const o = {}; ${source}`)).toEqual(['DISALLOWED_IDENTIFIER']);
    }
    expect(await codesOf(rules, 'const hidden = 1; const twice = hidden * 2;')).toEqual([]);
  });

  it('a key made of constants that cannot be computed is refused, once, after what the rule found itself', async () => {
    const rules = [new DisallowedIdentifierRule({ disallowed: ['secret'] }), new NoGlobalAccessRule()];
    const source = "const o = {}; const a = o.secret; const b = o[new Map([['a', 'b']]).get('a')];";

    expect(await codesOf(rules, source)).toEqual(['DISALLOWED_IDENTIFIER', 'STATIC_KEY_UNRESOLVED']);
  });

  it('a key no rule can read is refused although the first rule that reads it only warns', async () => {
    const rules = [new NoEvalRule(), new DisallowedIdentifierRule({ disallowed: ['secret'] })];
    const source = "const o = {}; const v = o['a'.replace(/a/, 'b')]();";

    const result = await new JSAstValidator(rules).validate(source, {
      preScan: { enabled: false },
      rules: { 'no-eval': { severity: ValidationSeverity.WARNING } },
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.code === 'STATIC_KEY_UNRESOLVED' && issue.severity === ValidationSeverity.ERROR,
      ),
    ).toBe(true);
  });

  it('a refused identifier is refused where it is assigned, too', async () => {
    for (const source of ['secret = 1;', 'secret ||= 1;', 'secret++;', '[secret] = [1];']) {
      expect(await codesOf(rule(), source)).toContain('DISALLOWED_IDENTIFIER');
    }
  });

  it('disallowedObjectKeys refuses a name as a key of an object literal, in every spelling', async () => {
    const rules = [new DisallowedIdentifierRule({ disallowed: ['secret'], disallowedObjectKeys: ['hook'] })];

    for (const source of ['const t = { hook: 1 };', "const t = { ['ho' + 'ok']: 1 };", 'const t = { hook() {} };']) {
      expect(await codesOf(rules, source)).toEqual(['DISALLOWED_IDENTIFIER']);
    }
    expect(await codesOf(rules, 'const t = { hooks: 1 }; const v = t.hook;')).toEqual([]);
  });

  it('blockProtoInObjectLiterals refuses a computed __proto__ key as well', async () => {
    const rules = [new DisallowedIdentifierRule({ disallowed: ['secret'], blockProtoInObjectLiterals: true })];

    expect(await codesOf(rules, "const base = {}; const t = { ['__proto__']: base };")).toEqual([
      'DISALLOWED_IDENTIFIER',
    ]);
    expect(await codesOf(rules, "const base = {}; const t = { ['__pro' + 'to__']: base };")).toEqual([
      'DISALLOWED_IDENTIFIER',
    ]);
  });

  it('reports a refused object key once, whichever option refuses it', async () => {
    const rules = [
      new DisallowedIdentifierRule({
        disallowed: ['secret'],
        blockProtoInObjectLiterals: true,
        disallowedObjectKeys: ['__proto__', 'hidden'],
      }),
    ];

    expect(await codesOf(rules, 'const t = { __proto__: null };')).toEqual(['DISALLOWED_IDENTIFIER']);
    expect(await codesOf(rules, 'const t = { hidden: 1, __proto__: null };')).toEqual([
      'DISALLOWED_IDENTIFIER',
      'DISALLOWED_IDENTIFIER',
    ]);
  });

  describe('a key no rule can read', () => {
    // (A call through a computed key: the rule for timers reads the key, and so does the rule for names)
    const SOURCE = "const v = o[new Map([['k', 'alpha']]).get('k')]();";
    const rules = () => [new NoEvalRule(), new DisallowedIdentifierRule({ disallowed: ['secret'] })];
    const unresolved = async (config: Parameters<JSAstValidator['validate']>[1]) => {
      const result = await new JSAstValidator(rules()).validate(SOURCE, { preScan: { enabled: false }, ...config });
      return {
        valid: result.valid,
        issues: result.issues.filter((issue) => issue.code === 'STATIC_KEY_UNRESOLVED').map((issue) => issue.severity),
      };
    };

    it('has one issue, however many rules read it', async () => {
      expect(await unresolved({})).toEqual({ valid: false, issues: [ValidationSeverity.ERROR] });
    });

    it('keeps one issue, at the severity of the rule that counts for most', async () => {
      // The first rule only warns: the issue it made is raised by the second, not doubled
      const warned = { rules: { 'no-eval': { severity: ValidationSeverity.WARNING } } };
      expect(await unresolved(warned)).toEqual({ valid: false, issues: [ValidationSeverity.ERROR] });

      const both = {
        rules: {
          'no-eval': { severity: ValidationSeverity.WARNING },
          'disallowed-identifier': { severity: ValidationSeverity.WARNING },
        },
      };
      expect(await unresolved(both)).toEqual({ valid: true, issues: [ValidationSeverity.WARNING] });
    });

    it('is refused where the first error ends the validation', async () => {
      const warned = {
        rules: { 'no-eval': { severity: ValidationSeverity.WARNING } },
        stopOnFirstError: true,
      };
      expect(await unresolved(warned)).toEqual({ valid: false, issues: [ValidationSeverity.ERROR] });
    });
  });

  it('a rule asks about a key only where the answer is its own', async () => {
    // `rows[key]` cannot be `receiver.method.call`: the rule for the methods of a pattern does
    // not read its key, and so does not refuse a script for it
    const source = "const value = rows[new Map([['k', 'alpha']]).get('k')];";

    expect(await codesOf([new NoRegexMethodsRule()], source)).toEqual([]);

    // A member whose name is written out, and is not a method of this rule, is not called through its key
    const nested = `const rows = [{}]; const v = rows[0][new Map([['k', 'alpha']]).get('k')];`;
    expect(await codesOf([new NoRegexMethodsRule()], nested)).toEqual([]);

    // Nothing that is read from a host object is this rule's to read
    const host = new NoRegexMethodsRule({ requireDirectCall: true, hostObjectNames: ['docs'] });
    expect(await codesOf([host], `const v = docs[new Map([['k', 'title']]).get('k')];`)).toEqual([]);
  });

  it('a default value marks the variable it initializes, not another one of the same name', async () => {
    const rules = () => [new ResourceExhaustionRule()];
    const refused = "const pick = (key = 'prototype') => rows[key];";
    const other = "const label = (key = 'prototype') => key; const key = 'alpha'; const value = rows[key];";

    expect(await codesOf(rules(), refused)).toEqual(['CONSTRUCTOR_ACCESS']);
    expect(await codesOf(rules(), other)).toEqual([]);
  });

  describe('NoEvalRule and timers', () => {
    it.each([
      ['a string literal', `setTimeout('tick()', 10);`],
      ['a template literal', 'setTimeout(`tick()`, 10);'],
      ['a string in pieces', `setInterval('tick' + '()', 10);`],
      ['a string held in a const', `const code = 'tick()'; setTimeout(code, 10);`],
      ['a timer called as a member', `timers.setTimeout('tick()', 10);`],
    ])('refuses %s', async (_name, source) => {
      expect(await codesOf([new NoEvalRule()], source)).toEqual(['NO_EVAL']);
    });

    it.each([
      ['a string that is spread', `setTimeout(...['tick()', 10]);`],
      ['a string whatever its text is', 'const later = (name) => setTimeout(`${name}()`, 10);'],
      ['a timer stored under another name', `const later = setTimeout; later(() => 1, 10);`],
      ['a timer passed to a function', `run(setTimeout);`],
      ['a timer called through call', `setTimeout.call(null, () => 1, 10);`],
      ['a timer taken out of an object under another name', `const { setTimeout: later } = timers;`],
      ['a timer named by a const, called through call', `const k = 'setTimeout'; timers[k].call(null, () => 1, 10);`],
      ['a timer named by a const, taken out by a pattern', `const k = 'setTimeout'; const { [k]: later } = timers;`],
    ])('refuses %s', async (_name, source) => {
      expect(await codesOf([new NoEvalRule()], source)).toEqual(['NO_EVAL']);
    });

    it.each([
      ['a function', `setTimeout(() => 1, 10);`],
      ['a function of the script', `const tick = () => 1; setInterval(tick, 10);`],
      ['a parameter', `const later = (callback) => setTimeout(callback, 10);`],
      ['another function with a string', `schedule('tick()', 10);`],
      ['a test for the timer', `if (typeof setTimeout === 'function') setTimeout(() => 1, 10);`],
      ['a timer the script declares itself', `function setTimeout(fn) { return fn; } const later = setTimeout;`],
      ['a timer that is defined on an object', `scheduler.setTimeout = (fn) => fn;`],
      ['a timer taken out under its own name', `const { setTimeout } = scheduler; setTimeout(() => 1, 10);`],
      [
        'a timer taken out under its own name by a key a const holds',
        `const k = 'setTimeout'; const { [k]: setTimeout } = scheduler; setTimeout(() => 1, 10);`,
      ],
      [
        'a function returned by a method named like one that gives a list',
        `setTimeout({ map: () => () => 1 }.map(), 10);`,
      ],
      ['a function that is spread, then a delay written as a string', `setTimeout(...[() => 1], '10');`],
    ])('accepts %s', async (_name, source) => {
      expect(await codesOf([new NoEvalRule()], source)).toEqual([]);
    });
  });
});

describe('what the presets do with a property name', () => {
  const STANDALONE: Array<[string, () => ReturnType<typeof createStrictPreset>]> = [
    ['STRICT', () => createStrictPreset()],
    ['SECURE', () => createSecurePreset()],
  ];

  describe.each(STANDALONE)('%s', (_name, preset) => {
    it.each([
      ['a destructuring key', 'const { constructor: c } = o;'],
      ['a key held in a const', "const k = 'constructor'; const c = o[k];"],
      ['a legacy accessor', "const g = o.__lookupGetter__('x');"],
      ['a prototype function read from any object', 'const g = o.getPrototypeOf;'],
      ['the __proto__ key of an object literal', 'const p = { __proto__: o };'],
    ])('refuses %s', async (_form, source) => {
      expect(await codesOf(preset(), `const o = {}; ${source}`)).toContain('DISALLOWED_IDENTIFIER');
    });

    it.each([
      ['a key held in a variable that is another name', "const k = 'name'; const v = o[k];"],
      ['an ordinary pattern', 'const { name: v } = o;'],
      ['a run-time key', 'const read = (target, key) => target[key];'],
      ['a property whose name contains a refused word', 'const v = o.prototypeName;'],
    ])('accepts %s', async (_form, source) => {
      expect(await codesOf(preset(), `const o = {}; ${source}`)).toEqual([]);
    });
  });

  it('AgentScript leaves a key held in a variable, and the ordinary keys of a pattern, to what follows it', async () => {
    const validate = (source: string) => codesOf(createAgentScriptPreset({ allowedGlobals: ['data'] }), source);

    // The key guard answers for a variable; a field of a custom global is the host's to provide
    expect(await validate("const key = 'fetch'; const v = data[key];")).toEqual([]);
    expect(await validate('const { fetch: v } = data;')).toEqual([]);
    // What it refuses where it is written
    expect(await validate('const v = data.fetch;')).toContain('DISALLOWED_IDENTIFIER');
    expect(await validate("const v = data['fe' + 'tch'];")).toContain('DISALLOWED_IDENTIFIER');
    expect(await validate('const { constructor: v } = data;')).toContain('NO_DANGEROUS_DESTRUCTURING');
  });
});
