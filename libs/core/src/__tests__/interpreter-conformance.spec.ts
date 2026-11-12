/**
 * Interpreter Conformance Tests
 *
 * The interpreter adapter runs the same language as the VM adapters: a script the validator
 * accepts has to behave the same on both. Each case here is run twice, through an `Enclave` with
 * its default sandbox (the double VM) and through an `Enclave` whose `sandboxAdapter` is the
 * `InterpreterAdapter`, and the two outcomes are compared: the same value, or a failure with the
 * same message.
 *
 * The default sandbox is the reference. A difference means the interpreter is wrong, or that the
 * language grew a construct the interpreter does not have yet: both are caught here rather than
 * by a host that picked the interpreter for a runtime without `node:vm`.
 *
 * @packageDocumentation
 */

import { transformAgentScript } from '@enclave-vm/ast';

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';
import type { ExecutionContext, ExecutionResult, ToolHandler } from '../types';

const CORPUS: Array<[string, string]> = [
  [
    'string concatenation and addition',
    `let t = 0; t = t + 2; const s = 'n=' + t; return [t, s, 1 + '2', 'a' + null];`,
  ],
  ['template literals', 'const n = 2; return `v ${n} and ${n + 1} ${[1, 2]} ${null}`;'],
  ['for...of over an array', `let s = 0; for (const x of [1, 2, 3]) { s = s + x; } return s;`],
  ['for...of over a string', `let out = ''; for (const ch of 'abc') { out = ch + out; } return out;`],
  ['for with i++', `let s = 0; for (let i = 0; i < 4; i++) { s += i; } return s;`],
  [
    'break and continue',
    `let s = 0; for (let i = 0; i < 10; i++) { if (i === 2) continue; if (i === 5) break; s += i; } return s;`,
  ],
  [
    'update expressions',
    `let a = 1; const b = a++; const c = ++a; let d = 5; d--; --d; const o = { n: 1 }; o.n++; ++o.n; return [a, b, c, d, o.n];`,
  ],
  [
    'member assignment',
    `const o = { a: 1, list: [1, 2] }; o.a = 2; o.b = 'x'; o.list[0] = 5; o.list[2] = 7; return o;`,
  ],
  ['computed keys', `const o = { a: 1 }; const k = 'b'; o[k] = 2; const r = o['a'] + o[k]; return [r, o];`],
  [
    'compound assignment',
    `let a = 10; a -= 3; a *= 2; a /= 7; a %= 5; a **= 3; let b = null; b ??= 4; let c = 0; c ||= 9; let d = 1; d &&= 6; let e = 6; e |= 1; e &= 5; e ^= 2; e <<= 2; e >>= 1; return [a, b, c, d, e];`,
  ],
  [
    'optional chaining and nullish coalescing',
    `const o = { a: { b: 1 }, f: null }; return [o?.a?.b, o.x?.y, o.f?.(), o.a?.['b'], o.x ?? 'dflt'];`,
  ],
  [
    'switch',
    `const pick = (v) => { switch (v) { case 1: return 'one'; case 2: case 3: return 'few'; default: return 'many'; } }; return [pick(1), pick(3), pick(9)];`,
  ],
  [
    'switch fall-through and break',
    `let out = []; for (const v of [1, 2, 3]) { switch (v) { case 1: out.push('a'); case 2: out.push('b'); break; default: out.push('c'); } } return out;`,
  ],
  ['catching a thrown string', `try { throw 'boom'; } catch (e) { return 'caught ' + e; }`],
  ['catching a thrown object', `try { throw { code: 7 }; } catch (e) { return e.code; }`],
  [
    'finally runs after return',
    `const log = []; const f = () => { try { log.push('t'); return 1; } finally { log.push('f'); } }; const r = f(); return [r, log];`,
  ],
  ['catching a runtime error', `try { const x = null; return x.y; } catch (e) { return typeof e.message; }`],
  ['rethrowing from a catch', `try { try { throw 'inner'; } catch (e) { throw e + '!'; } } catch (e2) { return e2; }`],
  ['an uncaught thrown string', `throw 'the script gave up';`],
  ['a tool call', `const r = await callTool('math:add', { a: 2, b: 3 }); return r;`],
  [
    'catching a tool failure',
    `try { await callTool('always:fails', {}); return 'no'; } catch (e) { return [typeof e.message, e.message.includes('tool failed')]; }`,
  ],
  [
    'a tool failure as a result',
    `const r = await callTool('always:fails', {}, { throwOnError: false }); return [r.success, typeof r.error.message];`,
  ],
  [
    'a tool success as a result',
    `const r = await callTool('math:add', { a: 1, b: 1 }, { throwOnError: false }); return [r.success, r.data];`,
  ],
  [
    'tool arguments arrive as data',
    `const r = await callTool('echo:args', { list: [1, { x: 2 }], s: 'v', n: null }); return r;`,
  ],
  [
    'parallel',
    `const out = await parallel([1, 2, 3], async (n) => { const r = await callTool('math:add', { a: n, b: 10 }); return r; }); return out;`,
  ],
  [
    'destructuring with defaults and rest',
    `const { a, b: { c }, d = 4, ...rest } = { a: 1, b: { c: 2 }, e: 5, f: 6 }; const [x, , y = 9, ...tail] = [1, 2, undefined, 4, 5]; return [a, c, d, rest, x, y, tail];`,
  ],
  [
    'spread',
    `const a = [1, 2]; const b = [...a, 3]; const o = { ...{ x: 1 }, y: 2 }; const m = Math.max(...b); return [b, o, m];`,
  ],
  [
    'closures',
    `const counter = () => { let n = 0; return () => { n += 1; return n; }; }; const c = counter(); c(); c(); return c();`,
  ],
  ['recursion', `const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)); return fib(12);`],
  [
    'default and rest parameters',
    `const f = (a, b = a * 2, ...more) => [a, b, more.length]; return [f(1), f(1, 5, 6, 7)];`,
  ],
  [
    'function declarations',
    `function add(a, b) { return a + b; } function twice(f, v) { return f(f(v, 1), 1); } return twice(add, 3);`,
  ],
  [
    'array methods',
    `const xs = [3, 1, 2]; const m = xs.map((x) => x * 2); const f = m.filter((x) => x > 2); const r = xs.reduce((acc, x) => acc + x, 0); const sorted = [...xs].sort((p, q) => p - q); return [m, f, r, sorted, xs.includes(2), xs.indexOf(1), xs.slice(1), xs.join('-'), xs.find((x) => x > 1), xs.some((x) => x > 2), xs.every((x) => x > 0)];`,
  ],
  [
    'array mutation',
    `const xs = [1]; xs.push(2, 3); const p = xs.pop(); xs.unshift(0); const sh = xs.shift(); xs.reverse(); return [xs, p, sh, xs.length];`,
  ],
  [
    'string methods',
    `const s = '  Hello World  '; return [s.trim(), s.toUpperCase().trim(), s.split(' ').filter((w) => w).length, s.includes('World'), s.trim().slice(0, 5), 'a-b'.replace('-', '+'), '7'.padStart(3, '0'), 'abc'.charAt(1), 'abc'.length, 'a,b'.split(',')];`,
  ],
  [
    'Object and Array helpers',
    `const o = { a: 1, b: 2 }; return [Object.keys(o), Object.values(o), Object.entries(o), Array.isArray([]), Array.isArray(o)];`,
  ],
  [
    'Number, String, Math and JSON',
    `return [Number('42'), String(12), Math.round(2.6), Math.min(3, 1), JSON.stringify({ a: [1, 2] }), JSON.parse('{"x": [1, 2]}').x[1], Number.isInteger(5), (3.14159).toFixed(2), typeof Date.now(), NaN !== NaN, 1 / 0 === Infinity];`,
  ],
  [
    'operators',
    `const a = 7; return [a % 3, a ** 2, -a, +'3', !a, typeof a, typeof undefined, a > 3 && a < 9, a === 7 ? 'y' : 'n', (1, 2), void 0, 5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 3, -8 >> 1, 'a' in { a: 1 }, null ?? 'd', 0 || 'e'];`,
  ],
  [
    'nested data',
    `const data = { users: [{ name: 'a', tags: ['x'] }, { name: 'b', tags: [] }] }; const names = data.users.filter((u) => u.tags.length > 0).map((u) => u.name); data.users[1].tags.push('y'); return [names, data.users[1].tags.length];`,
  ],
  ['a Date', `const d = new Date(86400000); return [d.getTime(), d.toISOString()];`],
  ['the iteration limit', `let n = 0; for (let i = 0; i < 100000000; i++) { n += 1; } return n;`],
  [
    'the tool-call limit',
    `for (let i = 0; i < 50; i++) { await callTool('math:add', { a: i, b: 1 }); } return 'done';`,
  ],
  ['a blocked key built at run time', `const o = {}; const k = 'const' + 'ructor'; return typeof o[k];`],
  ['returning a function', `return { label: 'x', run: () => 1 };`],
  ['returning nothing', `const x = 1;`],
];

