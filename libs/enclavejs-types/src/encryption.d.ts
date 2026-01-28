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
export declare const SupportedCurve: {
  readonly P256: 'P-256';
};
export type SupportedCurve = (typeof SupportedCurve)[keyof typeof SupportedCurve];
/**
 * Encryption algorithm identifiers.
 */
export declare const EncryptionAlgorithm: {
  /** AES-GCM with 256-bit key */
  readonly AES_GCM_256: 'AES-GCM-256';
};
export type EncryptionAlgorithm = (typeof EncryptionAlgorithm)[keyof typeof EncryptionAlgorithm];
/**
 * Key derivation function identifiers.
 */
export declare const KeyDerivation: {
  /** HKDF with SHA-256 */
  readonly HKDF_SHA256: 'HKDF-SHA-256';
};
export type KeyDerivation = (typeof KeyDerivation)[keyof typeof KeyDerivation];
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
export declare const EncryptionMode: {
  /** Encryption is disabled */
  readonly Disabled: 'disabled';
  /** Encryption is optional (server decides) */
  readonly Optional: 'optional';
  /** Encryption is required */
  readonly Required: 'required';
};
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
/**
 * Encryption-specific error codes.
 */
export declare const EncryptionErrorCode: {
  /** Handshake failed */
  readonly HandshakeFailed: 'ENCRYPTION_HANDSHAKE_FAILED';
  /** Key derivation failed */
  readonly KeyDerivationFailed: 'ENCRYPTION_KEY_DERIVATION_FAILED';
  /** Decryption failed (invalid ciphertext or authentication) */
  readonly DecryptionFailed: 'ENCRYPTION_DECRYPTION_FAILED';
  /** Nonce reuse detected */
  readonly NonceReuse: 'ENCRYPTION_NONCE_REUSE';
  /** Key expired or needs rotation */
  readonly KeyExpired: 'ENCRYPTION_KEY_EXPIRED';
  /** Unsupported algorithm */
  readonly UnsupportedAlgorithm: 'ENCRYPTION_UNSUPPORTED_ALGORITHM';
  /** Invalid public key */
  readonly InvalidPublicKey: 'ENCRYPTION_INVALID_PUBLIC_KEY';
  /** Signature verification failed */
  readonly SignatureVerificationFailed: 'ENCRYPTION_SIGNATURE_VERIFICATION_FAILED';
};
export type EncryptionErrorCode = (typeof EncryptionErrorCode)[keyof typeof EncryptionErrorCode];
/**
 * Input or output that can be either plaintext or encrypted.
 */
export type MaybeEncrypted<T> = T | EncryptedEnvelope;
/**
 * Check if a value is an encrypted envelope.
 */
export declare function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope;
/**
 * HKDF info strings for different key purposes.
 */
export declare const HkdfInfo: {
  /** Client -> Server encryption key */
  readonly ClientToServer: 'enclavejs-c2s-enc';
  /** Server -> Client encryption key */
  readonly ServerToClient: 'enclavejs-s2c-enc';
};
export type HkdfInfo = (typeof HkdfInfo)[keyof typeof HkdfInfo];
/**
 * Nonce/IV size in bytes for AES-GCM.
 */
export declare const AES_GCM_NONCE_SIZE = 12;
/**
 * Authentication tag size in bytes for AES-GCM.
 */
export declare const AES_GCM_TAG_SIZE = 16;
/**
 * Key size in bytes for AES-256.
 */
export declare const AES_256_KEY_SIZE = 32;
/**
 * Maximum number of messages with one key (2^32 for AES-GCM with random nonces).
 * We use a lower limit (2^30) to be safe.
 */
export declare const MAX_MESSAGES_PER_KEY = 1073741824n;
