import * as acorn from 'acorn';
import { JSAstValidator, createAgentScriptPreset, transformAgentScript } from '../index';
import { PreScanner, PRESCANNER_ERROR_CODES } from '../pre-scanner';
import { extractLargeStrings, shouldExtract } from '../transforms';
import { utf8ByteLength } from '../utils/utf8-byte-length';

describe('utf8ByteLength', () => {
  const samples: Record<string, string> = {
    empty: '',
    ascii: 'return 1;',
    twoByte: 'café ñ',
    threeByte: '日本語 €',
    surrogatePair: 'emoji 😀 and 𝄞',
    loneHighSurrogate: 'a\ud800b',
    loneLowSurrogate: 'a\udc00b',
    highSurrogateAtEnd: 'abc\ud83d',
    reversedPair: '\ude00\ud83d',
    mixed: 'x = "é😀日"\n\r\t\u0000\u007f\u0080߿ࠀ￿',
  };

  it.each(Object.entries(samples))('matches Buffer.byteLength for %s', (_name, sample) => {
    expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
  });
});

describe('without a Node.js Buffer global', () => {
  const originalBuffer = globalThis.Buffer;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'Buffer');
  });

  afterEach(() => {
    globalThis.Buffer = originalBuffer;
  });

  it('runs the pre-scanner size check', () => {
    const scanner = new PreScanner({ preset: 'agentscript' });

    expect(typeof globalThis.Buffer).toBe('undefined');
    expect(scanner.scan('return "日本";').stats.inputSize).toBe(16);
  });

  it('counts multi-byte input against maxInputSize in bytes', () => {
    const scanner = new PreScanner({ preset: 'standard', config: { maxInputSize: 100 } });
    const result = scanner.scan('😀'.repeat(30));

    expect(result.success).toBe(false);
    expect(result.fatalIssue?.code).toBe(PRESCANNER_ERROR_CODES.INPUT_TOO_LARGE);
  });

  it('validates a script', async () => {
    const validator = new JSAstValidator(createAgentScriptPreset());
    const result = await validator.validate(transformAgentScript('return 1;', { wrapInMain: true }));

    expect(result.valid).toBe(true);
  });

  it('extracts large strings by byte size', () => {
    const ast = acorn.parse('const big = "😀😀😀";', { ecmaVersion: 'latest' });
    const result = extractLargeStrings(ast, { threshold: 12, onExtract: () => '__REF_1__' });

    expect(result.extractedCount).toBe(1);
    expect(result.extractedBytes).toBe(12);
    expect(shouldExtract('😀😀😀', 13)).toBe(false);
  });
});
