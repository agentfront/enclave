import * as path from 'path';

import { Enclave } from '../enclave';
import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { AgentScriptRunner } from '../portable-enclave';
import { analyzeScript } from '../analysis/script-analysis';
import { functionReviewer, providerReviewer, type ReviewerRequest } from '../review/reviewers';
import type { PreReviewInput, ReviewOptions } from '../review/types';
import type { ExecutionResult, ToolHandler } from '../types';

const API_KEY = 'sk-test-key-6b1e0c';
const POLICY = 'Scripts may read invoices. Sending email needs a person.';
const TOOLS = [{ name: 'list_invoices', description: 'Lists invoices by status' }];
const SCRIPT = "const invoices = await callTool('list_invoices', { status: 'overdue' }); return invoices;";

interface Runner {
  run(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult>;
  dispose(): void;
}

const PATHS: Array<[string, (review: ReviewOptions) => Runner]> = [
  ['double VM', (review) => new Enclave({ review })],
  ['interpreter adapter', (review) => new Enclave({ review, sandboxAdapter: new InterpreterAdapter() })],
  ['portable runner', (review) => new AgentScriptRunner({ review, hostFunctions: {}, maxHostFunctionCalls: 10 })],
];

function modelReply(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });
}

const NEEDS_CHANGES = {
  decision: 'needs_changes',
  reason: '',
  findings: [
    {
      rule: 'limit',
      message: 'List fewer invoices',
      line: 1,
      column: 23,
      suggestion: 'Add { limit: 20 }',
      toolName: 'list_invoices',
    },
  ],
};

function openAi(options: Partial<Parameters<typeof providerReviewer>[0]> = {}) {
  return providerReviewer({
    provider: 'openai',
    apiKey: API_KEY,
    model: 'gpt-test',
    policy: POLICY,
    tools: TOOLS,
    ...options,
  });
}

function scriptInput(code = SCRIPT): PreReviewInput {
  return { phase: 'script', code, analysis: analyzeScript(code) };
}

async function runOn(create: (review: ReviewOptions) => Runner, review: ReviewOptions, code = SCRIPT) {
  const runner = create(review);
  try {
    return await runner.run(code, async () => ({ items: [] }));
  } finally {
    runner.dispose();
  }
}

