/**
 * Host Boundary
 *
 * What the host page does with data that came out of the sandbox iframes.
 *
 * The outer iframe is code this package wrote, but it runs next to the script and takes its
 * input from it. The host therefore treats it the way @enclave-vm/core treats a worker thread:
 * nothing the sandbox sends is used as it arrived. A message is checked against the protocol
 * (iframe-protocol.ts), the data in it is copied into fresh host objects of the few kinds the
 * sandbox is allowed to send, and the limits that protect the host are counted here as well as
 * in the iframes.
 *
 * @packageDocumentation
 */

import type { ExecutionStats } from '../types';
import type { SerializedError, WorkerExecutionStats } from './iframe-protocol';

/** Error code of an execution that was ended because the sandbox broke the protocol */
export const PROTOCOL_VIOLATION_CODE = 'PROTOCOL_VIOLATION';

/**
 * The sandbox sent something the protocol does not allow. The execution is ended: a sandbox that
 * does this is not running the code it was given.
 */
export class ProtocolViolationError extends Error {
  readonly code = PROTOCOL_VIOLATION_CODE;

  constructor(reason: string) {
    super(`The sandbox sent a message the protocol does not allow (${reason}); the execution was ended.`);
    this.name = 'ProtocolError';
  }
}

/** Bounds of a copy made by {@link copyScriptResult} or {@link copyToolArguments} */
export interface CopyLimits {
  /** Deepest nesting: 0 allows a value with nothing inside it */
  maxDepth: number;
  /** Most array items and object keys in the whole value, counted as the inner iframe counts them */
  maxProperties: number;
}

/**
 * Most array items and object keys in the arguments of one tool call. The host page copies the
 * arguments on its own thread before a handler sees them, so the copy has an end the script does
 * not choose. Far beyond what a tool takes.
 */
export const MAX_TOOL_ARGUMENT_PROPERTIES = 1_000_000;

/**
 * Deepest nesting of the arguments of one tool call, the arguments object being level 0. Far
 * beyond what a tool takes and well within the stack. The inner iframe refuses a deeper call
 * itself, with an ordinary error.
 */
export const MAX_TOOL_ARGUMENT_DEPTH = 100;

const TOOL_ARGUMENT_LIMITS: CopyLimits = {
  maxDepth: MAX_TOOL_ARGUMENT_DEPTH,
  maxProperties: MAX_TOOL_ARGUMENT_PROPERTIES,
};

/** Deepest nesting of one console line the host prints; a deeper one is dropped */
const MAX_CONSOLE_DEPTH = 100;

/**
 * The arguments of a tool call are larger than the host copies. Unlike a
 * {@link ProtocolViolationError} this is something a script can do by itself, so the call is
 * refused and the execution goes on.
 */
export class ToolArgumentsTooLargeError extends Error {
  constructor() {
    super(`Tool arguments hold more than ${MAX_TOOL_ARGUMENT_PROPERTIES} array items and object keys`);
    this.name = 'ToolArgumentsTooLargeError';
  }
}

/** Keys that are never copied out of a script's result (the inner iframe drops the same two) */
const RESULT_KEYS_DROPPED: ReadonlySet<string> = new Set(['__proto__', 'constructor']);

/** Keys that are never passed to a tool handler, as in @enclave-vm/core */
const ARGUMENT_KEYS_DROPPED: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** What one kind of data from the sandbox may hold, and how it is named in an error */
interface CopyRules {
  /** What is being copied, for the error text: "a result", "tool arguments" */
  what: string;
  limits: CopyLimits;
  /** Keys that are not copied */
  dropped: ReadonlySet<string>;
  /**
   * JSON data and nothing else: no `undefined`, no number that is not finite, no array with a
   * hole. What a JSON copy made in the sandbox cannot contain is refused, not passed on.
   */
  json: boolean;
  /** Whether a `Date` is data (a result may hold one) */
  dates: boolean;
}

interface CopyState {
  properties: number;
  /** Thrown in place of a ProtocolViolationError when `maxProperties` is exceeded */
  tooLarge?: () => Error;
}

/**
 * Copy `value` into fresh host objects.
 *
 * Only what the sandbox legitimately sends is accepted: primitives, arrays, plain objects and,
 * where the rules say so, dates. Anything else (a Map, a typed array, an Error, a BigInt, ...)
 * cannot have come from the inner iframe's own copy of a result or of a console line, or from the
 * JSON its tool arguments are, and is refused. The copy never assigns to a key that would reach
 * `Object.prototype`.
 */
