import { Enclave } from '../enclave';
import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { AgentScriptRunner } from '../portable-enclave';
import { analyzeScript } from '../analysis/script-analysis';
import { scoringReviewer } from '../review/scoring-reviewer';
import type { PostReviewInput, PreReviewInput, ReviewDecision, ReviewOptions } from '../review/types';
import type { ExecutionResult, ToolHandler } from '../types';

interface ReviewedRunner {
  run(
    code: string,
    toolHandler?: ToolHandler,
    options?: { reviewContext?: Record<string, unknown> },
  ): Promise<ExecutionResult>;
  dispose(): void;
}

interface RunnerOptions {
  review?: ReviewOptions;
  maxToolCalls?: number;
  timeout?: number;
}

const PATHS: Array<[string, (options: RunnerOptions) => ReviewedRunner]> = [
  ['double VM', (options) => new Enclave(options)],
  ['interpreter adapter', (options) => new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() })],
  ['portable runner', (options) => new AgentScriptRunner({ ...options, hostFunctions: {}, maxHostFunctionCalls: 10 })],
];

const allow = (): ReviewDecision => ({ decision: 'allow' });

function recordingHandler(): jest.Mock<Promise<unknown>, [string, Record<string, unknown>]> {
  return jest.fn(async (toolName: string, args: Record<string, unknown>) => ({ toolName, args }));
}

