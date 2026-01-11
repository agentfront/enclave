import { serializeEvent, serializeEvents, parseLine, parseLines, NdjsonStreamParser } from './ndjson';
import { PROTOCOL_VERSION, EventType } from '@enclavejs/types';
import type { StreamEvent } from '@enclavejs/types';

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
});