function copySandboxData(value: unknown, depth: number, rules: CopyRules, state: CopyState): unknown {
  const { what, limits } = rules;
  if (depth > limits.maxDepth) {
    throw new ProtocolViolationError(`${what} nested more than ${limits.maxDepth} levels deep`);
  }
  if (value === null) {
    return value;
  }
  if (value === undefined) {
    if (rules.json) throw new ProtocolViolationError(`${what} holding undefined`);
    return value;
  }
  const type = typeof value;
  if (type === 'number') {
    if (rules.json && !Number.isFinite(value)) {
      throw new ProtocolViolationError(`${what} holding a number that is not finite`);
    }
    return value;
  }
  if (type === 'string' || type === 'boolean') {
    return value;
  }
  if (type !== 'object') {
    throw new ProtocolViolationError(`${what} holding a ${type}`);
  }

  if (Array.isArray(value)) {
    countProperties(value.length, rules, state);
    const copy: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      if (rules.json && !Object.prototype.hasOwnProperty.call(value, index)) {
        throw new ProtocolViolationError(`${what} holding an array with a missing item`);
      }
      copy[index] = copySandboxData(value[index], depth + 1, rules, state);
    }
    return copy;
  }

  if (rules.dates && value instanceof Date) {
    return new Date(value.getTime());
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolViolationError(`${what} holding an object that is not plain data`);
  }

  const keys = Object.keys(value as object);
  countProperties(keys.length, rules, state);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (rules.dropped.has(key)) continue;
    copy[key] = copySandboxData((value as Record<string, unknown>)[key], depth + 1, rules, state);
  }
  return copy;
}

function countProperties(count: number, rules: CopyRules, state: CopyState): void {
  state.properties += count;
  if (state.properties > rules.limits.maxProperties) {
    throw state.tooLarge
      ? state.tooLarge()
      : new ProtocolViolationError(`${rules.what} with more than ${rules.limits.maxProperties} properties`);
  }
}

/**
 * Copy the value a script returned. The inner iframe has already reduced it to plain data within
 * `maxSanitizeDepth` and `maxSanitizeProperties`; the same two limits apply here, counted the
 * same way, so a result the inner iframe accepted is never refused by the host.
 *
 * @throws ProtocolViolationError for a value the inner iframe could not have sent
 */
export function copyScriptResult(value: unknown, limits: CopyLimits): unknown {
  return copySandboxData(
    value,
    0,
    { what: 'a result', limits, dropped: RESULT_KEYS_DROPPED, json: false, dates: true },
    { properties: 0 },
  );
}

/**
 * Copy the arguments of a tool call for the host's tool handler. The handler is host code that
 * will read them, merge them and pass them on: it gets ordinary objects that have no
 * `__proto__`, `constructor` or `prototype` key at any depth, and that hold JSON data only
 * (strings, finite numbers, booleans, null, arrays without holes and plain objects), which is all
 * the JSON copy the sandbox makes of them can hold.
 *
 * @throws ProtocolViolationError for arguments that are not JSON data
 * @throws ToolArgumentsTooLargeError for more than {@link MAX_TOOL_ARGUMENT_PROPERTIES} items and
 *   keys; the copy stops there
 */
export function copyToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return copySandboxData(
    args,
    0,
    { what: 'tool arguments', limits: TOOL_ARGUMENT_LIMITS, dropped: ARGUMENT_KEYS_DROPPED, json: true, dates: false },
    { properties: 0, tooLarge: () => new ToolArgumentsTooLargeError() },
  ) as Record<string, unknown>;
}

/** Nothing is dropped from a console line: it is printed, not merged into host objects */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Copy the arguments of one console call. The inner iframe sends strings, numbers, booleans,
 * `null`, `undefined` and the JSON copy of an object; anything else is not a line it wrote.
 *
 * @param maxProperties Most array items and object keys in the line
 * @throws ProtocolViolationError for a value that is not plain data, or a line beyond the bounds
 */
