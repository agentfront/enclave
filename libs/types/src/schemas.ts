/**
 * @enclave-vm/types - Zod schemas
 *
 * Runtime validation schemas for all protocol types.
 * These schemas are used for validating incoming messages from untrusted sources.
 */

import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  SESSION_ID_PREFIX,
  CALL_ID_PREFIX,
  REF_ID_PREFIX,
  SessionState,
  LogLevel,
} from './protocol.js';
import { EventType, RuntimeChannelMessageType } from './events.js';
import { SupportedCurve, EncryptionAlgorithm, KeyDerivation, EncryptionMode } from './encryption.js';

// ============================================================================
// Base Schemas
// ============================================================================

/**
 * Protocol version schema (accepts v1 and v2).
 */
export const ProtocolVersionSchema = z.union([z.literal(PROTOCOL_VERSION), z.literal(1)]);

/**
 * Session ID schema.
 */
export const SessionIdSchema = z
  .string()
  .startsWith(SESSION_ID_PREFIX)
  .min(SESSION_ID_PREFIX.length + 1);

/**
 * Call ID schema.
 */
export const CallIdSchema = z
  .string()
  .startsWith(CALL_ID_PREFIX)
  .min(CALL_ID_PREFIX.length + 1);

/**
 * Reference ID schema.
 */
export const RefIdSchema = z
  .string()
  .startsWith(REF_ID_PREFIX)
  .min(REF_ID_PREFIX.length + 1);

/**
 * Log level schema.
 */
export const LogLevelSchema = z.enum([LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error]);

/**
 * Session state schema.
 */
export const SessionStateSchema = z.enum([
  SessionState.Starting,
  SessionState.Running,
  SessionState.WaitingForTool,
  SessionState.Completed,
  SessionState.Cancelled,
  SessionState.Failed,
]);

/**
 * Error info schema.
 */
export const ErrorInfoSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
});

/**
 * Reference token schema.
 */
export const RefTokenSchema = z.object({
  $ref: z.object({
    id: RefIdSchema,
  }),
});

/**
 * Session limits schema.
 */
export const SessionLimitsSchema = z.object({
  sessionTtlMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxStdoutBytes: z.number().int().positive().optional(),
  maxToolResultBytes: z.number().int().positive().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  deadlineMs: z.number().int().nonnegative().optional(),
  perToolDeadlineMs: z.number().int().positive().optional(),
  cancelOnFirstError: z.boolean().optional(),
});

/**
 * Tool config schema.
 */
export const ToolConfigSchema = z.object({
  timeout: z.number().int().positive().optional(),
  retryable: z.boolean().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  runtimeReadable: z.boolean().optional(),
});

// ============================================================================
// Base Event Schema
// ============================================================================

/**
 * Base event schema (common fields).
 */
export const BaseEventSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  sessionId: SessionIdSchema,
  seq: z.number().int().nonnegative(),
});

// ============================================================================
// Event Payload Schemas
// ============================================================================

/**
 * Encryption config schema.
 */
export const EncryptionConfigSchema = z.object({
  enabled: z.boolean(),
  keyId: z.string().optional(),
});

/**
 * Session init payload schema.
 */
export const SessionInitPayloadSchema = z.object({
  cancelUrl: z.string(),
  expiresAt: z.string().datetime(),
  encryption: EncryptionConfigSchema,
  replayUrl: z.string().optional(),
});

/**
 * Stdout payload schema.
 */
export const StdoutPayloadSchema = z.object({
  chunk: z.string(),
});

/**
 * Log payload schema.
 */
export const LogPayloadSchema = z.object({
  level: LogLevelSchema,
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Tool call payload schema.
 */
export const ToolCallPayloadSchema = z.object({
  callId: CallIdSchema,
  toolName: z.string().min(1),
  args: z.unknown(),
});

/**
 * Tool result applied payload schema.
 */
export const ToolResultAppliedPayloadSchema = z.object({
  callId: CallIdSchema,
});

/**
 * Session stats schema.
 */
export const SessionStatsSchema = z.object({
  durationMs: z.number().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
});

/**
 * Error detail schema.
 */
export const ErrorDetailSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retry_info'), retryDelayMs: z.number().nonnegative() }),
  z.object({ type: z.literal('upstream_info'), statusCode: z.number().int(), url: z.string() }),
  z.object({ type: z.literal('validation_info'), field: z.string(), reason: z.string() }),
  z.object({ type: z.literal('quota_info'), limit: z.number().nonnegative(), used: z.number().nonnegative() }),
]);

