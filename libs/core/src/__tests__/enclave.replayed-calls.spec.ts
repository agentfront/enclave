import { Enclave, type EnclaveRunOptions } from '../enclave';
import * as core from '../index';
import * as workerEntry from '../worker';
import { PortableEnclave } from '../portable-enclave';
import type { ReplayedCall } from '../replayed-calls';
import type { CreateEnclaveOptions, ExecutionResult, ToolHandler } from '../types';

interface Runner {
  run(code: string, handler?: ToolHandler, options?: EnclaveRunOptions): Promise<ExecutionResult>;
  dispose(): void;
}

const RUNTIMES: Array<[string, (options: CreateEnclaveOptions) => Runner]> = [
  ['double VM', (options) => new Enclave(options)],
  ['PortableEnclave', (options) => new PortableEnclave(options)],
];

const answer: ToolHandler = async (toolName) => toolName;

function replayOf(toolNames: string[], gapMs: number): ReplayedCall[] {
  return toolNames.map((toolName, callIndex) => ({ callIndex, toolName, elapsedMs: callIndex * gapMs }));
}

function repeated(toolName: string, count: number): string[] {
  return Array.from({ length: count }, () => toolName);
}

function callsOf(toolName: string, count: number): string {
  return `for (let i = 0; i < ${count}; i++) await callTool('${toolName}', { i });`;
}

describe.each(RUNTIMES)('replayed calls on the %s', (_name, create) => {
  async function runOnce(
    code: string,
    replayedCalls?: ReplayedCall[],
    options: CreateEnclaveOptions = {},
  ): Promise<ExecutionResult> {
    const enclave = create({ toolHandler: answer, ...options });
    try {
      return await enclave.run(code, undefined, replayedCalls ? { replayedCalls } : {});
    } finally {
      enclave.dispose();
    }
  }

  it('passes a replay of calls that originally took longer than the rate and enumeration windows', async () => {
    const rateLimited = { doubleVm: { parentValidation: { maxOperationsPerSecond: 5 } } };
    const steps = `${callsOf('step', 20)} return 'done';`;
    expect((await runOnce(steps, undefined, rateLimited)).error?.message).toMatch(/rate limit exceeded/);
    expect((await runOnce(steps, replayOf(repeated('step', 20), 1000), rateLimited)).value).toBe('done');

    const pages = `${callsOf('page.next', 40)} return 'done';`;
    expect((await runOnce(pages)).error?.message).toMatch(/RAPID_ENUMERATION/);
    expect((await runOnce(pages, replayOf(repeated('page.next', 40), 1000))).value).toBe('done');
  });

  it('judges a live delete against the replayed access at its original distance from the latest replayed call', async () => {
    const code = `
      await callTool('users.list', {});
      await callTool('audit.note', {});
      await callTool('users.delete', {});
      return 'done';
    `;
    const near = [
      { callIndex: 0, toolName: 'users.list', elapsedMs: 0 },
      { callIndex: 1, toolName: 'audit.note', elapsedMs: 25_000 },
    ];
    const far = [near[0], { ...near[1], elapsedMs: 35_000 }];
    expect((await runOnce(code, near)).error?.message).toMatch(/DELETE_AFTER_ACCESS/);
    expect((await runOnce(code, far)).value).toBe('done');
    expect((await runOnce(code, far.slice(0, 1))).error?.message).toMatch(/DELETE_AFTER_ACCESS/);
  });

  it('trips enumeration on a live burst after the replay only when the original calls were close enough', async () => {
    const options = { doubleVm: { parentValidation: { rapidEnumerationThreshold: 10 } } };
    const code = `${callsOf('page.next', 13)} return 'done';`;
    const replayed = (gapMs: number) => replayOf(repeated('page.next', 8), gapMs);
    expect((await runOnce(code, undefined, options)).error?.message).toMatch(/RAPID_ENUMERATION/);
    expect((await runOnce(code, replayed(100), options)).error?.message).toMatch(/RAPID_ENUMERATION/);
    expect((await runOnce(code, replayed(2000), options)).value).toBe('done');
  });

  it('treats a call that is not the next one listed as live, and every call after it', async () => {
    const deleteInstead = "await callTool('users.list', {}); await callTool('users.delete', {}); return 'done';";
    const listThenNote = [
      { callIndex: 0, toolName: 'users.list', elapsedMs: 0 },
      { callIndex: 1, toolName: 'audit.note', elapsedMs: 35_000 },
    ];
    expect((await runOnce(deleteInstead, listThenNote)).error?.message).toMatch(/DELETE_AFTER_ACCESS/);

    const pages = replayOf(repeated('page.next', 41), 1000);
    const withoutPosition20 = pages.filter((call) => call.callIndex !== 20);
    const liveBetween = `${callsOf('page.next', 20)} await callTool('other', {}); ${callsOf('page.next', 30)} return 'done';`;
    expect((await runOnce(liveBetween, withoutPosition20)).error?.message).toMatch(/RAPID_ENUMERATION/);

    const startingAt1 = pages.map((call) => ({ ...call, callIndex: call.callIndex + 1 }));
    const allPages = `${callsOf('page.next', 40)} return 'done';`;
    expect((await runOnce(allPages, startingAt1)).error?.message).toMatch(/RAPID_ENUMERATION/);
  });

  it('leaves the replay where it was when a request is refused for its size before it reaches the host', async () => {
    const code = `
      let refused = '';
      await callTool('users.list', {});
      try {
        await callTool('audit.note', { pad: 'x'.repeat(990) });
      } catch (error) {
        refused = error.message;
      }
      await callTool('audit.note', {});
      await callTool('users.delete', {});
      return refused;
    `;
    const replayedCalls = [
      { callIndex: 0, toolName: 'users.list', elapsedMs: 0 },
      { callIndex: 1, toolName: 'audit.note', elapsedMs: 1000 },
      { callIndex: 2, toolName: 'users.delete', elapsedMs: 60_000 },
    ];
    const result = await runOnce(code, replayedCalls, { toolBridge: { maxPayloadBytes: 1024 } });
    expect(result.value).toMatch(/exceeds maximum size/);
  });

  it.each<[string, unknown]>([
    ['not a list', { callIndex: 0, toolName: 'a', elapsedMs: 0 }],
    ['an entry that is not an object', [null]],
    ['a negative callIndex', [{ callIndex: -1, toolName: 'a', elapsedMs: 0 }]],
    ['a fractional callIndex', [{ callIndex: 0.5, toolName: 'a', elapsedMs: 0 }]],
    [
      'a callIndex that does not increase',
      [
        { callIndex: 1, toolName: 'a', elapsedMs: 0 },
        { callIndex: 1, toolName: 'a', elapsedMs: 0 },
      ],
    ],
    ['an empty toolName', [{ callIndex: 0, toolName: '', elapsedMs: 0 }]],
    ['a toolName over 256 characters', [{ callIndex: 0, toolName: 'a'.repeat(257), elapsedMs: 0 }]],
    ['a toolName that is not a string', [{ callIndex: 0, toolName: 7, elapsedMs: 0 }]],
    ['a NaN elapsedMs', [{ callIndex: 0, toolName: 'a', elapsedMs: Number.NaN }]],
    ['an infinite elapsedMs', [{ callIndex: 0, toolName: 'a', elapsedMs: Number.POSITIVE_INFINITY }]],
    ['a negative elapsedMs', [{ callIndex: 0, toolName: 'a', elapsedMs: -1 }]],
    [
      'an elapsedMs that goes back',
      [
        { callIndex: 0, toolName: 'a', elapsedMs: 1000 },
        { callIndex: 1, toolName: 'a', elapsedMs: 999 },
      ],
    ],
    ['more calls than maxToolCalls', replayOf(repeated('a', 101), 0)],
  ])('refuses replayedCalls with %s before the script runs', async (_case, replayedCalls) => {
    const handler = jest.fn(answer);
    const enclave = create({ toolHandler: handler, maxToolCalls: 100 });
    try {
      await expect(
        enclave.run("return await callTool('a', {});", undefined, { replayedCalls: replayedCalls as ReplayedCall[] }),
      ).rejects.toThrow(TypeError);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      enclave.dispose();
    }
  });
});

