import {
  serializeEvent,
  serializeEvents,
  parseLine,
  parseLines,
  NdjsonStreamParser,
  NdjsonLineTooLongError,
  DEFAULT_MAX_LINE_LENGTH,
  createNdjsonParseStream,
  parseNdjsonStream,
} from './ndjson';
import { PROTOCOL_VERSION, EventType } from '@enclave-vm/types';
import type { StreamEvent } from '@enclave-vm/types';

describe('NDJSON', () => {
  const createSessionInitEvent = (): StreamEvent => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 's_test123' as `s_${string}`,
    seq: 1,
    type: EventType.SessionInit,
    payload: {
      cancelUrl: '/sessions/s_test123/cancel',
      expiresAt: '2024-01-01T00:00:00.000Z',
      encryption: { enabled: false },
    },
  });

  const createStdoutEvent = (seq: number, chunk: string): StreamEvent => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 's_test123' as `s_${string}`,
    seq,
    type: EventType.Stdout,
    payload: { chunk },
  });

  describe('serializeEvent', () => {
    it('should serialize an event to JSON string', () => {
      const event = createSessionInitEvent();
      const serialized = serializeEvent(event);
      expect(serialized).toBe(JSON.stringify(event));
      expect(serialized).not.toContain('\n');
    });
  });

  describe('serializeEvents', () => {
    it('should serialize multiple events with newlines', () => {
      const events = [createSessionInitEvent(), createStdoutEvent(2, 'Hello'), createStdoutEvent(3, 'World')];
      const serialized = serializeEvents(events);
      const lines = serialized.split('\n');
      expect(lines.length).toBe(3);
      lines.forEach((line, i) => {
        expect(JSON.parse(line)).toEqual(events[i]);
      });
    });
  });

  describe('parseLine', () => {
    it('should parse a valid event', () => {
      const event = createSessionInitEvent();
      const line = JSON.stringify(event);
      const result = parseLine(line);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe(EventType.SessionInit);
      }
    });

    it('should handle whitespace', () => {
      const event = createStdoutEvent(1, 'test');
      const line = `  ${JSON.stringify(event)}  `;
      const result = parseLine(line);
      expect(result.success).toBe(true);
    });

    it('should reject empty lines', () => {
      expect(parseLine('').success).toBe(false);
      expect(parseLine('   ').success).toBe(false);
    });

    it('should reject invalid JSON', () => {
      const result = parseLine('not json');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('JSON parse error');
      }
    });

    it('should reject invalid events', () => {
      const result = parseLine('{"type": "unknown"}');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Validation error');
      }
    });
  });

  describe('parseLines', () => {
    it('should parse multiple valid lines', () => {
      const events = [createSessionInitEvent(), createStdoutEvent(2, 'Hello')];
      const data = events.map((e) => JSON.stringify(e)).join('\n');
      const { events: parsed, errors } = parseLines(data);
      expect(parsed.length).toBe(2);
      expect(errors.length).toBe(0);
    });

    it('should handle mixed valid and invalid lines', () => {
      const validEvent = createStdoutEvent(1, 'valid');
      const data = `${JSON.stringify(validEvent)}\ninvalid json\n${JSON.stringify(validEvent)}`;
      const { events, errors } = parseLines(data);
      expect(events.length).toBe(2);
      expect(errors.length).toBe(1);
      expect(errors[0]?.line).toBe(2);
    });

    it('should skip empty lines', () => {
      const event = createStdoutEvent(1, 'test');
      const data = `\n${JSON.stringify(event)}\n\n`;
      const { events, errors } = parseLines(data);
      expect(events.length).toBe(1);
      expect(errors.length).toBe(0);
    });
  });

  describe('NdjsonStreamParser', () => {
    it('should parse complete lines immediately', () => {
      const events: unknown[] = [];
      const errors: unknown[] = [];
      const parser = new NdjsonStreamParser({
        onEvent: (e) => events.push(e),
        onError: (e) => errors.push(e),
      });

      const event = createStdoutEvent(1, 'test');
      parser.feed(JSON.stringify(event) + '\n');

      expect(events.length).toBe(1);
      expect(errors.length).toBe(0);
    });

    it('should buffer partial lines', () => {
      const events: unknown[] = [];
      const errors: unknown[] = [];
      const parser = new NdjsonStreamParser({
        onEvent: (e) => events.push(e),
        onError: (e) => errors.push(e),
      });

      const event = createStdoutEvent(1, 'test');
      const json = JSON.stringify(event);

      // Feed partial chunks
      parser.feed(json.slice(0, 10));
      expect(events.length).toBe(0);

      parser.feed(json.slice(10) + '\n');
      expect(events.length).toBe(1);
    });

    it('should flush remaining buffer', () => {
      const events: unknown[] = [];
      const errors: unknown[] = [];
      const parser = new NdjsonStreamParser({
        onEvent: (e) => events.push(e),
        onError: (e) => errors.push(e),
      });

      const event = createStdoutEvent(1, 'test');
      parser.feed(JSON.stringify(event)); // No trailing newline
      expect(events.length).toBe(0);

      parser.flush();
      expect(events.length).toBe(1);
    });

    it('should track line numbers', () => {
      const events: unknown[] = [];
      const errors: Array<{ line: number }> = [];
      const parser = new NdjsonStreamParser({
        onEvent: (e) => events.push(e),
        onError: (e) => errors.push(e),
      });

      const event = createStdoutEvent(1, 'test');
      parser.feed(JSON.stringify(event) + '\n');
      parser.feed('invalid\n');
      parser.feed(JSON.stringify(event) + '\n');

      expect(events.length).toBe(2);
      expect(errors.length).toBe(1);
      expect(errors[0]?.line).toBe(2);
    });

    it('should reset correctly', () => {
      const events: unknown[] = [];
      const parser = new NdjsonStreamParser({
        onEvent: (e) => events.push(e),
        onError: () => {},
      });

      parser.feed('partial');
      expect(parser.hasPendingData()).toBe(true);

      parser.reset();
      expect(parser.hasPendingData()).toBe(false);
      expect(parser.getLineNumber()).toBe(0);
    });
  });

  describe('maxLineLength', () => {
    const streamOf = (text: string): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });

    it('should default to DEFAULT_MAX_LINE_LENGTH', () => {
      expect(DEFAULT_MAX_LINE_LENGTH).toBe(8 * 1024 * 1024);
    });

    it('should report a line over the limit through onError and go on with the next line', () => {
      const events: unknown[] = [];
      const errors: Array<{ line: number; error: string }> = [];
      const parser = new NdjsonStreamParser({
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
        maxLineLength: 200,
      });

      parser.feed(JSON.stringify(createStdoutEvent(1, 'x'.repeat(300))) + '\n');
      parser.feed(JSON.stringify(createStdoutEvent(2, 'ok')) + '\n');

      expect(errors).toHaveLength(1);
      expect(errors[0].line).toBe(1);
      expect(errors[0].error).toContain('maximum line length of 200');
      expect(events).toHaveLength(1);
      expect(parser.getLineNumber()).toBe(2);
    });

    it('should end parseNdjsonStream with NdjsonLineTooLongError', async () => {
      const stream = streamOf(JSON.stringify(createStdoutEvent(1, 'x'.repeat(300))) + '\n');
      const read = async () => {
        for await (const _event of parseNdjsonStream(stream, { maxLineLength: 200 })) {
          // nothing is expected
        }
      };

      await expect(read()).rejects.toBeInstanceOf(NdjsonLineTooLongError);
    });

    it('should accept the option in createNdjsonParseStream', async () => {
      const line = JSON.stringify(createStdoutEvent(1, 'hello')) + '\n';
      const source = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(line);
          controller.close();
        },
      });

      const reader = source.pipeThrough(createNdjsonParseStream({ maxLineLength: 200 })).getReader();
      const first = await reader.read();

      expect(first.value?.type).toBe(EventType.Stdout);
    });

    it('should refuse a limit that is not a positive integer', () => {
      expect(() => createNdjsonParseStream({ maxLineLength: 0 })).toThrow(RangeError);
    });
  });
});