/**
 * Error payload schema (rich error model).
 */
export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.array(z.string()).optional(),
  details: z.array(ErrorDetailSchema).optional(),
});

/**
 * Final payload schema.
 */
export const FinalPayloadSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: ErrorInfoSchema.optional(),
  errors: z.array(ErrorPayloadSchema).optional(),
  stats: SessionStatsSchema.optional(),
});

/**
 * Heartbeat payload schema.
 */
export const HeartbeatPayloadSchema = z.object({
  ts: z.string().datetime(),
});

/**
 * Error event payload schema.
 */
export const ErrorEventPayloadSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  recoverable: z.boolean().optional(),
});

// ============================================================================
// Event Schemas
// ============================================================================

/**
 * Session init event schema.
 */
export const SessionInitEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SessionInit),
  payload: SessionInitPayloadSchema,
});

/**
 * Stdout event schema.
 */
export const StdoutEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.Stdout),
  payload: StdoutPayloadSchema,
});

/**
 * Log event schema.
 */
export const LogEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.Log),
  payload: LogPayloadSchema,
});

/**
 * Tool call event schema.
 */
export const ToolCallEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolCall),
  payload: ToolCallPayloadSchema,
});

/**
 * Tool result applied event schema.
 */
export const ToolResultAppliedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolResultApplied),
  payload: ToolResultAppliedPayloadSchema,
});

/**
 * Final event schema.
 */
export const FinalEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.Final),
  payload: FinalPayloadSchema,
});

/**
 * Heartbeat event schema.
 */
export const HeartbeatEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.Heartbeat),
  payload: HeartbeatPayloadSchema,
});

/**
 * Error event schema.
 */
export const ErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.Error),
  payload: ErrorEventPayloadSchema,
});

/**
 * Partial result payload schema.
 */
export const PartialResultPayloadSchema = z.object({
  path: z.array(z.string()),
  data: z.unknown().optional(),
  error: ErrorPayloadSchema.optional(),
  hasNext: z.boolean(),
});

/**
 * Partial result event schema.
 */
export const PartialResultEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.PartialResult),
  payload: PartialResultPayloadSchema,
});

/**
 * Tool progress phase schema.
 */
export const ToolProgressPhaseSchema = z.enum(['connecting', 'sending', 'receiving', 'processing']);

/**
 * Tool progress payload schema.
 */
export const ToolProgressPayloadSchema = z.object({
  callId: CallIdSchema,
  phase: ToolProgressPhaseSchema,
  bytesReceived: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative(),
});

/**
 * Tool progress event schema.
 */
export const ToolProgressEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolProgress),
  payload: ToolProgressPayloadSchema,
});

/**
 * Deadline exceeded payload schema.
 */
export const DeadlineExceededPayloadSchema = z.object({
  elapsedMs: z.number().nonnegative(),
  budgetMs: z.number().positive(),
});

/**
 * Deadline exceeded event schema.
 */
export const DeadlineExceededEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.DeadlineExceeded),
  payload: DeadlineExceededPayloadSchema,
});

/**
 * Catalog changed payload schema.
 */
export const CatalogChangedPayloadSchema = z.object({
  version: z.string().min(1),
  addedActions: z.array(z.string()),
  removedActions: z.array(z.string()),
});

/**
 * Catalog changed event schema.
 */
export const CatalogChangedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CatalogChanged),
  payload: CatalogChangedPayloadSchema,
});

/**
 * Stream event union schema.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  SessionInitEventSchema,
  StdoutEventSchema,
  LogEventSchema,
  ToolCallEventSchema,
  ToolResultAppliedEventSchema,
  FinalEventSchema,
  HeartbeatEventSchema,
  ErrorEventSchema,
  PartialResultEventSchema,
  ToolProgressEventSchema,
  DeadlineExceededEventSchema,
  CatalogChangedEventSchema,
]);

// ============================================================================
// Encryption Schemas
// ============================================================================

/**
 * Supported curve schema.
 */
export const SupportedCurveSchema = z.enum([SupportedCurve.P256]);

/**
 * Encryption algorithm schema.
 */
export const EncryptionAlgorithmSchema = z.enum([EncryptionAlgorithm.AES_GCM_256]);

/**
 * Key derivation schema.
 */
