import { AsyncLocalStorage } from 'node:async_hooks';

import { takeStatementMarkers, transformAgentScript } from '@enclave-vm/ast';
import * as acorn from 'acorn';
import { generate } from 'astring';

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { injectDeadlineChecks } from '../deadline-guard';
import { Enclave } from '../enclave';
import { ScoringGate } from '../scoring';
import { PortableEnclave } from '../portable-enclave';
import type { StatementEventOptions } from '../statement-events';
import type { CreateEnclaveOptions, ExecutionResult, StatementEvent } from '../types';

interface Runner {
  run(code: string, handler: undefined, options: StatementEventOptions): Promise<ExecutionResult>;
  dispose(): void;
}

const RUNTIMES: Array<[string, (options?: CreateEnclaveOptions) => Runner]> = [
  ['InterpreterAdapter', (options = {}) => new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() })],
  ['PortableEnclave', (options = {}) => new PortableEnclave(options)],
];

describe.each(RUNTIMES)('statement events on the %s', (_name, create) => {
  async function trace(code: string, options: StatementEventOptions = {}) {
    const events: StatementEvent[] = [];
    const runner = create();
    try {
      const result = await runner.run(code, undefined, { onStatement: (event) => events.push(event), ...options });
      return { result, events };
    } finally {
      runner.dispose();
    }
  }

  it('reports each statement of a script of three statements with its line', async () => {
    const { result, events } = await trace('const a = 1;\nconst b = a + 1;\nreturn b;');
    expect(result.value).toBe(2);
    expect(events.map(({ line, column, type }) => ({ line, column, type }))).toEqual([
      { line: 1, column: 0, type: 'VariableDeclaration' },
      { line: 2, column: 0, type: 'VariableDeclaration' },
      { line: 3, column: 0, type: 'ReturnStatement' },
    ]);
    expect(events.every((event, index) => index === 0 || event.step > events[index - 1].step)).toBe(true);
  });

  it('reports the statements in loops, branches and callbacks as they run, with the lines of the script', async () => {
    const code = [
      'let total = 0;',
      'for (const n of [1, 2]) {',
      '  if (n > 1) total += n; else total -= n;',
      '}',
      'const doubled = [3].map((x) => { return x * 2; });',
      'return total + doubled[0];',
    ].join('\n');
    const { result, events } = await trace(code);
    expect(result.value).toBe(7);
    expect(events.map(({ line, type }) => `${line}:${type}`)).toEqual([
      '1:VariableDeclaration',
      '2:ForOfStatement',
      '3:IfStatement',
      '3:ExpressionStatement',
      '3:IfStatement',
      '3:ExpressionStatement',
      '5:VariableDeclaration',
      '5:ReturnStatement',
      '6:ReturnStatement',
    ]);
  });

  it('reports the statements in the body of a for (let …) loop and of a sort comparator', async () => {
    const code = [
      'const seen = [];',
      'for (let i = 0; i < 2; i++) {',
      '  seen.push(() => i);',
      '}',
      'const sorted = [3, 1, 2].sort((a, b) => {',
      '  return a - b;',
      '});',
      'return [seen.map((f) => f()), sorted];',
    ].join('\n');
    const { result, events } = await trace(code);
    expect(result.value).toEqual([
      [0, 1],
      [1, 2, 3],
    ]);
    const lines = events.map(({ line, type }) => `${line}:${type}`);
    expect(lines.filter((line) => line === '3:ExpressionStatement')).toHaveLength(2);
    expect(lines.filter((line) => line === '6:ReturnStatement').length).toBeGreaterThanOrEqual(2);
    expect(lines).toContain('5:VariableDeclaration');
  });

  it('keeps a var that is the body of an if in the scope it has without the hook', async () => {
    const { result, events } = await trace('if (true) var a = 1;\nreturn a;');
    expect(result.value).toBe(1);
    expect(events.map(({ line, column, type }) => `${line}:${column}:${type}`)).toEqual([
      '1:0:IfStatement',
      '1:10:VariableDeclaration',
      '2:0:ReturnStatement',
    ]);
  });

  it('ends the run with the hook error at once, while another parallel() task still waits for a tool', async () => {
    const runner = create({ toolHandler: () => new Promise((resolve) => setTimeout(resolve, 3000)) });
    const started = Date.now();
    try {
      const result = await runner.run(
        [
          'return await parallel([1, 2], async (n) => {',
          "  if (n === 1) return await callTool('slow', {});",
          '  return n;',
          '});',
        ].join('\n'),
        undefined,
        {
          onStatement: (event) => {
            if (event.line === 3) throw new Error('tracer down');
          },
        },
      );
      expect(result.error).toMatchObject({ name: 'StatementHookError', code: 'STATEMENT_HOOK_FAILED' });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      runner.dispose();
    }
  });

  it('reports no more than maxStatementEvents statements and still runs the script to its end', async () => {
    const { result, events } = await trace('let n = 0;\nfor (const i of [1, 2, 3, 4, 5]) { n += i; }\nreturn n;', {
      maxStatementEvents: 3,
    });
    expect(result.value).toBe(15);
    expect(events).toHaveLength(3);
  });

  it('carries no value of the script', async () => {
    const { events } = await trace("const secret = 'value-7f3a';\nreturn secret;");
    expect(JSON.stringify(events)).not.toContain('value-7f3a');
    for (const event of events) expect(Object.keys(event).sort()).toEqual(['column', 'line', 'step', 'type']);
  });

  it('ends the run with an error that names the hook when the hook throws', async () => {
    const runner = create();
    try {
      const result = await runner.run('const a = 1;\nreturn a;', undefined, {
        onStatement: () => {
          throw new Error('tracer down');
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ name: 'StatementHookError', code: 'STATEMENT_HOOK_FAILED' });
      expect(result.error?.message).toContain('onStatement');
    } finally {
      runner.dispose();
    }
  });

  it('ends the run with the hook error when the hook throws inside a parallel() task, or returns a promise', async () => {
    for (const onStatement of [
      (event: StatementEvent) => {
        if (event.line === 2) throw new Error('tracer down');
      },
      async () => {
        throw new Error('tracer down');
      },
    ]) {
      const runner = create();
      try {
        const result = await runner.run('return await parallel([1, 2], async (n) => {\n  return n;\n});', undefined, {
          onStatement,
        });
        expect(result.error).toMatchObject({ name: 'StatementHookError', code: 'STATEMENT_HOOK_FAILED' });
      } finally {
        runner.dispose();
      }
    }
  });

  it('reports nothing and changes nothing without the hook', async () => {
    const runner = create();
    try {
      expect((await runner.run('const a = 1;\nreturn a;', undefined, {})).value).toBe(1);
    } finally {
      runner.dispose();
    }
  });
});

describe('statement markers through the deadline instrumentation', () => {
  const parse = (source: string) =>
    acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });

  it('keeps each marker on its statement, and a real directive first', () => {
    const transformed = transformAgentScript(
      "'use strict';\nconst x = 2;\nconst f = () => { const y = x; return y; };\nreturn f();",
      {
        statementMarkers: true,
        maxIterations: 100,
      },
    );
    const ast = parse(transformed);
    injectDeadlineChecks(ast, parse);
    const program = parse(generate(ast));
    const locations = takeStatementMarkers(program);
    const marked: string[] = [];
    const visit = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const location = locations.get(node);
      if (location) marked.push(`${location.line}:${location.type}=${(node as { type: string }).type}`);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    };
    visit(program);
    expect(marked).toEqual([
      '2:VariableDeclaration=VariableDeclaration',
      '3:VariableDeclaration=VariableDeclaration',
      '3:VariableDeclaration=VariableDeclaration',
      '3:ReturnStatement=ReturnStatement',
      '4:ReturnStatement=ReturnStatement',
    ]);
    expect(generate(program)).toMatch(/async function __ag_main\(\) \{\s*["']use strict["'];/);
  });
});

describe('statement event options', () => {
  it('scores the script without its markers', async () => {
    const scored: string[] = [];
    const enclave = new Enclave({
      sandboxAdapter: new InterpreterAdapter(),
      scoringGate: { scorer: 'rule-based', blockThreshold: 100 },
    });
    const spy = jest.spyOn(ScoringGate.prototype, 'evaluate').mockImplementation(async (code: string) => {
      scored.push(code);
      return { allowed: true, totalScore: 0, riskLevel: 'none', signals: [], latencyMs: 0, cached: false } as never;
    });
    try {
      await enclave.run('const a = 1;\nreturn a;', undefined, { onStatement: () => undefined });
      expect(scored).toHaveLength(1);
      expect(scored[0]).not.toContain('__ag_statement');
    } finally {
      spy.mockRestore();
      enclave.dispose();
    }
  });

  it('ends the run at its deadline when the hook used the time', async () => {
    const enclave = new Enclave({ timeout: 100, sandboxAdapter: new InterpreterAdapter() });
    try {
      const result = await enclave.run('return 1;', undefined, {
        onStatement: () => {
          const until = Date.now() + 150;
          while (Date.now() < until) {
            // busy
          }
        },
      });
      expect(result.error?.code).toBe('EXECUTION_TIMEOUT');
    } finally {
      enclave.dispose();
    }
  });

  it('calls the hook in the async context of the caller of run()', async () => {
    const storage = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const enclave = new Enclave({ sandboxAdapter: new InterpreterAdapter() });
    try {
      await storage.run('request-1', () =>
        enclave.run('const a = await callTool("t", {});\nreturn a;', async () => 1, {
          onStatement: () => seen.push(storage.getStore()),
        }),
      );
      expect(seen).toEqual(['request-1', 'request-1']);
    } finally {
      enclave.dispose();
    }
  });

  it('refuses onStatement without the transform, which puts the markers in', async () => {
    const enclave = new Enclave({ transform: false, sandboxAdapter: new InterpreterAdapter() });
    try {
      await expect(enclave.run('return 1;', undefined, { onStatement: () => undefined })).rejects.toThrow(
        'onStatement needs the transform',
      );
    } finally {
      enclave.dispose();
    }
  });

  it('refuses onStatement on an adapter that does not report statements, and a bound out of range', async () => {
    const enclave = new Enclave();
    try {
      await expect(enclave.run('return 1;', undefined, { onStatement: () => undefined })).rejects.toThrow(
        'onStatement needs an adapter that reports statements',
      );
      await expect(
        new PortableEnclave().run('return 1;', undefined, { onStatement: () => undefined, maxStatementEvents: 0 }),
      ).rejects.toThrow('maxStatementEvents must be an integer of at least 1');
    } finally {
      enclave.dispose();
    }
  });
});
