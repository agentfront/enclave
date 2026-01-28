/**
 * @enclave-vm/stream - NDJSON Parser/Serializer
 *
 * Newline-delimited JSON (NDJSON) parsing and serialization for streaming events.
 * NDJSON format: one JSON object per line, separated by newlines.
 */

import {
  parseStreamEventOrEncrypted,
  type StreamEvent,
  type MaybeEncrypted,
  type ParsedStreamEvent,
  type ParsedEncryptedEnvelope,
} from '@enclave-vm/types';

/**
 * Result of parsing an NDJSON line.
 */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: string; line: string };

/**
 * Serialize an event to NDJSON format (single line).
 */
export function serializeEvent(event: MaybeEncrypted<StreamEvent>): string {
  return JSON.stringify(event);
}

/**
 * Serialize multiple events to NDJSON format.
 */
export function serializeEvents(events: MaybeEncrypted<StreamEvent>[]): string {
  return events.map(serializeEvent).join('\n');
}

/**
 * Parse a single NDJSON line into an event.
 * Note: The returned type is from Zod parsing, which may have slightly different
 * type inference than the interface types (e.g., string vs template literal).
 */
export function parseLine(line: string): ParseResult<ParsedStreamEvent | ParsedEncryptedEnvelope> {
  const trimmed = line.trim();

  // Skip empty lines
  if (trimmed.length === 0) {
    return { success: false, error: 'Empty line', line };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      success: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      line,
    };
  }

  // Validate against schema
  const result = parseStreamEventOrEncrypted(parsed);
  if (!result.success) {
    return {
      success: false,
      error: `Validation error: ${result.error.message}`,
      line,
    };
  }

  return { success: true, data: result.data };
}

/**
 * Parse multiple NDJSON lines into events.
 * Returns successfully parsed events and any errors encountered.
 */
export function parseLines(data: string): {
  events: (ParsedStreamEvent | ParsedEncryptedEnvelope)[];
  errors: Array<{ line: number; error: string; content: string }>;
} {
  const lines = data.split('\n');
  const events: (ParsedStreamEvent | ParsedEncryptedEnvelope)[] = [];
  const errors: Array<{ line: number; error: string; content: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const result = parseLine(trimmed);
    if (result.success) {
      events.push(result.data);
    } else {
      errors.push({
        line: i + 1,
        error: result.error,
        content: trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed,
      });
    }
  }

  return { events, errors };
}

/**
 * NDJSON stream parser for incremental parsing.
 * Handles partial lines across chunks.
 */
export class NdjsonStreamParser {
  private buffer = '';
  private readonly onEvent: (event: ParsedStreamEvent | ParsedEncryptedEnvelope) => void;
  private readonly onError: (error: { line: number; error: string; content: string }) => void;
  private lineNumber = 0;

  constructor(options: {
    onEvent: (event: ParsedStreamEvent | ParsedEncryptedEnvelope) => void;
    onError: (error: { line: number; error: string; content: string }) => void;
  }) {
    this.onEvent = options.onEvent;
    this.onError = options.onError;
  }

  /**
   * Feed a chunk of data into the parser.
   * Complete lines are parsed and emitted immediately.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // Process complete lines
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.lineNumber++;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const result = parseLine(trimmed);
      if (result.success) {
        this.onEvent(result.data);
      } else {
        this.onError({
          line: this.lineNumber,
          error: result.error,
          content: trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed,
        });
      }
    }
  }

  /**
   * Flush any remaining buffered data.
   * Should be called when the stream ends.
   */
  flush(): void {
    const trimmed = this.buffer.trim();
    if (trimmed.length > 0) {
      this.lineNumber++;
      const result = parseLine(trimmed);
      if (result.success) {
        this.onEvent(result.data);
      } else {
        this.onError({
          line: this.lineNumber,
          error: result.error,
          content: trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed,
        });
      }
    }
    this.buffer = '';
  }

  /**
   * Reset the parser state.
   */
  reset(): void {
    this.buffer = '';
    this.lineNumber = 0;
  }

  /**
   * Get the current line number.
   */
  getLineNumber(): number {
    return this.lineNumber;
  }

  /**
   * Check if there's pending data in the buffer.
   */
  hasPendingData(): boolean {
    return this.buffer.trim().length > 0;
  }
}

/**
 * Create a transform stream that parses NDJSON.
 * Works with browser fetch() streaming and Node.js streams.
 */
export function createNdjsonParseStream(): TransformStream<string, ParsedStreamEvent | ParsedEncryptedEnvelope> {
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        const result = parseLine(trimmed);
        if (result.success) {
          controller.enqueue(result.data);
        }
        // Note: errors are silently dropped in transform stream
        // Use NdjsonStreamParser for error handling
      }
    },

    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        const result = parseLine(trimmed);
        if (result.success) {
          controller.enqueue(result.data);
        }
      }
    },
  });
}

/**
 * Create a transform stream that serializes events to NDJSON.
 */
export function createNdjsonSerializeStream(): TransformStream<MaybeEncrypted<StreamEvent>, string> {
  return new TransformStream({
    transform(event, controller) {
      controller.enqueue(serializeEvent(event) + '\n');
    },
  });
}

/**
 * Async generator that parses NDJSON from a ReadableStream.
 */
export async function* parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent | ParsedEncryptedEnvelope> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining data
        const trimmed = buffer.trim();
        if (trimmed.length > 0) {
          const result = parseLine(trimmed);
          if (result.success) {
            yield result.data;
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        const result = parseLine(trimmed);
        if (result.success) {
          yield result.data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
