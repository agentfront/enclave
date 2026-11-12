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
 * Default maximum length of one NDJSON line, in characters (8 MiB).
 * Above the largest event the protocol's default limits allow (a 5 MB tool result).
 */
export const DEFAULT_MAX_LINE_LENGTH = 8 * 1024 * 1024;

/**
 * Options of the incremental parsers.
 */
export interface NdjsonParseOptions {
  /**
   * Maximum length of one line, in characters (UTF-16 code units; for ASCII JSON, bytes).
   * A parser never buffers more than this of a line that has not ended yet.
   * A positive integer.
   * @default DEFAULT_MAX_LINE_LENGTH
   */
  maxLineLength?: number;
}

/**
 * A line of the stream is longer than the parser's `maxLineLength`.
 */
export class NdjsonLineTooLongError extends Error {
  readonly maxLineLength: number;

  constructor(maxLineLength: number) {
    super(`NDJSON line exceeds the maximum line length of ${maxLineLength} characters`);
    this.name = 'NdjsonLineTooLongError';
    this.maxLineLength = maxLineLength;
  }
}

/**
 * The limit to use for an option value. A value that is not a positive integer is refused:
 * a limit is never switched off by a value that cannot be one.
 */
function resolveMaxLineLength(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_LINE_LENGTH;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('maxLineLength must be a positive integer');
  }
  return value;
}

/**
 * Cuts a stream of text chunks into lines.
 *
 * Only the new chunk is searched for line ends, and the pieces of an unfinished line are joined
 * once, when the line ends: the work for a line is proportional to its length however many
 * chunks it arrives in. An unfinished line is held up to `maxLineLength` characters; a line that
 * passes it is dropped up to its end and reported once.
 */
class LineAssembler {
  private pieces: string[] = [];
  private length = 0;
  private skipping = false;

  constructor(private readonly maxLineLength: number) {}

  /**
   * Add a chunk.
   *
   * @param onLine - Called with every line the chunk completes (without its line end)
   * @param onTooLong - Called when a line passes the limit, with the start of that line.
   *   It may throw; the assembler is then already past the line.
   * @param onSkipped - Called when the end of a dropped line is reached
   */
  push(chunk: string, onLine: (line: string) => void, onTooLong: (head: string) => void, onSkipped?: () => void): void {
    let start = 0;

    for (;;) {
      const newline = chunk.indexOf('\n', start);
      const end = newline === -1 ? chunk.length : newline;

      if (!this.skipping) {
        if (this.length + (end - start) > this.maxLineLength) {
          const head = (this.pieces.length > 0 ? this.pieces[0] : chunk.slice(start, start + 100)).slice(0, 100);
          this.pieces = [];
          this.length = 0;
          this.skipping = true;
          onTooLong(head);
        } else if (end > start) {
          this.pieces.push(chunk.slice(start, end));
          this.length += end - start;
        }
      }

      if (newline === -1) return;

      if (this.skipping) {
        this.skipping = false;
        onSkipped?.();
      } else {
        onLine(this.take());
      }
      start = newline + 1;
    }
  }

  /**
   * Remove and return the unfinished line ('' when there is none, or when it is being dropped).
   */
  take(): string {
    const line = this.pieces.length === 1 ? this.pieces[0] : this.pieces.join('');
    this.pieces = [];
    this.length = 0;
    this.skipping = false;
    return line;
  }

