/**
 * @enclave-vm/types
 *
 * Type definitions and Zod schemas for the EnclaveJS streaming runtime protocol.
 *
 * @packageDocumentation
 */

// Protocol exports
export {
  PROTOCOL_VERSION,
  SESSION_ID_PREFIX,
  CALL_ID_PREFIX,
  REF_ID_PREFIX,
  generateSessionId,
  generateCallId,
  generateRefId,
  isSessionId,
  isCallId,
  isRefId,
  DEFAULT_SESSION_LIMITS,
  SessionState,
  LogLevel,
  isRefToken,
  createRefToken,
} from './protocol.js';

export type {
  ProtocolVersion,
  SessionId,
  CallId,
  RefId,
  SessionLimits,
  ToolConfig,
  RefToken,
  ErrorInfo,
} from './protocol.js';

// Event exports
export {
  EventType,
  RuntimeChannelMessageType,
  getEventType,
  isSessionInitEvent,
  isStdoutEvent,
  isLogEvent,
  isToolCallEvent,
  isToolResultAppliedEvent,
  isFinalEvent,
  isHeartbeatEvent,
  isErrorEvent,
} from './events.js';

export type {
  BaseEvent,
  EncryptionConfig,
  SessionInitPayload,
  SessionInitEvent,
  StdoutPayload,
  StdoutEvent,
  LogPayload,
  LogEvent,
  ToolCallPayload,
  ToolCallEvent,
  ToolResultAppliedPayload,
  ToolResultAppliedEvent,
  FinalPayload,
  SessionStats,
  FinalEvent,
  HeartbeatPayload,
  HeartbeatEvent,
  ErrorEventPayload,
  ErrorEvent,
  StreamEvent,
  ToolResultSubmitPayload,
  ToolResultSubmitMessage,
  CancelPayload,
  CancelMessage,
  RuntimeChannelMessage,
} from './events.js';

// Encryption exports
export {
  SupportedCurve,
  EncryptionAlgorithm,
  KeyDerivation,
  EncryptionMode,
  EncryptionErrorCode,
  HkdfInfo,
  AES_GCM_NONCE_SIZE,
  AES_GCM_TAG_SIZE,
  AES_256_KEY_SIZE,
  MAX_MESSAGES_PER_KEY,
  isEncryptedEnvelope,
} from './encryption.js';

export type {
  EncryptedEnvelopePayload,
  EncryptedEnvelope,
  ClientHello,
  ServerHello,
  EncryptionRequest,
  SessionKeyInfo,
  MaybeEncrypted,
} from './encryption.js';

// Schema exports
export {
  // Base schemas
  ProtocolVersionSchema,
  SessionIdSchema,
  CallIdSchema,
  RefIdSchema,
  LogLevelSchema,
  SessionStateSchema,
  ErrorInfoSchema,
  RefTokenSchema,
  SessionLimitsSchema,
  ToolConfigSchema,
  BaseEventSchema,
  // Event payload schemas
  EncryptionConfigSchema,
  SessionInitPayloadSchema,
  StdoutPayloadSchema,
  LogPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultAppliedPayloadSchema,
  SessionStatsSchema,
  FinalPayloadSchema,
  HeartbeatPayloadSchema,
  ErrorEventPayloadSchema,
  // Event schemas
  SessionInitEventSchema,
  StdoutEventSchema,
  LogEventSchema,
  ToolCallEventSchema,
  ToolResultAppliedEventSchema,
  FinalEventSchema,
  HeartbeatEventSchema,
  ErrorEventSchema,
  StreamEventSchema,
  // Encryption schemas
  SupportedCurveSchema,
  EncryptionAlgorithmSchema,
  KeyDerivationSchema,
  EncryptionModeSchema,
  EncryptedEnvelopePayloadSchema,
  EncryptedEnvelopeSchema,
  ClientHelloSchema,
  ServerHelloSchema,
  EncryptionRequestSchema,
  // Runtime channel schemas
  ToolResultSubmitPayloadSchema,
  ToolResultSubmitMessageSchema,
  CancelPayloadSchema,
  CancelMessageSchema,
  RuntimeChannelMessageSchema,
  // Session request schemas
  CreateSessionRequestSchema,
  // Validation helpers
  parseStreamEvent,
  parseEncryptedEnvelope,
  parseRuntimeChannelMessage,
  parseCreateSessionRequest,
  parseStreamEventOrEncrypted,
} from './schemas.js';

export type {
  ParsedStreamEvent,
  ParsedEncryptedEnvelope,
  ParsedRuntimeChannelMessage,
  ParsedCreateSessionRequest,
} from './schemas.js';

// Filter exports
export { FilterMode, PatternType, DEFAULT_ALWAYS_ALLOW } from './filter.js';

export type { ContentPattern, TypeFilter, ContentFilter, FilterRule, EventFilterConfig } from './filter.js';