const toolHandler: ToolHandler = async (name, args) => {
  if (name === 'math:add') return (args['a'] as number) + (args['b'] as number);
  if (name === 'echo:args') return { got: args, keys: Object.keys(args) };
  throw new Error(`tool failed: ${name}`);
};

const OPTIONS = { toolHandler, maxToolCalls: 20, maxIterations: 5000, timeout: 5000 };

/** What an execution came to: its value, or the first line of its error. */
function outcome(result: ExecutionResult<unknown>): { value: unknown } | { failure: string } {
  if (result.success) return { value: result.value };
  return { failure: (result.error?.message ?? '').split('\n')[0] };
}

describe('Interpreter Conformance: the interpreter adapter runs AgentScript like the default sandbox', () => {
  it.each(CORPUS)('%s', async (_name, code) => {
    const reference = new Enclave(OPTIONS);
    const interpreted = new Enclave({ ...OPTIONS, sandboxAdapter: new InterpreterAdapter() });
    try {
      const expected = outcome(await reference.run(code));
      const actual = outcome(await interpreted.run(code));

      expect(actual).toEqual(expected);
    } finally {
      reference.dispose();
      interpreted.dispose();
    }
  });

  describe('what an execution is given', () => {
    /** Run a script on both sandboxes with the same options; report outcome and console lines. */
    async function onBoth(code: string, options: Record<string, unknown>) {
      const runs: Array<{ outcome: ReturnType<typeof outcome>; lines: string[] }> = [];
      for (const adapter of [undefined, new InterpreterAdapter()]) {
        const lines: string[] = [];
        const enclave = new Enclave({
          ...options,
          toolHandler: async (tool: string, args: Record<string, unknown>) => ({ tool, args }),
          consoleHandler: (level, text) => {
            lines.push(`${level}|${text}`);
          },
          ...(adapter ? { sandboxAdapter: adapter } : {}),
        });
        try {
          runs.push({ outcome: outcome(await enclave.run(code)), lines });
        } finally {
          enclave.dispose();
        }
      }
      return { reference: runs[0], interpreted: runs[1] };
    }

    it('console calls reach the handler as the same lines', async () => {
      const { reference, interpreted } = await onBoth(
        `console.log('a', { b: 1 }, [1, 2], null, undefined, 3.5, true); console.warn('w'); console.error({ e: 'x' }); console.info('i', 'j'); return 1;`,
        {},
      );

      expect(reference.lines).toHaveLength(4);
      expect(interpreted).toEqual(reference);
    });

    it('custom globals can be read the same way', async () => {
      const { reference, interpreted } = await onBoth(`return [settings.region, settings.list.length, limit];`, {
        globals: { settings: { region: 'eu', list: [1, 2] }, limit: 5 },
      });

      expect(reference.outcome).toEqual({ value: ['eu', 2, 5] });
      expect(interpreted).toEqual(reference);
    });

    it('custom globals cannot be changed on either, and the host object stays as it was', async () => {
      const settings = { region: 'eu' };
      const { reference, interpreted } = await onBoth(`settings.region = 'us'; return settings.region;`, {
        globals: { settings },
      });

      expect('failure' in reference.outcome).toBe(true);
      expect('failure' in interpreted.outcome).toBe(true);
      expect(settings).toEqual({ region: 'eu' });
    });

    it('tool namespaces call the same tools', async () => {
      const { reference, interpreted } = await onBoth(`const r = await mail.send({ to: 'x' }); return r;`, {
        toolNamespaces: { mail: ['send'] },
      });

      expect(reference.outcome).toEqual({ value: { tool: 'mail.send', args: { to: 'x' } } });
      expect(interpreted).toEqual(reference);
    });
  });

  describe('without an Enclave (transform + adapter, as on a runtime without node:vm)', () => {
    function context(): ExecutionContext {
      return {
        config: { maxToolCalls: 20, timeout: 5000 },
        stats: { duration: 0, toolCallCount: 0, iterationCount: 0, startTime: 0 },
        abortController: new AbortController(),
        aborted: false,
        toolHandler,
      } as unknown as ExecutionContext;
    }

    it.each([{ transformLoops: false }, {}])(
      'the same corpus gives the same values with transform options %j',
      async (options) => {
        const differences: string[] = [];
        for (const [name, code] of CORPUS) {
          // The limits of the Enclave do not exist on this path, and `parallel` is its global.
          if (name.endsWith('limit') || name === 'parallel') continue;
          const reference = new Enclave(OPTIONS);
          const expected = outcome(await reference.run(code));
          reference.dispose();
          // There is no validator on this path: a script the validator refuses is not comparable.
          if ('failure' in expected && expected.failure.startsWith('AgentScript validation failed')) continue;

          const actual = outcome(
            await new InterpreterAdapter().execute(transformAgentScript(code, options), context()),
          );
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            differences.push(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
          }
        }

        expect(differences).toEqual([]);
      },
    );
  });
});
