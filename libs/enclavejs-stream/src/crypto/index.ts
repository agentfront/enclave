/**
 * @enclavejs/stream - Crypto module
 *
 * Per-hop encryption using ECDH key exchange and AES-GCM encryption.
 */

// ECDH key exchange
export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
  createClientHello,
  createServerHello,
  processClientHello,
  processServerHello,
  EcdhError,
} from './ecdh.js';

export type { EcdhKeyPair, SerializedPublicKey } from './ecdh.js';

// HKDF key derivation
export { deriveKey, deriveSessionKeys, importAesGcmKey, deriveSessionCryptoKeys, HkdfError } from './hkdf.js';

// AES-GCM encryption
export {
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
} from './aes-gcm.js';
