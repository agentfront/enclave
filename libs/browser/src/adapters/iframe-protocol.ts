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

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
const ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export const toolCallMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('tool-call'),
    requestId: z.string().min(1).max(100).regex(ID_PATTERN),
    callId: z.string().min(1).max(100).regex(ID_PATTERN),
    toolName: z.string().min(1).max(256).regex(TOOL_NAME_PATTERN),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

export const resultMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('result'),
    requestId: z.string().min(1).max(100).regex(ID_PATTERN),
    success: z.boolean(),
    value: z.unknown().optional(),
    error: z
      .object({
        name: z.string().max(100),
        message: z.string().max(10000),
        code: z.string().max(100).optional(),
        stack: z.string().max(10000).optional(),
      })
      .optional(),
    stats: z.object({
      duration: z.number().nonnegative(),
      toolCallCount: z.number().nonnegative().int(),
      iterationCount: z.number().nonnegative().int(),
      startTime: z.number().nonnegative(),
      endTime: z.number().nonnegative(),
    }),
  })
  .strict();

export const consoleMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('console'),
    requestId: z.string().min(1).max(100).regex(ID_PATTERN),
    level: z.enum(['log', 'warn', 'error', 'info']),
    args: z.array(z.unknown()).max(100),
  })
  .strict();

export const readyMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('ready'),
  })
  .strict();

export const toolResponseMessageSchema = z
  .object({
    __enclave_msg__: z.literal(true),
    type: z.literal('tool-response'),
    requestId: z.string().min(1).max(100).regex(ID_PATTERN),
    callId: z.string().min(1).max(100).regex(ID_PATTERN),
    result: z.unknown().optional(),
    error: z
      .object({
        name: z.string().max(100),
        message: z.string().max(10000),
        code: z.string().max(100).optional(),
      })
      .optional(),
  })
  .strict();

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
