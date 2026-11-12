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

/** Tool arguments are JSON; the depth is far beyond what a tool takes and well within the stack */
const TOOL_ARGUMENT_LIMITS: CopyLimits = { maxDepth: 100, maxProperties: MAX_TOOL_ARGUMENT_PROPERTIES };

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

interface CopyState {
  properties: number;
  /** Thrown in place of a ProtocolViolationError when `maxProperties` is exceeded */
  tooLarge?: () => Error;
}

/**
 * Copy `value` into fresh host objects.
 *
 * Only what the sandbox legitimately sends is accepted: primitives, arrays, dates and plain
 * objects. Anything else (a Map, a typed array, an Error, a BigInt, ...) cannot have come from
 * the inner iframe's own copy of a result, or from the JSON its tool arguments are, and is
 * refused. The copy never assigns to a key that would reach `Object.prototype`.
 */
function copySandboxData(
  value: unknown,
  depth: number,
  limits: CopyLimits,
  state: CopyState,
  dropped: ReadonlySet<string>,
  what: string,
): unknown {
  if (depth > limits.maxDepth) {
    throw new ProtocolViolationError(`${what} nested more than ${limits.maxDepth} levels deep`);
  }
  if (value === null || value === undefined) {
    return value;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (type !== 'object') {
    throw new ProtocolViolationError(`${what} holding a ${type}`);
  }

  if (Array.isArray(value)) {
    countProperties(value.length, limits, state, what);
    const copy: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      copy[index] = copySandboxData(value[index], depth + 1, limits, state, dropped, what);
    }
    return copy;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolViolationError(`${what} holding an object that is not plain data`);
  }

  const keys = Object.keys(value as object);
  countProperties(keys.length, limits, state, what);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (dropped.has(key)) continue;
    copy[key] = copySandboxData((value as Record<string, unknown>)[key], depth + 1, limits, state, dropped, what);
  }
  return copy;
}

function countProperties(count: number, limits: CopyLimits, state: CopyState, what: string): void {
  state.properties += count;
  if (state.properties > limits.maxProperties) {
    throw state.tooLarge
      ? state.tooLarge()
      : new ProtocolViolationError(`${what} with more than ${limits.maxProperties} properties`);
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
  return copySandboxData(value, 0, limits, { properties: 0 }, RESULT_KEYS_DROPPED, 'a result');
}

/**
 * Copy the arguments of a tool call for the host's tool handler. The handler is host code that
 * will read them, merge them and pass them on: it gets ordinary objects that have no
 * `__proto__`, `constructor` or `prototype` key at any depth.
 *
 * @throws ProtocolViolationError for arguments that are not JSON data
 * @throws ToolArgumentsTooLargeError for more than {@link MAX_TOOL_ARGUMENT_PROPERTIES} items and
 *   keys; the copy stops there
 */
export function copyToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return copySandboxData(
    args,
    0,
    TOOL_ARGUMENT_LIMITS,
    { properties: 0, tooLarge: () => new ToolArgumentsTooLargeError() },
    ARGUMENT_KEYS_DROPPED,
    'tool arguments',
  ) as Record<string, unknown>;
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
 */
export class ConsoleBudget {
  private calls = 0;
  private bytes = 0;

  constructor(
    private readonly maxCalls: number,
    private readonly maxBytes: number,
  ) {}

  /** Whether one more console message with these arguments is within the limits */
  admit(args: readonly unknown[]): boolean {
    this.calls++;
    if (this.calls > this.maxCalls) {
      return false;
    }
    let size: number;
    try {
      size = JSON.stringify(args).length;
    } catch {
      // Not measurable as JSON (a BigInt, a cycle). The inner iframe only sends what it measured
      // itself; output whose size is unknown is not within any limit.
      return false;
    }
    this.bytes += size;
    return this.bytes <= this.maxBytes;
  }
}
