import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';
import type { KeptReferenceOptions } from '../kept-references';
import { PortableEnclave } from '../portable-enclave';
import { ReferenceSidecar, type ReferenceEntry } from '../sidecar/reference-sidecar';
import { REFERENCE_CONFIGS } from '../sidecar/reference-config';
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

  it('resolves a token of an earlier run that a later script writes as a literal, whatever the extraction threshold', async () => {
    const entries = await exportDocument();
    const received: unknown[] = [];
    const second = await runOnce(
      `return await callTool('save', { text: ${JSON.stringify(entries[0].id)} });`,
      { preloadReferences: entries },
      async (_toolName, args) => {
        received.push(args['text']);
        return 'saved';
      },
      { ...SIDECAR, extractionThreshold: 8 },
    );
    expect(second.value).toBe('saved');
    expect(received).toEqual([DOCUMENT]);
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
    for (const preloadReferences of [null, false, 0, '']) {
      await expect(runOnce('return 1;', { preloadReferences: preloadReferences as never })).rejects.toThrow(TypeError);
    }
  });
});

describe('ReferenceSidecar export', () => {
  it('leaves out an entry that is not UTF-8 text, and keeps a byte order mark', () => {
    const sidecar = new ReferenceSidecar({ ...REFERENCE_CONFIGS.STANDARD });
    const binary = sidecar.store(Buffer.from([0xff, 0xfe, 0x00]), 'tool-result');
    const marked = sidecar.store('\ufefftext', 'tool-result');
    expect(sidecar.exportEntries([binary, marked]).map((entry) => entry.data)).toEqual(['\ufefftext']);
    sidecar.dispose();
  });
});
