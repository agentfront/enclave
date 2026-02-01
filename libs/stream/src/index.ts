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
} from './ndjson.js';

export type { ParseResult } from './ndjson.js';

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
  SessionEncryptionContext,
  AesGcmError,
} from './crypto/index.js';

export type { EcdhKeyPair, SerializedPublicKey } from './crypto/index.js';

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
