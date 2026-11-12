/**
 * Iframe PostMessage Protocol
 *
 * Typed message protocol for communication between host page, outer iframe,
 * and inner iframe. All messages carry `__enclave_msg__: true` discriminator.
 *
 * Mirrors the structure of libs/core/src/adapters/worker-pool/protocol.ts
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SerializedIframeConfig } from '../types';

// ============================================================================
// Serialized Error (cross-boundary safe)
// ============================================================================

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

// ============================================================================
// Execution Statistics
// ============================================================================

export interface WorkerExecutionStats {
  duration: number;
  toolCallCount: number;
  iterationCount: number;
  startTime: number;
  endTime: number;
}

// ============================================================================
// Host -> Outer Iframe Messages
// ============================================================================

export interface ExecuteMessage {
  __enclave_msg__: true;
  type: 'execute';
  requestId: string;
  code: string;
  config: SerializedIframeConfig;
}

export interface ToolResponseMessage {
  __enclave_msg__: true;
  type: 'tool-response';
  requestId: string;
  callId: string;
  result?: unknown;
  error?: SerializedError;
  /**
   * Set when the error is a failure of the tool itself (its handler threw or rejected), as
   * opposed to the enclave refusing the call. A script's `callTool(..., { throwOnError: false })`
   * receives only such failures as a result object.
   */
  toolError?: boolean;
}

export interface AbortMessage {
  __enclave_msg__: true;
  type: 'abort';
  requestId: string;
}

export type HostToOuterMessage = ExecuteMessage | ToolResponseMessage | AbortMessage;

// ============================================================================
// Outer Iframe -> Host Messages
// ============================================================================

export interface ReadyMessage {
  __enclave_msg__: true;
  type: 'ready';
  requestId?: string;
}

export interface ToolCallMessage {
  __enclave_msg__: true;
  type: 'tool-call';
  requestId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ResultMessage {
  __enclave_msg__: true;
  type: 'result';
  requestId: string;
  success: boolean;
  value?: unknown;
  error?: SerializedError;
  stats: WorkerExecutionStats;
}

export interface ConsoleMessage {
  __enclave_msg__: true;
  type: 'console';
  requestId: string;
  level: 'log' | 'warn' | 'error' | 'info';
  args: unknown[];
}

export type OuterToHostMessage = ReadyMessage | ToolCallMessage | ResultMessage | ConsoleMessage;

// ============================================================================
// Outer <-> Inner Iframe Messages (same protocol, outer acts as relay)
// ============================================================================

export type InnerToOuterMessage = ToolCallMessage | ResultMessage | ConsoleMessage;
export type OuterToInnerMessage = ToolResponseMessage | AbortMessage;

// ============================================================================
// Validation Schemas
// ============================================================================

// The schemas describe the messages as the iframes send them. The host applies them to every
// message that comes out of the sandbox (see parseOuterToHostMessage); a message that does not
// match is not acted on.

const ID_PATTERN = /^[a-zA-Z0-9-]+$/;
const idSchema = z.string().min(1).max(100).regex(ID_PATTERN);

/** Longest tool name the host accepts from the sandbox */
export const MAX_TOOL_NAME_LENGTH = 256;

export const toolCallMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('tool-call'),
    requestId: idSchema,
    callId: idSchema,
    // Which names are allowed is configuration (parentValidation's operation patterns, which the
    // host applies as well); the protocol only requires a name of sane length.
    toolName: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

// Lengths are not limited here: an error text that is too long is cut by the host, not refused.
// A script can throw an error with any message, and that must not look like a broken protocol.
const serializedErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional(),
  })
  .strict();

// The values are normalized by the host rather than refused (a clock that is set back while a
// script runs gives a negative duration), so the schema only requires numbers.
const statsSchema = z
  .object({
    duration: z.number(),
    toolCallCount: z.number(),
    iterationCount: z.number(),
    startTime: z.number(),
    endTime: z.number(),
  })
  .strict();

export const resultMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('result'),
    requestId: idSchema,
    success: z.boolean(),
    value: z.unknown().optional(),
    error: serializedErrorSchema.optional(),
    stats: statsSchema,
  })
  .strict();

export const consoleMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('console'),
    requestId: idSchema,
    level: z.enum(['log', 'warn', 'error', 'info']),
    args: z.array(z.unknown()),
  })
  .strict();

export const readyMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('ready'),
    // The outer iframe stamps its request id on everything it sends
    requestId: idSchema.optional(),
  })
  .strict();

export const toolResponseMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('tool-response'),
    requestId: idSchema,
    callId: idSchema,
    result: z.unknown().optional(),
    error: z
      .object({
        name: z.string().max(100),
        message: z.string().max(10000),
        code: z.string().max(100).optional(),
      })
      .optional(),
    toolError: z.boolean().optional(),
  })
  .strict();

const OUTER_TO_HOST_SCHEMAS = {
  'tool-call': toolCallMessageSchema,
  result: resultMessageSchema,
  console: consoleMessageSchema,
  ready: readyMessageSchema,
} as const;

/** What {@link parseOuterToHostMessage} returns */
export type ParsedOuterToHostMessage = { ok: true; message: OuterToHostMessage } | { ok: false; reason: string };

/**
 * Check a message that came out of the sandbox against the protocol.
 *
 * @param data The message data, already known to carry the enclave marker
 * @param requestId The id of the execution the receiving host is running
 * @returns The message, typed, or why it is not one the protocol allows
 */
export function parseOuterToHostMessage(data: { type: string }, requestId: string): ParsedOuterToHostMessage {
  const schema = Object.prototype.hasOwnProperty.call(OUTER_TO_HOST_SCHEMAS, data.type)
    ? OUTER_TO_HOST_SCHEMAS[data.type as keyof typeof OUTER_TO_HOST_SCHEMAS]
    : undefined;
  if (!schema) {
    return { ok: false, reason: 'unknown message type' };
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'message';
    return { ok: false, reason: `${data.type} message, ${where}: ${issue ? issue.message : 'invalid'}` };
  }

  const message = parsed.data as OuterToHostMessage;
  if ('requestId' in message && message.requestId !== undefined && message.requestId !== requestId) {
    return { ok: false, reason: `${data.type} message for another execution` };
  }
  return { ok: true, message };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a postMessage event data is an enclave message
 */
export function isEnclaveMessage(data: unknown): data is { __enclave_msg__: true; type: string } {
  return (
    data !== null &&
    typeof data === 'object' &&
    (data as Record<string, unknown>)['__enclave_msg__'] === true &&
    typeof (data as Record<string, unknown>)['type'] === 'string'
  );
}

export function isToolCallMessage(msg: { type: string }): msg is ToolCallMessage {
  return msg.type === 'tool-call';
}

export function isResultMessage(msg: { type: string }): msg is ResultMessage {
  return msg.type === 'result';
}

export function isConsoleMessage(msg: { type: string }): msg is ConsoleMessage {
  return msg.type === 'console';
}

export function isReadyMessage(msg: { type: string }): msg is ReadyMessage {
  return msg.type === 'ready';
}

export function isToolResponseMessage(msg: { type: string }): msg is ToolResponseMessage {
  return msg.type === 'tool-response';
}

/**
 * Generate a unique ID for requests/calls
 * Falls back to Math.random-based ID if crypto.randomUUID is unavailable
 * (sandboxed iframes without allow-same-origin may lack crypto.randomUUID)
 */
export function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for sandboxed contexts
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }
}