function copyConsoleArguments(args: readonly unknown[], maxProperties: number): unknown[] {
  return copySandboxData(
    args,
    0,
    {
      what: 'a console line',
      limits: { maxDepth: MAX_CONSOLE_DEPTH, maxProperties },
      dropped: NO_KEYS,
      json: false,
      dates: false,
    },
    { properties: 0 },
  ) as unknown[];
}

/** The part of the validation configuration that decides which operation names are allowed */
export interface OperationNameRules {
  validateOperationNames: boolean;
  allowedOperationPatternSource?: string;
  allowedOperationPatternFlags?: string;
  blockedOperationPatternSources?: string[];
  blockedOperationPatternFlags?: string[];
}

/**
 * Build the check of a tool name against the configured operation patterns. The outer iframe
 * applies the same patterns before it forwards a call; the host does not take its word for it.
 *
 * @returns A function that returns undefined for an allowed name, and otherwise the refusal, in
 *   the outer iframe's words
 */
export function createOperationNameCheck(rules: OperationNameRules): (name: string) => string | undefined {
  const allowed =
    rules.validateOperationNames && rules.allowedOperationPatternSource !== undefined
      ? new RegExp(rules.allowedOperationPatternSource, rules.allowedOperationPatternFlags ?? '')
      : undefined;
  const blocked = (rules.blockedOperationPatternSources ?? []).map(
    (source, index) => new RegExp(source, rules.blockedOperationPatternFlags?.[index] ?? ''),
  );

  return (name) => {
    if (allowed) {
      allowed.lastIndex = 0;
      if (!allowed.test(name)) return `Operation "${name}" does not match allowed pattern`;
    }
    for (const pattern of blocked) {
      pattern.lastIndex = 0;
      if (pattern.test(name)) return `Operation "${name}" matches blocked pattern`;
    }
    return undefined;
  };
}

const MAX_ERROR_NAME_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 10000;
const MAX_ERROR_CODE_LENGTH = 100;

/**
 * The error of a failed execution as the host passes it on: text of bounded length. A script can
 * throw an error with a name and a message of any size.
 */
export function boundError(error: SerializedError): { name: string; message: string; code?: string } {
  return {
    name: error.name.slice(0, MAX_ERROR_NAME_LENGTH),
    message: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    ...(error.code !== undefined ? { code: error.code.slice(0, MAX_ERROR_CODE_LENGTH) } : {}),
  };
}

function saneNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Statistics reported by the sandbox, reduced to what statistics can be: durations and
 * timestamps that are not negative, and whole, non-negative counts.
 */
export function normalizeStats(stats: WorkerExecutionStats): ExecutionStats {
  return {
    duration: saneNumber(stats.duration),
    toolCallCount: Math.floor(saneNumber(stats.toolCallCount)),
    iterationCount: Math.floor(saneNumber(stats.iterationCount)),
    startTime: saneNumber(stats.startTime),
    endTime: saneNumber(stats.endTime),
  };
}

/**
 * Counts console output against the limits of the execution, as the inner iframe does before it
 * sends a line. The host console is the host's: what reaches it is the host's to bound.
 *
 * A line is measured by the JSON text of the copy the host makes of it, and that copy is what is
 * printed: what reaches the console is what was counted. A value that is not plain data is not a
 * line the inner iframe wrote; it has no such copy and is dropped.
 */
export class ConsoleBudget {
  private calls = 0;
  private bytes = 0;

  constructor(
    private readonly maxCalls: number,
    private readonly maxBytes: number,
  ) {}

  /**
   * Count one console message.
   *
   * @returns The copy to print, or undefined when the message is beyond the limits or is not a
   *   line the inner iframe could have written
   */
  admit(args: readonly unknown[]): unknown[] | undefined {
    this.calls++;
    if (this.calls > this.maxCalls || this.bytes > this.maxBytes) {
      return undefined;
    }
    let copy: unknown[];
    let size: number;
    try {
      // An item or a key takes two characters of JSON text or more, so a line with more of them
      // than bytes are left is over the limit before it is measured.
      copy = copyConsoleArguments(args, this.maxBytes - this.bytes);
      size = JSON.stringify(copy).length;
    } catch {
      // Not plain data, too deep or too large. The inner iframe only sends what it measured
      // itself; output whose size is unknown is not within any limit.
      return undefined;
    }
    this.bytes += size;
    return this.bytes <= this.maxBytes ? copy : undefined;
  }
}