describe.each(PATHS)('review hooks on the %s', (_path, create) => {
  const runners: ReviewedRunner[] = [];
  const runner = (options: RunnerOptions): ReviewedRunner => {
    const created = create({ maxToolCalls: 10, timeout: 1000, ...options });
    runners.push(created);
    return created;
  };
  afterEach(() => {
    for (const created of runners.splice(0)) created.dispose();
  });

  it('changes nothing without the review option', async () => {
    const handler = recordingHandler();
    const result = await runner({}).run("return await callTool('echo', { n: 1 });", handler);

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ toolName: 'echo', args: { n: 1 } });
    expect(Object.keys(result).sort()).toEqual(['stats', 'success', 'value']);
  });

  it('runs no statement when pre answers needs_changes before the run, and returns the findings', async () => {
    const handler = recordingHandler();
    const findings = [
      { rule: 'bounded-loop', message: 'Cut the list', location: { line: 2, column: 0 }, suggestion: '.slice(0, 20)' },
    ];
    const pre = jest.fn(
      (input: PreReviewInput): ReviewDecision =>
        input.phase === 'script' ? { decision: 'needs_changes', findings } : allow(),
    );

    const result = await runner({ review: { pre } }).run("await callTool('first', {}); return 1;", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(pre).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        name: 'ReviewError',
        code: 'REVIEW_NEEDS_CHANGES',
        data: { phase: 'script', decision: 'needs_changes', findings },
      }),
    );
    expect(result.error?.message).toContain('Cut the list (.slice(0, 20))');
    expect(result.review?.decisions).toEqual([
      { phase: 'script', decision: 'needs_changes', findings, durationMs: expect.any(Number) },
    ]);
  });

  it('gives pre the script, its analysis and the context of the run', async () => {
    const code = "const list = await callTool('list', { status: 'open' }); return list;";
    const inputs: PreReviewInput[] = [];
    const reviewed = runner({ review: { pre: (input) => (inputs.push(input), allow()) } });

    await reviewed.run(code, recordingHandler(), { reviewContext: { caller: 'a' } });
    await reviewed.run(code, recordingHandler(), { reviewContext: { caller: 'b' } });

    const analysis = analyzeScript(code, { callBudget: 10 });
    expect(inputs).toEqual([
      { phase: 'script', code, analysis, context: { caller: 'a' } },
      { phase: 'call', toolName: 'list', args: { status: 'open' }, callIndex: 0, analysis, context: { caller: 'a' } },
      { phase: 'script', code, analysis, context: { caller: 'b' } },
      { phase: 'call', toolName: 'list', args: { status: 'open' }, callIndex: 0, analysis, context: { caller: 'b' } },
    ]);
  });

  it('never calls the handler of a denied call, and the script sees a typed error it can handle', async () => {
    const handler = recordingHandler();
    const pre = (input: PreReviewInput): ReviewDecision =>
      input.phase === 'call' && input.toolName === 'delete' ? { decision: 'denied', reason: 'Not here' } : allow();
    const code = `
      let caught;
      try { await callTool('delete', { id: 1 }); } catch (error) { caught = { name: error.name, message: error.message }; }
      const soft = await callTool('delete', { id: 2 }, { throwOnError: false });
      const kept = await callTool('keep', { id: 3 });
      return { caught, soft, kept };
    `;

    const result = await runner({ review: { pre } }).run(code, handler);

    expect(handler.mock.calls).toEqual([['keep', { id: 3 }]]);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      caught: { name: 'ReviewError', message: 'Review denied the call to delete: Not here' },
      soft: {
        success: false,
        error: {
          name: 'ReviewError',
          message: 'Review denied the call to delete: Not here',
          toolName: 'delete',
          code: 'REVIEW_DENIED',
        },
      },
      kept: { toolName: 'keep', args: { id: 3 } },
    });
    expect(
      result.review?.decisions.map(({ phase, toolName, callIndex, decision }) => [
        phase,
        toolName,
        callIndex,
        decision,
      ]),
    ).toEqual([
      ['script', undefined, undefined, 'allow'],
      ['call', 'delete', 0, 'denied'],
      ['call', 'delete', 1, 'denied'],
      ['call', 'keep', 2, 'allow'],
    ]);
  });

  it('refuses a call that needs changes with REVIEW_NEEDS_CHANGES and the findings in the message', async () => {
    const pre = (input: PreReviewInput): ReviewDecision =>
      input.phase === 'call'
        ? { decision: 'needs_changes', findings: [{ rule: 'limit', message: 'Add a limit' }] }
        : allow();

    const result = await runner({ review: { pre } }).run(
      "return await callTool('list', {}, { throwOnError: false });",
      recordingHandler(),
    );

    expect(result.value).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'REVIEW_NEEDS_CHANGES',
        message: 'Review asks for changes to the call to list: Add a limit',
      }),
    });
  });

  it('stops the run at a call that needs approval, whatever the script catches, and says which call', async () => {
    const handler = recordingHandler();
    const pre = (input: PreReviewInput): ReviewDecision =>
      input.phase === 'call' && input.toolName === 'pay'
        ? { decision: 'needs_approval', reason: 'Payments need a human' }
        : allow();
    const code = `
      await callTool('quote', {});
      try { await callTool('pay', { amount: 5 }); } catch (error) {}
      await callTool('after', {});
      return 'finished';
    `;

    const result = await runner({ review: { pre } }).run(code, handler);

    expect(handler.mock.calls.map(([toolName]) => toolName)).toEqual(['quote']);
    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'REVIEW_NEEDS_APPROVAL',
        data: {
          phase: 'call',
          toolName: 'pay',
          callIndex: 1,
          decision: 'needs_approval',
          reason: 'Payments need a human',
          args: { amount: 5 },
        },
      }),
    );
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('reviewer down');
      },
    ],
    ['answers out of shape', () => ({ decision: 'maybe' })],
    ['answers needs_changes without findings', () => ({ decision: 'needs_changes', findings: [] })],
    ['answers nothing', () => undefined],
    ['does not answer in time', () => new Promise(() => undefined)],
  ])('ends the run with REVIEW_FAILED when a hook %s, and no further handler runs', async (_case, answer) => {
    const handler = recordingHandler();
    const pre = (input: PreReviewInput): unknown =>
      input.phase === 'call' && input.toolName === 'second' ? answer() : allow();
    const code = `
      await callTool('first', {});
      try { await callTool('second', {}); } catch (error) {}
      await callTool('third', {});
      return 1;
    `;

    const result = await runner({ review: { pre: pre as ReviewOptions['pre'], timeoutMs: 50 } }).run(code, handler);

    expect(handler.mock.calls.map(([toolName]) => toolName)).toEqual(['first']);
    expect(result.error).toEqual(expect.objectContaining({ name: 'ReviewError', code: 'REVIEW_FAILED' }));
    expect(result.review?.decisions.at(-1)).toEqual(
      expect.objectContaining({ phase: 'call', toolName: 'second', callIndex: 1, decision: 'review_failed' }),
    );
  });

  it('ends the run before its first statement when pre fails on the script', async () => {
    const handler = recordingHandler();
    const pre = (): ReviewDecision => {
      throw new Error('reviewer down');
    };

    const result = await runner({ review: { pre } }).run("await callTool('first', {}); return 1;", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result.error?.code).toBe('REVIEW_FAILED');
    expect(result.error?.message).toBe('Review failed: The review hook threw');
  });

  it('lets post replace a tool result before the script sees it, and the returned value', async () => {
    const post = (input: PostReviewInput) => {
      if (input.phase === 'call-result') return { action: 'replace' as const, value: { email: '[redacted]' } };
      if (input.phase === 'return') return { action: 'replace' as const, value: { seen: input.value, reviewed: true } };
      return { action: 'pass' as const };
    };
    const handler = jest.fn(async () => ({ email: 'someone@example.com' }));

    const result = await runner({ review: { post } }).run(
      "const user = await callTool('user', {}); return user.email;",
      handler,
    );

    expect(result.value).toEqual({ seen: '[redacted]', reviewed: true });
    expect(result.review?.decisions.map(({ phase, decision }) => [phase, decision])).toEqual([
      ['call-result', 'replace'],
      ['return', 'replace'],
    ]);
  });

  it('ends the run as denied when post stops it after a call', async () => {
    const handler = recordingHandler();
    const post = (input: PostReviewInput) =>
      input.phase === 'call-result' && input.toolName === 'read'
        ? { action: 'stop' as const, reason: 'Sensitive data' }
        : { action: 'pass' as const };

    const result = await runner({ review: { post } }).run(
      "try { await callTool('read', {}); } catch (error) {} await callTool('send', {}); return 1;",
      handler,
    );

    expect(handler.mock.calls.map(([toolName]) => toolName)).toEqual(['read']);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'REVIEW_DENIED',
        message: 'Review stopped the run: Sensitive data',
        data: { phase: 'call-result', toolName: 'read', callIndex: 0, decision: 'denied', reason: 'Sensitive data' },
      }),
    );
  });

  it('lets post review an error the script throws', async () => {
    const post = (input: PostReviewInput) =>
      input.phase === 'error'
        ? { action: 'replace' as const, value: { name: 'ScriptError', message: 'The script failed' } }
        : { action: 'pass' as const };

    const result = await runner({ review: { post } }).run("throw 'secret ' + 42;");

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ name: 'ScriptError', message: 'The script failed' });
    expect(JSON.stringify(result)).not.toContain('secret 42');
  });

  it('cannot allow a call that a limit refuses: pre never sees it', async () => {
    const pre = jest.fn((_input: PreReviewInput) => allow());
    const result = await runner({ review: { pre }, maxToolCalls: 1 }).run(
      "await callTool('first', {}); await callTool('second', {}); return 1;",
      recordingHandler(),
    );

    expect(result.success).toBe(false);
    expect(pre.mock.calls.map(([input]) => (input.phase === 'call' ? input.toolName : input.phase))).toEqual([
      'script',
      'first',
    ]);
  });

  it('never reviews a script that validation refuses', async () => {
    const pre = jest.fn(allow);
    const result = await runner({ review: { pre } }).run('return eval("1");');

    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(pre).not.toHaveBeenCalled();
  });

  it('refuses a review option or a review context that is not what it documents', () => {
    expect(() => create({ review: { pre: 'allow' } as unknown as ReviewOptions })).toThrow(
      'review.pre must be a function',
    );
    expect(() => create({ review: { timeoutMs: 0 } })).toThrow(TypeError);
    expect(() => create({ review: { failOpen: true } as unknown as ReviewOptions })).toThrow(
      'review has no option "failOpen"',
    );
  });

  it('refuses a review context that is not an object', async () => {
    await expect(runner({ review: {} }).run('return 1;', undefined, { reviewContext: 'a' as never })).rejects.toThrow(
      'reviewContext must be an object',
    );
  });
});

