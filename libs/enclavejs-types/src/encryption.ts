/**
 * @enclave-vm/types - Encryption types
 *
 * Types for per-hop encryption using ECDH + AES-GCM.
 * Encryption is optional but recommended to prevent intermediaries from reading payloads.
 */

import type { ProtocolVersion, SessionId } from './protocol.js';
import type { EventType } from './events.js';

/**
 * Supported elliptic curves for ECDH key exchange.
 * Using P-256 for broad browser compatibility via Web Crypto API.
 */
export const SupportedCurve = {
  P256: 'P-256',
} as const;

export type SupportedCurve = (typeof SupportedCurve)[keyof typeof SupportedCurve];

/**
 * Encryption algorithm identifiers.
 */
export const EncryptionAlgorithm = {
  /** AES-GCM with 256-bit key */
  AES_GCM_256: 'AES-GCM-256',
} as const;

export type EncryptionAlgorithm = (typeof EncryptionAlgorithm)[keyof typeof EncryptionAlgorithm];

/**
 * Key derivation function identifiers.
 */
export const KeyDerivation = {
  /** HKDF with SHA-256 */
  HKDF_SHA256: 'HKDF-SHA-256',
} as const;

export type KeyDerivation = (typeof KeyDerivation)[keyof typeof KeyDerivation];

// ============================================================================
// Encrypted Envelope
// ============================================================================

/**
 * Encrypted envelope payload.
 * Contains the encrypted inner event.
 */
export interface EncryptedEnvelopePayload {
  /** Key ID identifying which session key to use */
  kid: string;
  /** Base64-encoded nonce/IV (12 bytes for AES-GCM) */
  nonceB64: string;
  /** Base64-encoded ciphertext (encrypted JSON of inner event) */
  ciphertextB64: string;
  /** Base64-encoded authentication tag (16 bytes for AES-GCM) */
  tagB64?: string;
}

/**
 * Encrypted envelope event.
 * Wraps any other event type when encryption is enabled.
 */
export interface EncryptedEnvelope {
  protocolVersion: ProtocolVersion;
  sessionId: SessionId;
  /** Sequence number (visible even when encrypted for ordering) */
  seq: number;
  type: typeof EventType.Encrypted;
  payload: EncryptedEnvelopePayload;
}

// ============================================================================
// Key Exchange (Handshake)
// ============================================================================

/**
 * Client hello - first message in handshake.
 * Sent by client with session creation request.
 */
export interface ClientHello {
  /** Protocol version */
  protocolVersion: ProtocolVersion;
  /** Client's ephemeral public key (base64 encoded) */
  clientEphemeralPubKeyB64: string;
  /** Elliptic curve used */
  curve: SupportedCurve;
  /** Encryption algorithms the client supports */
  supportedAlgorithms: EncryptionAlgorithm[];
}

/**
 * Server hello - response to client hello.
 * Included in session_init event when encryption is negotiated.
 */
export interface ServerHello {
  /** Protocol version */
  protocolVersion: ProtocolVersion;
  /** Server's ephemeral public key (base64 encoded) */
  serverEphemeralPubKeyB64: string;
  /** Elliptic curve used */
  curve: SupportedCurve;
  /** Selected encryption algorithm */
  selectedAlgorithm: EncryptionAlgorithm;
  /** Key derivation function used */
  kdf: KeyDerivation;
  /** Key ID for the derived session key */
  keyId: string;
  /**
   * Signature over the handshake transcript (base64 encoded).
   * Allows client to verify server identity if server has a pinned key.
   */
  signatureB64?: string;
}

/**
 * Encryption mode for session creation request.
 */
export const EncryptionMode = {
  /** Encryption is disabled */
  Disabled: 'disabled',
  /** Encryption is optional (server decides) */
  Optional: 'optional',
  /** Encryption is required */
  Required: 'required',
} as const;

export type EncryptionMode = (typeof EncryptionMode)[keyof typeof EncryptionMode];

/**
 * Encryption request in session creation.
 */
export interface EncryptionRequest {
  /** Requested encryption mode */
  mode: EncryptionMode;
  /** Client hello (required if mode is not 'disabled') */
  clientHello?: ClientHello;
}

// ============================================================================
// Session Key Info
// ============================================================================

/**
 * Session encryption key information.
 * Used internally by both client and server.
 */
export interface SessionKeyInfo {
  /** Key ID */
  keyId: string;
  /** Encryption algorithm */
  algorithm: EncryptionAlgorithm;
  /** Raw key bytes (32 bytes for AES-256) */
  keyBytes: Uint8Array;
  /** Counter for nonce generation (to avoid nonce reuse) */
  nonceCounter: bigint;
  /** Maximum nonces before key rotation required */
  maxNonces: bigint;
  /** Timestamp when key was derived */
  createdAt: number;
}

// ============================================================================
// Encryption Errors
// ============================================================================

/**
 * Encryption-specific error codes.
 */
export const EncryptionErrorCode = {
  /** Handshake failed */
  HandshakeFailed: 'ENCRYPTION_HANDSHAKE_FAILED',
  /** Key derivation failed */
  KeyDerivationFailed: 'ENCRYPTION_KEY_DERIVATION_FAILED',
  /** Decryption failed (invalid ciphertext or authentication) */
  DecryptionFailed: 'ENCRYPTION_DECRYPTION_FAILED',
  /** Nonce reuse detected */
  NonceReuse: 'ENCRYPTION_NONCE_REUSE',
  /** Key expired or needs rotation */
  KeyExpired: 'ENCRYPTION_KEY_EXPIRED',
  /** Unsupported algorithm */
  UnsupportedAlgorithm: 'ENCRYPTION_UNSUPPORTED_ALGORITHM',
  /** Invalid public key */
  InvalidPublicKey: 'ENCRYPTION_INVALID_PUBLIC_KEY',
  /** Signature verification failed */
  SignatureVerificationFailed: 'ENCRYPTION_SIGNATURE_VERIFICATION_FAILED',
} as const;

export type EncryptionErrorCode = (typeof EncryptionErrorCode)[keyof typeof EncryptionErrorCode];

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Input or output that can be either plaintext or encrypted.
 */
export type MaybeEncrypted<T> = T | EncryptedEnvelope;

/**
 * Check if a value is an encrypted envelope.
 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'enc' &&
    'payload' in value &&
    typeof (value as EncryptedEnvelope).payload === 'object' &&
    (value as EncryptedEnvelope).payload !== null &&
    'kid' in (value as EncryptedEnvelope).payload &&
    'nonceB64' in (value as EncryptedEnvelope).payload &&
    'ciphertextB64' in (value as EncryptedEnvelope).payload
  );
}

/**
 * HKDF info strings for different key purposes.
 */
export const HkdfInfo = {
  /** Client -> Server encryption key */
  ClientToServer: 'enclavejs-c2s-enc',
  /** Server -> Client encryption key */
  ServerToClient: 'enclavejs-s2c-enc',
} as const;

export type HkdfInfo = (typeof HkdfInfo)[keyof typeof HkdfInfo];

/**
 * Nonce/IV size in bytes for AES-GCM.
 */
export const AES_GCM_NONCE_SIZE = 12;

/**
 * Authentication tag size in bytes for AES-GCM.
 */
export const AES_GCM_TAG_SIZE = 16;

/**
 * Key size in bytes for AES-256.
 */
export const AES_256_KEY_SIZE = 32;

/**
 * Maximum number of messages with one key (2^32 for AES-GCM with random nonces).
 * We use a lower limit (2^30) to be safe.
 */
export const MAX_MESSAGES_PER_KEY = 1073741824n; // 2^30
