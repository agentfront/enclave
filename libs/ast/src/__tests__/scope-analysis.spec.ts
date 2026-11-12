import * as acorn from 'acorn';
import { analyzeScopes } from '../utils/scope-analysis';
import { walkAll, staticPropertyName } from '../utils/ast-walk';

function analyze(source: string, sourceType: 'script' | 'module' = 'script') {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true });
  return analyzeScopes(ast);
}

/** Names of the references that reach a global, in source order. */
function free(source: string, sourceType: 'script' | 'module' = 'script'): string[] {
  return analyze(source, sourceType).freeReferences.map((ref) => ref.name);
}

describe('analyzeScopes', () => {
  describe('bindings', () => {
    it('collects every declaration form', () => {
      const { bindings } = analyze(`
        var a; let b; const c = 1;
        function d(e, { f, g: h }, [i, ...j], k = 1) {}
        const l = (m) => m;
        try {} catch (n) {}
        for (const o of []) {}
        class p {}
      `);
      expect(bindings.map((binding) => binding.name).sort()).toEqual('abcdefhijklmnop'.split('').sort());
    });

    it('records how each name was bound', () => {
      const { bindings } = analyze('var a; let b; const c = 1; function d(e) {} try {} catch (f) {} class g {}');
      expect(Object.fromEntries(bindings.map((binding) => [binding.name, binding.kind]))).toEqual({
        a: 'var',
        b: 'let',
        c: 'const',
        d: 'function',
        e: 'param',
        f: 'catch',
        g: 'class',
      });
    });

    it('collects import bindings', () => {
      const { bindings } = analyze("import a, { b as c } from 'x'; import * as d from 'y';", 'module');
      expect(bindings.map((binding) => binding.name).sort()).toEqual(['a', 'c', 'd']);
    });
  });

  describe('resolution is lexical', () => {
    it('resolves a reference to a declaration in the same scope, before or after it', () => {
      expect(free('const a = 1; a;')).toEqual([]);
      expect(free('a; let a = 1;')).toEqual([]);
    });

    it('resolves through enclosing scopes', () => {
      expect(free('const a = 1; { { const f = () => a; } }')).toEqual([]);
    });

    it.each([
      ['a block', '{ let a = 1; } a;'],
      ['a nested block', '{ { const a = 1; } a; }'],
      ['an arrow parameter', 'const f = (a) => 0; a;'],
      ['a destructured arrow parameter', 'const f = ({ a }, [b]) => 0; a; b;'],
      ['a function parameter', 'function f(a) {} a;'],
      ['a function body', 'function f() { let a; } a;'],
      ['a catch binding', 'try {} catch (a) {} a;'],
      ['a for head', 'for (let a = 0; a < 1; a++) {} a;'],
      ['a for-of head', 'for (const a of []) {} a;'],
      ['a for-in head', 'for (const a in {}) {} a;'],
      ['a switch block', 'switch (1) { case 1: let a; } a;'],
      ['a class body name', 'const C = class a {}; a;'],
      ['a named function expression', 'const f = function a() {}; a;'],
    ])('does not leak a name out of %s', (_name, source) => {
      expect(free(source)).toContain('a');
    });

    it('hoists `var` to the enclosing function, not beyond it', () => {
      expect(free('{ var a = 1; } a;')).toEqual([]);
      expect(free('for (var a = 0; a < 1; a++) {} a;')).toEqual([]);
      expect(free('const f = () => { { var a = 1; } return a; }; a;')).toEqual(['a']);
    });

    it('binds a function declaration in the scope it is written in only', () => {
      expect(free('function f() {} f();')).toEqual([]);
      expect(free('{ function f() {} } f();')).toEqual(['f']);
    });

    it('resolves a function expression name inside the function', () => {
      expect(free('const g = function f() { return f; };')).toEqual([]);
    });

    it('does not let a parameter default see what the function body declares', () => {
      // A default value is evaluated in the parameter scope; the body's declarations are not
      // visible there, so these references reach the enclosing (global) binding.
      expect(free('const f = (x = a) => { let a; return x; };')).toEqual(['a']);
      expect(free('const f = (x = a) => { const a = 1; return x; };')).toEqual(['a']);
      expect(free('const f = (x = a) => { var a; return x; };')).toEqual(['a']);
      expect(free('const f = ({ k = a }) => { let a; return k; };')).toEqual(['a']);
      expect(free('const f = ([k = a]) => { let a; return k; };')).toEqual(['a']);
      expect(free('function f(x = a) { let a; return x; }')).toEqual(['a']);
      expect(free('const f = function (x = a) { let a; return x; };')).toEqual(['a']);
    });

    it('lets a parameter default see the other parameters, and the body see the parameters', () => {
      expect(free('const f = (a, b = a) => a + b;')).toEqual([]);
      expect(free('const f = (a) => { let b = a; return b; };')).toEqual([]);
      expect(free('const f = (a) => { { var hoisted = a; } return hoisted; };')).toEqual([]);
    });

    it('resolves each same-named declaration in its own scope', () => {
      expect(free('for (const a of []) { a; } for (const a of []) { a; }')).toEqual([]);
    });
  });

  describe('what counts as a reference', () => {
    it('ignores property names, labels and meta properties', () => {
      expect(free('const o = { a: 1, b() {} }; o.c; o?.d; e: for (;;) { break e; }')).toEqual([]);
      expect(free('function f() { return new.target; }')).toEqual([]);
    });

    it('treats computed keys and shorthand properties as references', () => {
      expect(free('const o = {}; o[a]; ({ [b]: 1 }); ({ c });')).toEqual(['a', 'b', 'c']);
    });

    it('treats destructuring keys as names and computed keys as references', () => {
      expect(free('const { a: x, [k]: y } = {}; x; y;')).toEqual(['k']);
    });

    it('sees default values inside patterns', () => {
      expect(free('const { a = d1 } = {}; const [b = d2] = []; const f = (c = d3) => 0;')).toEqual(['d1', 'd2', 'd3']);
    });

    it('treats `typeof name` as a read', () => {
      const [ref] = analyze('typeof a;').references;
      expect(ref).toMatchObject({ name: 'a', read: true, write: false, resolved: false });
    });
  });

  describe('writes', () => {
    const writes = (source: string) =>
      analyze(source)
        .references.filter((ref) => ref.write)
        .map((ref) => `${ref.name}:${ref.read ? 'rw' : 'w'}`);

    it.each([
      ['plain assignment', 'a = 1;', ['a:w']],
      ['compound assignment', 'a += 1;', ['a:rw']],
      ['logical assignment', 'a ||= 1;', ['a:rw']],
      ['update expression', 'a++; --b;', ['a:rw', 'b:rw']],
      ['array destructuring', '[a, [b], ...c] = [];', ['a:w', 'b:w', 'c:w']],
      ['object destructuring', '({ a, b: c, ...d } = {});', ['a:w', 'c:w', 'd:w']],
      ['destructuring with a default', '[a = 1] = [];', ['a:w']],
      ['for-of head', 'for (a of []) {}', ['a:w']],
      ['for-in head', 'for (a in {}) {}', ['a:w']],
      ['for-of head pattern', 'for ([a, { b }] of []) {}', ['a:w', 'b:w']],
      ['delete', 'delete a;', ['a:w']],
    ])('records %s', (_name, source, expected) => {
      expect(writes(source)).toEqual(expected);
    });

    it('does not record a write for a member assignment, only a read of its object', () => {
      const { references } = analyze('a.b = c; [d.e] = f;');
      expect(references.map((ref) => `${ref.name}:${ref.write ? 'w' : 'r'}`)).toEqual(['a:r', 'c:r', 'd:r', 'f:r']);
    });

    it('resolves a write against the scopes that enclose it', () => {
      const [outer, inner] = analyze('{ let a; } a = 1; { let b; b = 1; }').references;
      expect(outer).toMatchObject({ name: 'a', resolved: false });
      expect(inner).toMatchObject({ name: 'b', resolved: true });
    });
  });

  it('accepts anything that is not an AST', () => {
    expect(analyzeScopes(null).references).toEqual([]);
    expect(analyzeScopes({}).bindings).toEqual([]);
  });
});