describe('scoringReviewer', () => {
  const LIST_THEN_SEND = `
    const users = await callTool('users.list', { limit: 50 });
    for (const user of users) {
      await callTool('email.send', { to: user.email });
    }
  `;
  const scriptInput = (code: string): PreReviewInput => ({ phase: 'script', code, analysis: analyzeScript(code) });

  it('maps the thresholds of the gate to decisions', async () => {
    const quiet = await scoringReviewer({ warnThreshold: 99, blockThreshold: 100 })(scriptInput('return 1;'));
    const warned = await scoringReviewer({ warnThreshold: 1, blockThreshold: 101 })(scriptInput(LIST_THEN_SEND));
    const blocked = await scoringReviewer({ warnThreshold: 1, blockThreshold: 2 })(scriptInput(LIST_THEN_SEND));

    expect(quiet).toEqual({ decision: 'allow', findings: [] });
    expect(warned).toEqual(
      expect.objectContaining({
        decision: 'needs_approval',
        findings: expect.arrayContaining([expect.objectContaining({ rule: 'EXFIL_PATTERN' })]),
      }),
    );
    expect(blocked).toEqual(expect.objectContaining({ decision: 'denied' }));
  });

  it('allows every call: it scores the script only', async () => {
    const decision = await scoringReviewer()({
      phase: 'call',
      toolName: 'x',
      args: {},
      callIndex: 0,
      analysis: analyzeScript(''),
    });

    expect(decision).toEqual({ decision: 'allow' });
  });

  it('fails the review when the scorer cannot answer', async () => {
    const review = scoringReviewer({
      scorer: 'external-api',
      externalApi: { endpoint: 'http://127.0.0.1:1/score', timeoutMs: 50, retries: 0 },
    });

    await expect(review(scriptInput('return 1;'))).rejects.toThrow();
  });

  it('runs behind pre and refuses a script it denies', async () => {
    const enclave = new Enclave({ review: { pre: scoringReviewer({ warnThreshold: 1, blockThreshold: 2 }) } });
    const handler = recordingHandler();
    try {
      const result = await enclave.run(LIST_THEN_SEND, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(result.error?.code).toBe('REVIEW_DENIED');
    } finally {
      enclave.dispose();
    }
  });
});

describe('AgentScriptRunner', () => {
  it('lists review among its capabilities', () => {
    expect(AgentScriptRunner.capabilities).toContain('review');
  });
});