describe('reviewers', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe.each(PATHS)('on the %s', (_path, create) => {
    it('brings a needs_changes answer of the provider to the result with its findings', async () => {
      fetchSpy.mockResolvedValue(modelReply(NEEDS_CHANGES));

      const result = await runOn(create, { pre: openAi() });

      expect(result.error).toEqual(
        expect.objectContaining({
          code: 'REVIEW_NEEDS_CHANGES',
          data: {
            phase: 'script',
            decision: 'needs_changes',
            findings: [
              {
                rule: 'limit',
                message: 'List fewer invoices',
                location: { line: 1, column: 23 },
                suggestion: 'Add { limit: 20 }',
                toolName: 'list_invoices',
              },
            ],
          },
        }),
      );
    });

    it('ends the run with REVIEW_FAILED when the provider does not answer in time', async () => {
      fetchSpy.mockImplementation(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      );

      const result = await runOn(create, { pre: openAi({ timeoutMs: 50 }) });

      expect(result.error?.code).toBe('REVIEW_FAILED');
      expect(result.error?.message).toBe('Review failed: The reviewer did not answer within 50 ms');
    });

    it.each([
      [
        'an answer that is not JSON',
        () => new Response(JSON.stringify({ choices: [{ message: { content: 'allow it' } }] })),
      ],
      ['an answer outside the schema', () => modelReply({ decision: 'yes', reason: '', findings: [] })],
      ['needs_changes without findings', () => modelReply({ decision: 'needs_changes', reason: '', findings: [] })],
      ['a refusal without content', () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'no' } }] }))],
      ['an HTTP error', () => new Response('{"error":"bad"}', { status: 500 })],
    ])('ends the run with REVIEW_FAILED on %s', async (_case, reply) => {
      fetchSpy.mockImplementation(async () => reply());

      const result = await runOn(create, { pre: openAi() });

      expect(result.error?.code).toBe('REVIEW_FAILED');
    });
  });

  it('sends the policy as instructions and the script, analysis and tools as untrusted data', async () => {
    fetchSpy.mockResolvedValue(modelReply({ decision: 'allow', reason: '', findings: [] }));

    await openAi()(scriptInput());

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(body.model).toBe('gpt-test');
    expect(body.response_format).toEqual(
      expect.objectContaining({ type: 'json_schema', json_schema: expect.objectContaining({ strict: true }) }),
    );
    expect(body.messages[0]).toEqual({ role: 'system', content: expect.stringContaining(POLICY) });
    expect(body.messages[0].content).not.toContain(SCRIPT);
    expect(body.messages[1].content.startsWith('UNTRUSTED DATA (JSON):\n')).toBe(true);
    expect(JSON.parse(body.messages[1].content.slice('UNTRUSTED DATA (JSON):\n'.length))).toEqual({
      code: SCRIPT,
      analysis: analyzeScript(SCRIPT),
      tools: TOOLS,
    });
  });

  it('gives a function reviewer the same input as the provider reviewer', async () => {
    fetchSpy.mockResolvedValue(modelReply({ decision: 'allow', reason: '', findings: [] }));
    const received: ReviewerRequest[] = [];

    await openAi()(scriptInput());
    await functionReviewer((request) => (received.push(request), { decision: 'allow' }), {
      policy: POLICY,
      tools: TOOLS,
    })(scriptInput());

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const sent = JSON.parse(body.messages[1].content.slice('UNTRUSTED DATA (JSON):\n'.length));
    expect(received).toEqual([{ ...sent, policy: POLICY }]);
    expect(body.messages[0].content.endsWith(POLICY)).toBe(true);
  });

  it('keeps a decision by the SHA-256 of the script, and not a failure', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => modelReply({ decision: 'allow', reason: '', findings: [] }));
    const review = openAi();

    await expect(review(scriptInput())).rejects.toThrow('status 503');
    await review(scriptInput());
    await review(scriptInput());
    await review(scriptInput('return 2;'));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('asks every time without a cache', async () => {
    const answer = jest.fn(() => ({ decision: 'allow' as const }));
    const review = functionReviewer(answer, { cache: false });

    await review(scriptInput());
    await review(scriptInput());

    expect(answer).toHaveBeenCalledTimes(2);
  });

  it('times out a function reviewer and allows every call without asking', async () => {
    const slow = functionReviewer(() => new Promise(() => undefined), { timeoutMs: 30 });
    const answer = jest.fn(() => ({ decision: 'denied' as const, reason: 'no' }));

    await expect(slow(scriptInput())).rejects.toThrow('The reviewer did not answer within 30 ms');
    await expect(
      functionReviewer(answer)({ phase: 'call', toolName: 'x', args: {}, callIndex: 0, analysis: analyzeScript('') }),
    ).resolves.toEqual({ decision: 'allow' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('keeps the API key out of results, errors and logs', async () => {
    const logged: unknown[] = [];
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args)),
    );
    const replies = [
      () => Promise.reject(new Error(`connect failed for Bearer ${API_KEY}`)),
      async () =>
        new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${API_KEY}` } }), { status: 401 }),
      async () => modelReply({ decision: 'denied', reason: 'no', findings: [] }),
    ];
    try {
      for (const reply of replies) {
        fetchSpy.mockImplementation(reply);
        const enclave = new Enclave({ review: { pre: openAi({ cache: false }) } });
        try {
          const result = await enclave.run(SCRIPT, async () => 1);
          expect(JSON.stringify(result)).not.toContain(API_KEY);
        } finally {
          enclave.dispose();
        }
        const direct = await openAi({ cache: false })(scriptInput()).catch(
          (error: Error) => `${error.name}: ${error.message}`,
        );
        expect(JSON.stringify(direct)).not.toContain(API_KEY);
      }
      expect(JSON.stringify(logged)).not.toContain(API_KEY);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('trims the trailing slashes of baseUrl in linear time, also for a long run of slashes', async () => {
    fetchSpy.mockImplementation(async () => modelReply({ decision: 'allow', reason: '', findings: [] }));
    const slashes = '/'.repeat(200_000);

    const started = Date.now();
    openAi({ baseUrl: `https://api.example.com${slashes}x` });
    openAi({ baseUrl: `https://api.example.com${slashes}` });
    expect(Date.now() - started).toBeLessThan(1000);

    await openAi({ baseUrl: 'https://api.example.com/v1///' })(scriptInput());
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('does not accept the late answer of a function reviewer that blocks past its timeout', async () => {
    const blocking = functionReviewer(
      () => {
        const until = Date.now() + 60;
        while (Date.now() < until) {
          // the reviewer holds the thread
        }
        return { decision: 'allow' };
      },
      { timeoutMs: 20, cache: false },
    );

    await expect(blocking(scriptInput())).rejects.toThrow('The reviewer did not answer within 20 ms');
  });

  it('keeps the reviewer message when the reviewer and the enclave come from different entries', async () => {
    // Needs the built package: `npx nx build core`; each entry bundles its own copy of the classes
    const dist = path.resolve(__dirname, '../../dist');
    const main = (await import(path.join(dist, 'index.js'))) as typeof import('../index');
    const worker = (await import(path.join(dist, 'worker.js'))) as typeof import('../worker');
    const never = () => new Promise<never>(() => undefined);
    const enclave = new main.Enclave({ review: { pre: worker.functionReviewer(never, { timeoutMs: 20 }) } });
    const runner = new worker.AgentScriptRunner({
      review: { pre: main.functionReviewer(never, { timeoutMs: 20 }) },
      hostFunctions: {},
      maxHostFunctionCalls: 1,
    });
    try {
      for (const result of [await enclave.run('return 1;'), await runner.run('return 1;')]) {
        expect(result.error?.message).toBe('Review failed: The reviewer did not answer within 20 ms');
      }
    } finally {
      enclave.dispose();
      runner.dispose();
    }
  });

  it('refuses options it cannot use', () => {
    expect(() => openAi({ model: '' })).toThrow('model is required');
    expect(() => openAi({ apiKey: undefined as unknown as string })).toThrow('apiKey is required');
    expect(() => openAi({ provider: 'other' as 'openai' })).toThrow("provider must be 'openai'");
    expect(() => openAi({ baseUrl: 'file:///etc' })).toThrow('baseUrl must be an http(s) URL');
    expect(() => openAi({ baseUrl: 'https://api.example.com/v 1' })).toThrow('baseUrl must be an http(s) URL');
    expect(() => openAi({ baseUrl: 'not a url' })).toThrow('baseUrl must be an http(s) URL');
    expect(() => functionReviewer('allow' as never)).toThrow(TypeError);
    expect(() => functionReviewer(() => ({ decision: 'allow' }), { cache: { maxEntries: 0 } })).toThrow(TypeError);
  });
});
