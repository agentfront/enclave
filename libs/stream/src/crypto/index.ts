/**
 * @enclave-vm/stream - Crypto module
 *
 * Primitives for per-hop encryption: ECDH key exchange, HKDF key derivation and AES-GCM.
 *
 * Nothing in this repository wires them into a client or a broker. The key exchange is not
 * authenticated; see the package README for what an application that uses them has to add.
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
  openEncryptedEnvelope,
  encodeEnvelopeHeader,
  SessionEncryptionContext,
  AesGcmError,
} from './aes-gcm.js';

export type { EnvelopeHeader, EnvelopeLike } from './aes-gcm.js';