describe('walkAll', () => {
  it('visits every node once, parents first, with its ancestors', () => {
    const ast = acorn.parse('const [a] = b; c = () => d;', { ecmaVersion: 'latest' });
    const seen: string[] = [];
    walkAll(ast, (node, ancestors, key) => {
      if (node.type === 'Identifier') seen.push(`${node.name}@${ancestors[ancestors.length - 1].type}.${key}`);
    });
    expect(seen).toEqual([
      'a@ArrayPattern.elements',
      'b@VariableDeclarator.init',
      'c@AssignmentExpression.left',
      'd@ArrowFunctionExpression.body',
    ]);
  });

  it('reaches identifiers in assignment-target and binding positions', () => {
    const ast = acorn.parse('x = 1; [y] = []; for (z of []) {} try {} catch ({ w }) {}', { ecmaVersion: 'latest' });
    const names: string[] = [];
    walkAll(ast, (node) => {
      if (node.type === 'Identifier') names.push(node.name);
    });
    expect(names).toEqual(expect.arrayContaining(['x', 'y', 'z', 'w']));
  });

  it('ignores non-node input', () => {
    const visit = jest.fn();
    walkAll(undefined, visit);
    walkAll('Program', visit);
    expect(visit).not.toHaveBeenCalled();
  });
});

describe('staticPropertyName', () => {
  const key = (source: string) => {
    const expression = (acorn.parse(`(${source})`, { ecmaVersion: 'latest' }) as any).body[0].expression;
    return staticPropertyName(expression.property, expression.computed);
  };

  it('reads dot, string, number and static template keys', () => {
    expect(key('o.a')).toBe('a');
    expect(key("o['a']")).toBe('a');
    expect(key('o[1]')).toBe('1');
    expect(key('o[`a`]')).toBe('a');
  });

  it('returns undefined for a key that needs evaluation', () => {
    expect(key('o[a]')).toBeUndefined();
    expect(key('o[`a${b}`]')).toBeUndefined();
    expect(key("o['a' + 'b']")).toBeUndefined();
    expect(staticPropertyName(undefined, false)).toBeUndefined();
  });
});
