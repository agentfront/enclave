/**
 * @enclave-vm/stream
 *
 * Streaming protocol building blocks for the EnclaveJS runtime:
 * NDJSON parsing, reconnection helpers and encryption primitives.
 *
 * The encryption primitives are not used by the client or the broker of this repository;
 * an application that wants encrypted events wires them into both of its ends itself.
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