  /**
   * Whether an unfinished line with something other than whitespace is held.
   */
  hasContent(): boolean {
    return this.pieces.some((piece) => piece.trim().length > 0);
  }
}

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
  private readonly lines: LineAssembler;
  private readonly maxLineLength: number;
  private readonly onEvent: (event: ParsedStreamEvent | ParsedEncryptedEnvelope) => void;
  private readonly onError: (error: { line: number; error: string; content: string }) => void;
  private lineNumber = 0;

  constructor(
    options: {
      onEvent: (event: ParsedStreamEvent | ParsedEncryptedEnvelope) => void;
      onError: (error: { line: number; error: string; content: string }) => void;
    } & NdjsonParseOptions,
  ) {
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.maxLineLength = resolveMaxLineLength(options.maxLineLength);
    this.lines = new LineAssembler(this.maxLineLength);
  }

  /**
   * Feed a chunk of data into the parser.
   * Complete lines are parsed and emitted immediately.
   * A line longer than `maxLineLength` is reported through `onError` once and skipped.
   */
  feed(chunk: string): void {
    this.lines.push(
      chunk,
      (line) => {
        this.lineNumber++;
        this.parse(line);
      },
      (head) => {
        this.onError({
          line: this.lineNumber + 1,
          error: `Line exceeds the maximum line length of ${this.maxLineLength} characters`,
          content: head + '...',
        });
      },
      () => {
        this.lineNumber++;
      },
    );
  }

  /**
   * Flush any remaining buffered data.
   * Should be called when the stream ends.
   */
  flush(): void {
    const trimmed = this.lines.take().trim();
    if (trimmed.length > 0) {
      this.lineNumber++;
      this.parse(trimmed);
    }
  }

  /**
   * Reset the parser state.
   */
  reset(): void {
    this.lines.take();
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
    return this.lines.hasContent();
  }

  private parse(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

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
 * Create a transform stream that parses NDJSON.
 * Works with browser fetch() streaming and Node.js streams.
 * A line longer than `maxLineLength` ends the stream with an `NdjsonLineTooLongError`.
 */
export function createNdjsonParseStream(
  options: NdjsonParseOptions = {},
): TransformStream<string, ParsedStreamEvent | ParsedEncryptedEnvelope> {
  const maxLineLength = resolveMaxLineLength(options.maxLineLength);
  const lines = new LineAssembler(maxLineLength);

  const enqueueLine = (
    line: string,
    controller: TransformStreamDefaultController<ParsedStreamEvent | ParsedEncryptedEnvelope>,
  ): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    const result = parseLine(trimmed);
    if (result.success) {
      controller.enqueue(result.data);
    }
    // Note: lines that are not events are silently dropped in transform stream
    // Use NdjsonStreamParser for error handling
  };

  return new TransformStream({
    transform(chunk, controller) {
      lines.push(
        chunk,
        (line) => enqueueLine(line, controller),
        () => {
          throw new NdjsonLineTooLongError(maxLineLength);
        },
      );
    },

    flush(controller) {
      enqueueLine(lines.take(), controller);
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
 * A line longer than `maxLineLength` ends the iteration with an `NdjsonLineTooLongError`
 * and cancels the stream.
 */
export function parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  options: NdjsonParseOptions = {},
): AsyncGenerator<ParsedStreamEvent | ParsedEncryptedEnvelope> {
  // Checked here, not on the first read: a bad limit is refused where it is given.
  return readNdjsonStream(stream, resolveMaxLineLength(options.maxLineLength));
}

async function* readNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  maxLineLength: number,
): AsyncGenerator<ParsedStreamEvent | ParsedEncryptedEnvelope> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const lines = new LineAssembler(maxLineLength);
  const completed: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining data
        const trimmed = lines.take().trim();
        if (trimmed.length > 0) {
          const result = parseLine(trimmed);
          if (result.success) {
            yield result.data;
          }
        }
        break;
      }

      let tooLong: NdjsonLineTooLongError | undefined;
      try {
        lines.push(
          decoder.decode(value, { stream: true }),
          (line) => completed.push(line),
          () => {
            throw new NdjsonLineTooLongError(maxLineLength);
          },
        );
      } catch (error) {
        if (!(error instanceof NdjsonLineTooLongError)) throw error;
        tooLong = error;
      }

      // Process complete lines
      for (const line of completed.splice(0)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        const result = parseLine(trimmed);
        if (result.success) {
          yield result.data;
        }
      }

      if (tooLong) {
        // Nothing after this point of the stream can be read as lines: stop the source.
        await reader.cancel(tooLong).catch(() => undefined);
        throw tooLong;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
