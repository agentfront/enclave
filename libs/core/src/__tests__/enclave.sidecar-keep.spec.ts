import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';
import type { KeptReferenceOptions } from '../kept-references';
import { PortableEnclave } from '../portable-enclave';
import type { ReferenceEntry } from '../sidecar/reference-sidecar';
import type { CreateEnclaveOptions, ExecutionResult, ToolHandler } from '../types';

interface Runner {
  run(code: string, handler: ToolHandler | undefined, options: KeptReferenceOptions): Promise<ExecutionResult>;
  dispose(): void;
}

const RUNTIMES: Array<[string, (options: CreateEnclaveOptions) => Runner]> = [
  ['double VM', (options) => new Enclave(options)],
  ['InterpreterAdapter', (options) => new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() })],
  ['PortableEnclave', (options) => new PortableEnclave(options)],
];

const SIDECAR = { enabled: true, extractionThreshold: 1024, maxReferenceSize: 64 * 1024, maxTotalSize: 128 * 1024 };
const DOCUMENT = 'd'.repeat(50 * 1024);

describe.each(RUNTIMES)('references kept between runs on the %s', (_name, create) => {
  async function runOnce(code: string, options: KeptReferenceOptions, toolHandler?: ToolHandler, sidecar = SIDECAR) {
    const runner = create({ sidecar, toolHandler });
    try {
      return await runner.run(code, undefined, options);
    } finally {
      runner.dispose();
    }
  }

  async function exportDocument(): Promise<ReferenceEntry[]> {
    const first = await runOnce(
      "return await callTool('fetch', {});",
      { exportReferences: (value) => value as string },
      async () => DOCUMENT,
    );
    expect(first.success).toBe(true);
    expect(first.value).toMatch(/^__REF_[0-9a-f-]+__$/);
    return first.references ?? [];
  }

  it('lets a later run pass a token of an earlier run to a tool, which receives the whole string', async () => {
    const entries = await exportDocument();
    expect(entries).toEqual([
      { id: expect.stringMatching(/^__REF_/), data: DOCUMENT, source: 'tool-result', origin: 'fetch' },
    ]);

    const received: unknown[] = [];
    const second = await runOnce(
      `return await callTool('save', { text: ${JSON.stringify(entries[0].id)} });`,
      { preloadReferences: entries },
      async (_toolName, args) => {
        received.push(args['text']);
        return 'saved';
      },
    );
    expect(second.value).toBe('saved');
    expect(received).toEqual([DOCUMENT]);
  });

  it('counts preloaded entries toward maxTotalSize and maxReferenceCount', async () => {
    const [entry] = await exportDocument();
    const tight = { ...SIDECAR, maxTotalSize: 80 * 1024, maxReferenceCount: 2 };
    const crowded = await runOnce(
      "const r = await callTool('fetch', {}, { throwOnError: false }); return r.success ? 'stored' : r.error.code;",
      { preloadReferences: [entry] },
      async () => DOCUMENT,
      tight,
    );
    expect(crowded.value).toBe('TOOL_RESULT_NOT_STORED');

    const second = { ...entry, id: entry.id.replace(/.{3}__$/, 'abc__') };
    const third = { ...entry, id: entry.id.replace(/.{3}__$/, 'abd__') };
    const small = [entry, second, third].map((item) => ({ ...item, data: 'x' }));
    await expect(runOnce('return 1;', { preloadReferences: small }, undefined, tight)).rejects.toThrow(
      'Maximum reference count exceeded (2)',
    );
  });

  it('fails a token that was not preloaded at the tool boundary, as before', async () => {
    const [entry] = await exportDocument();
    const result = await runOnce(
      `return await callTool('save', { text: ${JSON.stringify(entry.id)} });`,
      {},
      async () => 'saved',
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Unknown reference');
  });

  it('exports only the entries the run holds, and refuses the options without a sidecar', async () => {
    const result = await runOnce('return 1;', {
      exportReferences: () => ['__REF_00000000-0000-4000-8000-000000000000__', 'text'],
    });
    expect(result.references).toEqual([]);

    const runner = create({});
    try {
      await expect(runner.run('return 1;', undefined, { exportReferences: () => [] })).rejects.toThrow(
        'preloadReferences and exportReferences need the sidecar option',
      );
    } finally {
      runner.dispose();
    }
  });
});