export const KeyDerivationSchema = z.enum([KeyDerivation.HKDF_SHA256]);

/**
 * Encryption mode schema.
 */
export const EncryptionModeSchema = z.enum([EncryptionMode.Disabled, EncryptionMode.Optional, EncryptionMode.Required]);

/**
 * Encrypted envelope payload schema.
 */
export const EncryptedEnvelopePayloadSchema = z.object({
  kid: z.string().min(1),
  nonceB64: z.string().min(1),
  ciphertextB64: z.string().min(1),
  tagB64: z.string().optional(),
});

/**
 * Encrypted envelope schema.
 */
export const EncryptedEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  sessionId: SessionIdSchema,
  seq: z.number().int().nonnegative(),
  type: z.literal(EventType.Encrypted),
  payload: EncryptedEnvelopePayloadSchema,
});

/**
 * Client hello schema.
 */
export const ClientHelloSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  clientEphemeralPubKeyB64: z.string().min(1),
  curve: SupportedCurveSchema,
  supportedAlgorithms: z.array(EncryptionAlgorithmSchema).min(1),
});

/**
 * Server hello schema.
 */
export const ServerHelloSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  serverEphemeralPubKeyB64: z.string().min(1),
  curve: SupportedCurveSchema,
  selectedAlgorithm: EncryptionAlgorithmSchema,
  kdf: KeyDerivationSchema,
  keyId: z.string().min(1),
  signatureB64: z.string().optional(),
});

/**
 * Encryption request schema.
 */
export const EncryptionRequestSchema = z.object({
  mode: EncryptionModeSchema,
  clientHello: ClientHelloSchema.optional(),
});

// ============================================================================
// Runtime Channel Message Schemas
// ============================================================================

/**
 * Tool result submit payload schema.
 */
export const ToolResultSubmitPayloadSchema = z.object({
  callId: CallIdSchema,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: ErrorInfoSchema.optional(),
});

/**
 * Tool result submit message schema.
 */
export const ToolResultSubmitMessageSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  sessionId: SessionIdSchema,
  type: z.literal(RuntimeChannelMessageType.ToolResultSubmit),
  payload: ToolResultSubmitPayloadSchema,
});

/**
 * Cancel payload schema.
 */
export const CancelPayloadSchema = z.object({
  reason: z.string().optional(),
});

/**
 * Cancel message schema.
 */
export const CancelMessageSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  sessionId: SessionIdSchema,
  type: z.literal(RuntimeChannelMessageType.Cancel),
  payload: CancelPayloadSchema,
});

/**
 * Runtime channel message union schema.
 */
export const RuntimeChannelMessageSchema = z.discriminatedUnion('type', [
  ToolResultSubmitMessageSchema,
  CancelMessageSchema,
]);

// ============================================================================
// Session Request Schemas
// ============================================================================

/**
 * Session creation request schema.
 */
export const CreateSessionRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  code: z.string().min(1),
  limits: SessionLimitsSchema.optional(),
  encryption: EncryptionRequestSchema.optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate a stream event.
 */
export function parseStreamEvent(data: unknown) {
  return StreamEventSchema.safeParse(data);
}

/**
 * Parse and validate an encrypted envelope.
 */
export function parseEncryptedEnvelope(data: unknown) {
  return EncryptedEnvelopeSchema.safeParse(data);
}

/**
 * Parse and validate a runtime channel message.
 */
export function parseRuntimeChannelMessage(data: unknown) {
  return RuntimeChannelMessageSchema.safeParse(data);
}

/**
 * Parse and validate a session creation request.
 */
export function parseCreateSessionRequest(data: unknown) {
  return CreateSessionRequestSchema.safeParse(data);
}

/**
 * Parse either a stream event or encrypted envelope.
 */
export function parseStreamEventOrEncrypted(data: unknown) {
  // Try encrypted envelope first (quick check on type field)
  if (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as { type: unknown }).type === EventType.Encrypted
  ) {
    return EncryptedEnvelopeSchema.safeParse(data);
  }
  return StreamEventSchema.safeParse(data);
}

// ============================================================================
// Type Inference Helpers
// ============================================================================

export type ParsedStreamEvent = z.infer<typeof StreamEventSchema>;
export type ParsedEncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type ParsedRuntimeChannelMessage = z.infer<typeof RuntimeChannelMessageSchema>;
export type ParsedCreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
