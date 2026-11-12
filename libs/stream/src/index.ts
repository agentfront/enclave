/**
 * @enclave-vm/stream
 *
 * Streaming protocol implementation for EnclaveJS runtime.
 * Includes NDJSON parsing, encryption, and reconnection handling.
 *
 * @packageDocumentation
 */

// Re-export types from @enclave-vm/types
export * from '@enclave-vm/types';

// NDJSON exports
export {
  serializeEvent,
  serializeEvents,
  parseLine,
  parseLines,
  NdjsonStreamParser,
  createNdjsonParseStream,
  createNdjsonSerializeStream,
  parseNdjsonStream,
  DEFAULT_MAX_LINE_LENGTH,
  NdjsonLineTooLongError,
} from './ndjson.js';

export type { ParseResult, NdjsonParseOptions } from './ndjson.js';

// Crypto exports
export {
  // ECDH
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
  createClientHello,
  createServerHello,
  processClientHello,
  processServerHello,
  EcdhError,
  // HKDF
  deriveKey,
  deriveSessionKeys,
  importAesGcmKey,
  deriveSessionCryptoKeys,
  HkdfError,
  // AES-GCM
  generateNonce,
  generateCounterNonce,
  toBase64,
  fromBase64,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  encodeEnvelopeHeader,
  SessionEncryptionContext,
  AesGcmError,
} from './crypto/index.js';

export type { EcdhKeyPair, SerializedPublicKey, EnvelopeHeader, EnvelopeLike } from './crypto/index.js';

// Reconnection exports
export {
  ConnectionState,
  DEFAULT_RECONNECTION_CONFIG,
  ReconnectionStateMachine,
  SequenceTracker,
  EventBuffer,
  HeartbeatMonitor,
} from './reconnect.js';

export type { ReconnectionConfig, ReconnectionEvent } from './reconnect.js';