describe('replayed calls on the PortableEnclave, while the replay lasts', () => {
  it('keeps the replayed calls in the history until the replay ends, however long it takes', async () => {
    let clock = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const enclave = new PortableEnclave({
      timeout: 600_000,
      allowFunctionsInGlobals: true,
      globals: { ping: () => true },
      doubleVm: { parentValidation: { rapidEnumerationThreshold: 2 } },
      toolHandler: async (toolName, _args, { callIndex }) => {
        if (callIndex === 0) clock += 61_000;
        return toolName;
      },
    });
    const code = `
      await callTool('page.next', {});
      ping();
      await callTool('page.next', {});
      await callTool('page.next', {});
      return 'done';
    `;
    try {
      const result = await enclave.run(code, undefined, { replayedCalls: replayOf(repeated('page.next', 2), 100) });
      expect(result.error?.message).toMatch(/RAPID_ENUMERATION/);
    } finally {
      dateNow.mockRestore();
      enclave.dispose();
    }
  });
});

describe('replayed calls on the worker pool', () => {
  it('carries the replay to the double VM in the worker', async () => {
    const enclave = new Enclave({
      adapter: 'worker_threads',
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1 },
      toolHandler: answer,
    });
    const pages = `${callsOf('page.next', 40)} return 'done';`;
    try {
      expect((await enclave.run(pages)).error?.message).toMatch(/RAPID_ENUMERATION/);
      const replayedCalls = replayOf(repeated('page.next', 40), 1000);
      expect((await enclave.run(pages, undefined, { replayedCalls })).value).toBe('done');
    } finally {
      enclave.dispose();
    }
  });

  it('does not count the replayed calls against maxMessagesPerSecond, and counts the live ones', async () => {
    const enclave = new Enclave({
      adapter: 'worker_threads',
      workerPoolConfig: { minWorkers: 1, maxWorkers: 1, maxMessagesPerSecond: 10 },
      toolHandler: answer,
    });
    const replayedCalls = replayOf(repeated('page.next', 20), 1000);
    const pages = `${callsOf('page.next', 20)} return 'done';`;
    const pagesThenSteps = `${callsOf('page.next', 20)} ${callsOf('step', 15)} return 'done';`;
    try {
      expect((await enclave.run(pages, undefined, { replayedCalls })).value).toBe('done');
      expect((await enclave.run(pages)).error?.message).toMatch(/Message rate limit exceeded/);
      expect((await enclave.run(pagesThenSteps, undefined, { replayedCalls })).error?.message).toMatch(
        /Message rate limit exceeded/,
      );
    } finally {
      enclave.dispose();
    }
  });
});

describe('ENCLAVE_RUN_FEATURES', () => {
  it('lists replayed-calls, the same frozen list from both entry points', () => {
    expect(core.ENCLAVE_RUN_FEATURES).toContain('replayed-calls');
    expect(workerEntry.ENCLAVE_RUN_FEATURES).toBe(core.ENCLAVE_RUN_FEATURES);
    expect(Object.isFrozen(core.ENCLAVE_RUN_FEATURES)).toBe(true);
  });
});
