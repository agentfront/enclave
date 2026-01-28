/**
 * @enclave-vm/types - Zod schemas
 *
 * Runtime validation schemas for all protocol types.
 * These schemas are used for validating incoming messages from untrusted sources.
 */
import { z } from 'zod';
/**
 * Protocol version schema.
 */
export declare const ProtocolVersionSchema: z.ZodLiteral<1>;
/**
 * Session ID schema.
 */
export declare const SessionIdSchema: z.ZodString;
/**
 * Call ID schema.
 */
export declare const CallIdSchema: z.ZodString;
/**
 * Reference ID schema.
 */
export declare const RefIdSchema: z.ZodString;
/**
 * Log level schema.
 */
export declare const LogLevelSchema: z.ZodEnum<{
  error: 'error';
  info: 'info';
  warn: 'warn';
  debug: 'debug';
}>;
/**
 * Session state schema.
 */
export declare const SessionStateSchema: z.ZodEnum<{
  starting: 'starting';
  running: 'running';
  waiting_for_tool: 'waiting_for_tool';
  completed: 'completed';
  cancelled: 'cancelled';
  failed: 'failed';
}>;
/**
 * Error info schema.
 */
export declare const ErrorInfoSchema: z.ZodObject<
  {
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    stack: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Reference token schema.
 */
export declare const RefTokenSchema: z.ZodObject<
  {
    $ref: z.ZodObject<
      {
        id: z.ZodString;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Session limits schema.
 */
export declare const SessionLimitsSchema: z.ZodObject<
  {
    sessionTtlMs: z.ZodOptional<z.ZodNumber>;
    maxToolCalls: z.ZodOptional<z.ZodNumber>;
    maxStdoutBytes: z.ZodOptional<z.ZodNumber>;
    maxToolResultBytes: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    heartbeatIntervalMs: z.ZodOptional<z.ZodNumber>;
  },
  z.core.$strip
>;
/**
 * Tool config schema.
 */
export declare const ToolConfigSchema: z.ZodObject<
  {
    timeout: z.ZodOptional<z.ZodNumber>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    maxRetries: z.ZodOptional<z.ZodNumber>;
    runtimeReadable: z.ZodOptional<z.ZodBoolean>;
  },
  z.core.$strip
>;
/**
 * Base event schema (common fields).
 */
export declare const BaseEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
  },
  z.core.$strip
>;
/**
 * Encryption config schema.
 */
export declare const EncryptionConfigSchema: z.ZodObject<
  {
    enabled: z.ZodBoolean;
    keyId: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Session init payload schema.
 */
export declare const SessionInitPayloadSchema: z.ZodObject<
  {
    cancelUrl: z.ZodString;
    expiresAt: z.ZodString;
    encryption: z.ZodObject<
      {
        enabled: z.ZodBoolean;
        keyId: z.ZodOptional<z.ZodString>;
      },
      z.core.$strip
    >;
    replayUrl: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Stdout payload schema.
 */
export declare const StdoutPayloadSchema: z.ZodObject<
  {
    chunk: z.ZodString;
  },
  z.core.$strip
>;
/**
 * Log payload schema.
 */
export declare const LogPayloadSchema: z.ZodObject<
  {
    level: z.ZodEnum<{
      error: 'error';
      info: 'info';
      warn: 'warn';
      debug: 'debug';
    }>;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  },
  z.core.$strip
>;
/**
 * Tool call payload schema.
 */
export declare const ToolCallPayloadSchema: z.ZodObject<
  {
    callId: z.ZodString;
    toolName: z.ZodString;
    args: z.ZodUnknown;
  },
  z.core.$strip
>;
/**
 * Tool result applied payload schema.
 */
export declare const ToolResultAppliedPayloadSchema: z.ZodObject<
  {
    callId: z.ZodString;
  },
  z.core.$strip
>;
/**
 * Session stats schema.
 */
export declare const SessionStatsSchema: z.ZodObject<
  {
    durationMs: z.ZodNumber;
    toolCallCount: z.ZodNumber;
    stdoutBytes: z.ZodNumber;
  },
  z.core.$strip
>;
/**
 * Final payload schema.
 */
export declare const FinalPayloadSchema: z.ZodObject<
  {
    ok: z.ZodBoolean;
    result: z.ZodOptional<z.ZodUnknown>;
    error: z.ZodOptional<
      z.ZodObject<
        {
          message: z.ZodString;
          code: z.ZodOptional<z.ZodString>;
          stack: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    stats: z.ZodOptional<
      z.ZodObject<
        {
          durationMs: z.ZodNumber;
          toolCallCount: z.ZodNumber;
          stdoutBytes: z.ZodNumber;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * Heartbeat payload schema.
 */
export declare const HeartbeatPayloadSchema: z.ZodObject<
  {
    ts: z.ZodString;
  },
  z.core.$strip
>;
/**
 * Error event payload schema.
 */
export declare const ErrorEventPayloadSchema: z.ZodObject<
  {
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    recoverable: z.ZodOptional<z.ZodBoolean>;
  },
  z.core.$strip
>;
/**
 * Session init event schema.
 */
export declare const SessionInitEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'session_init'>;
    payload: z.ZodObject<
      {
        cancelUrl: z.ZodString;
        expiresAt: z.ZodString;
        encryption: z.ZodObject<
          {
            enabled: z.ZodBoolean;
            keyId: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >;
        replayUrl: z.ZodOptional<z.ZodString>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Stdout event schema.
 */
export declare const StdoutEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'stdout'>;
    payload: z.ZodObject<
      {
        chunk: z.ZodString;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Log event schema.
 */
export declare const LogEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'log'>;
    payload: z.ZodObject<
      {
        level: z.ZodEnum<{
          error: 'error';
          info: 'info';
          warn: 'warn';
          debug: 'debug';
        }>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Tool call event schema.
 */
export declare const ToolCallEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'tool_call'>;
    payload: z.ZodObject<
      {
        callId: z.ZodString;
        toolName: z.ZodString;
        args: z.ZodUnknown;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Tool result applied event schema.
 */
export declare const ToolResultAppliedEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'tool_result_applied'>;
    payload: z.ZodObject<
      {
        callId: z.ZodString;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Final event schema.
 */
export declare const FinalEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'final'>;
    payload: z.ZodObject<
      {
        ok: z.ZodBoolean;
        result: z.ZodOptional<z.ZodUnknown>;
        error: z.ZodOptional<
          z.ZodObject<
            {
              message: z.ZodString;
              code: z.ZodOptional<z.ZodString>;
              stack: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        stats: z.ZodOptional<
          z.ZodObject<
            {
              durationMs: z.ZodNumber;
              toolCallCount: z.ZodNumber;
              stdoutBytes: z.ZodNumber;
            },
            z.core.$strip
          >
        >;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Heartbeat event schema.
 */
export declare const HeartbeatEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'heartbeat'>;
    payload: z.ZodObject<
      {
        ts: z.ZodString;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Error event schema.
 */
export declare const ErrorEventSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'error'>;
    payload: z.ZodObject<
      {
        message: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
        recoverable: z.ZodOptional<z.ZodBoolean>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Stream event union schema.
 */
export declare const StreamEventSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'session_init'>;
        payload: z.ZodObject<
          {
            cancelUrl: z.ZodString;
            expiresAt: z.ZodString;
            encryption: z.ZodObject<
              {
                enabled: z.ZodBoolean;
                keyId: z.ZodOptional<z.ZodString>;
              },
              z.core.$strip
            >;
            replayUrl: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'stdout'>;
        payload: z.ZodObject<
          {
            chunk: z.ZodString;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'log'>;
        payload: z.ZodObject<
          {
            level: z.ZodEnum<{
              error: 'error';
              info: 'info';
              warn: 'warn';
              debug: 'debug';
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'tool_call'>;
        payload: z.ZodObject<
          {
            callId: z.ZodString;
            toolName: z.ZodString;
            args: z.ZodUnknown;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'tool_result_applied'>;
        payload: z.ZodObject<
          {
            callId: z.ZodString;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'final'>;
        payload: z.ZodObject<
          {
            ok: z.ZodBoolean;
            result: z.ZodOptional<z.ZodUnknown>;
            error: z.ZodOptional<
              z.ZodObject<
                {
                  message: z.ZodString;
                  code: z.ZodOptional<z.ZodString>;
                  stack: z.ZodOptional<z.ZodString>;
                },
                z.core.$strip
              >
            >;
            stats: z.ZodOptional<
              z.ZodObject<
                {
                  durationMs: z.ZodNumber;
                  toolCallCount: z.ZodNumber;
                  stdoutBytes: z.ZodNumber;
                },
                z.core.$strip
              >
            >;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'heartbeat'>;
        payload: z.ZodObject<
          {
            ts: z.ZodString;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        type: z.ZodLiteral<'error'>;
        payload: z.ZodObject<
          {
            message: z.ZodString;
            code: z.ZodOptional<z.ZodString>;
            recoverable: z.ZodOptional<z.ZodBoolean>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
  ],
  'type'
>;
/**
 * Supported curve schema.
 */
export declare const SupportedCurveSchema: z.ZodEnum<{
  'P-256': 'P-256';
}>;
/**
 * Encryption algorithm schema.
 */
export declare const EncryptionAlgorithmSchema: z.ZodEnum<{
  'AES-GCM-256': 'AES-GCM-256';
}>;
/**
 * Key derivation schema.
 */
export declare const KeyDerivationSchema: z.ZodEnum<{
  'HKDF-SHA-256': 'HKDF-SHA-256';
}>;
/**
 * Encryption mode schema.
 */
export declare const EncryptionModeSchema: z.ZodEnum<{
  required: 'required';
  disabled: 'disabled';
  optional: 'optional';
}>;
/**
 * Encrypted envelope payload schema.
 */
export declare const EncryptedEnvelopePayloadSchema: z.ZodObject<
  {
    kid: z.ZodString;
    nonceB64: z.ZodString;
    ciphertextB64: z.ZodString;
    tagB64: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Encrypted envelope schema.
 */
export declare const EncryptedEnvelopeSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    type: z.ZodLiteral<'enc'>;
    payload: z.ZodObject<
      {
        kid: z.ZodString;
        nonceB64: z.ZodString;
        ciphertextB64: z.ZodString;
        tagB64: z.ZodOptional<z.ZodString>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Client hello schema.
 */
export declare const ClientHelloSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    clientEphemeralPubKeyB64: z.ZodString;
    curve: z.ZodEnum<{
      'P-256': 'P-256';
    }>;
    supportedAlgorithms: z.ZodArray<
      z.ZodEnum<{
        'AES-GCM-256': 'AES-GCM-256';
      }>
    >;
  },
  z.core.$strip
>;
/**
 * Server hello schema.
 */
export declare const ServerHelloSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    serverEphemeralPubKeyB64: z.ZodString;
    curve: z.ZodEnum<{
      'P-256': 'P-256';
    }>;
    selectedAlgorithm: z.ZodEnum<{
      'AES-GCM-256': 'AES-GCM-256';
    }>;
    kdf: z.ZodEnum<{
      'HKDF-SHA-256': 'HKDF-SHA-256';
    }>;
    keyId: z.ZodString;
    signatureB64: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Encryption request schema.
 */
export declare const EncryptionRequestSchema: z.ZodObject<
  {
    mode: z.ZodEnum<{
      required: 'required';
      disabled: 'disabled';
      optional: 'optional';
    }>;
    clientHello: z.ZodOptional<
      z.ZodObject<
        {
          protocolVersion: z.ZodLiteral<1>;
          clientEphemeralPubKeyB64: z.ZodString;
          curve: z.ZodEnum<{
            'P-256': 'P-256';
          }>;
          supportedAlgorithms: z.ZodArray<
            z.ZodEnum<{
              'AES-GCM-256': 'AES-GCM-256';
            }>
          >;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * Tool result submit payload schema.
 */
export declare const ToolResultSubmitPayloadSchema: z.ZodObject<
  {
    callId: z.ZodString;
    ok: z.ZodBoolean;
    result: z.ZodOptional<z.ZodUnknown>;
    error: z.ZodOptional<
      z.ZodObject<
        {
          message: z.ZodString;
          code: z.ZodOptional<z.ZodString>;
          stack: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * Tool result submit message schema.
 */
export declare const ToolResultSubmitMessageSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    type: z.ZodLiteral<'tool_result_submit'>;
    payload: z.ZodObject<
      {
        callId: z.ZodString;
        ok: z.ZodBoolean;
        result: z.ZodOptional<z.ZodUnknown>;
        error: z.ZodOptional<
          z.ZodObject<
            {
              message: z.ZodString;
              code: z.ZodOptional<z.ZodString>;
              stack: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Cancel payload schema.
 */
export declare const CancelPayloadSchema: z.ZodObject<
  {
    reason: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Cancel message schema.
 */
export declare const CancelMessageSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    type: z.ZodLiteral<'cancel'>;
    payload: z.ZodObject<
      {
        reason: z.ZodOptional<z.ZodString>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
/**
 * Runtime channel message union schema.
 */
export declare const RuntimeChannelMessageSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        type: z.ZodLiteral<'tool_result_submit'>;
        payload: z.ZodObject<
          {
            callId: z.ZodString;
            ok: z.ZodBoolean;
            result: z.ZodOptional<z.ZodUnknown>;
            error: z.ZodOptional<
              z.ZodObject<
                {
                  message: z.ZodString;
                  code: z.ZodOptional<z.ZodString>;
                  stack: z.ZodOptional<z.ZodString>;
                },
                z.core.$strip
              >
            >;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        protocolVersion: z.ZodLiteral<1>;
        sessionId: z.ZodString;
        type: z.ZodLiteral<'cancel'>;
        payload: z.ZodObject<
          {
            reason: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >,
  ],
  'type'
>;
/**
 * Session creation request schema.
 */
export declare const CreateSessionRequestSchema: z.ZodObject<
  {
    protocolVersion: z.ZodLiteral<1>;
    code: z.ZodString;
    limits: z.ZodOptional<
      z.ZodObject<
        {
          sessionTtlMs: z.ZodOptional<z.ZodNumber>;
          maxToolCalls: z.ZodOptional<z.ZodNumber>;
          maxStdoutBytes: z.ZodOptional<z.ZodNumber>;
          maxToolResultBytes: z.ZodOptional<z.ZodNumber>;
          toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
          heartbeatIntervalMs: z.ZodOptional<z.ZodNumber>;
        },
        z.core.$strip
      >
    >;
    encryption: z.ZodOptional<
      z.ZodObject<
        {
          mode: z.ZodEnum<{
            required: 'required';
            disabled: 'disabled';
            optional: 'optional';
          }>;
          clientHello: z.ZodOptional<
            z.ZodObject<
              {
                protocolVersion: z.ZodLiteral<1>;
                clientEphemeralPubKeyB64: z.ZodString;
                curve: z.ZodEnum<{
                  'P-256': 'P-256';
                }>;
                supportedAlgorithms: z.ZodArray<
                  z.ZodEnum<{
                    'AES-GCM-256': 'AES-GCM-256';
                  }>
                >;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * Parse and validate a stream event.
 */
export declare function parseStreamEvent(data: unknown): z.ZodSafeParseResult<
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'session_init';
      payload: {
        cancelUrl: string;
        expiresAt: string;
        encryption: {
          enabled: boolean;
          keyId?: string | undefined;
        };
        replayUrl?: string | undefined;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'stdout';
      payload: {
        chunk: string;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'log';
      payload: {
        level: 'error' | 'info' | 'warn' | 'debug';
        message: string;
        data?: Record<string, unknown> | undefined;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'tool_call';
      payload: {
        callId: string;
        toolName: string;
        args: unknown;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'tool_result_applied';
      payload: {
        callId: string;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'final';
      payload: {
        ok: boolean;
        result?: unknown;
        error?:
          | {
              message: string;
              code?: string | undefined;
              stack?: string | undefined;
            }
          | undefined;
        stats?:
          | {
              durationMs: number;
              toolCallCount: number;
              stdoutBytes: number;
            }
          | undefined;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'heartbeat';
      payload: {
        ts: string;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'error';
      payload: {
        message: string;
        code?: string | undefined;
        recoverable?: boolean | undefined;
      };
    }
>;
/**
 * Parse and validate an encrypted envelope.
 */
export declare function parseEncryptedEnvelope(data: unknown): z.ZodSafeParseResult<{
  protocolVersion: 1;
  sessionId: string;
  seq: number;
  type: 'enc';
  payload: {
    kid: string;
    nonceB64: string;
    ciphertextB64: string;
    tagB64?: string | undefined;
  };
}>;
/**
 * Parse and validate a runtime channel message.
 */
export declare function parseRuntimeChannelMessage(data: unknown): z.ZodSafeParseResult<
  | {
      protocolVersion: 1;
      sessionId: string;
      type: 'tool_result_submit';
      payload: {
        callId: string;
        ok: boolean;
        result?: unknown;
        error?:
          | {
              message: string;
              code?: string | undefined;
              stack?: string | undefined;
            }
          | undefined;
      };
    }
  | {
      protocolVersion: 1;
      sessionId: string;
      type: 'cancel';
      payload: {
        reason?: string | undefined;
      };
    }
>;
/**
 * Parse and validate a session creation request.
 */
export declare function parseCreateSessionRequest(data: unknown): z.ZodSafeParseResult<{
  protocolVersion: 1;
  code: string;
  limits?:
    | {
        sessionTtlMs?: number | undefined;
        maxToolCalls?: number | undefined;
        maxStdoutBytes?: number | undefined;
        maxToolResultBytes?: number | undefined;
        toolTimeoutMs?: number | undefined;
        heartbeatIntervalMs?: number | undefined;
      }
    | undefined;
  encryption?:
    | {
        mode: 'required' | 'disabled' | 'optional';
        clientHello?:
          | {
              protocolVersion: 1;
              clientEphemeralPubKeyB64: string;
              curve: 'P-256';
              supportedAlgorithms: 'AES-GCM-256'[];
            }
          | undefined;
      }
    | undefined;
}>;
/**
 * Parse either a stream event or encrypted envelope.
 */
export declare function parseStreamEventOrEncrypted(data: unknown):
  | z.ZodSafeParseResult<
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'session_init';
          payload: {
            cancelUrl: string;
            expiresAt: string;
            encryption: {
              enabled: boolean;
              keyId?: string | undefined;
            };
            replayUrl?: string | undefined;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'stdout';
          payload: {
            chunk: string;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'log';
          payload: {
            level: 'error' | 'info' | 'warn' | 'debug';
            message: string;
            data?: Record<string, unknown> | undefined;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'tool_call';
          payload: {
            callId: string;
            toolName: string;
            args: unknown;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'tool_result_applied';
          payload: {
            callId: string;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'final';
          payload: {
            ok: boolean;
            result?: unknown;
            error?:
              | {
                  message: string;
                  code?: string | undefined;
                  stack?: string | undefined;
                }
              | undefined;
            stats?:
              | {
                  durationMs: number;
                  toolCallCount: number;
                  stdoutBytes: number;
                }
              | undefined;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'heartbeat';
          payload: {
            ts: string;
          };
        }
      | {
          protocolVersion: 1;
          sessionId: string;
          seq: number;
          type: 'error';
          payload: {
            message: string;
            code?: string | undefined;
            recoverable?: boolean | undefined;
          };
        }
    >
  | z.ZodSafeParseResult<{
      protocolVersion: 1;
      sessionId: string;
      seq: number;
      type: 'enc';
      payload: {
        kid: string;
        nonceB64: string;
        ciphertextB64: string;
        tagB64?: string | undefined;
      };
    }>;
export type ParsedStreamEvent = z.infer<typeof StreamEventSchema>;
export type ParsedEncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type ParsedRuntimeChannelMessage = z.infer<typeof RuntimeChannelMessageSchema>;
export type ParsedCreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
