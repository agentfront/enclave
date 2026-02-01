/**
 * @enclave-vm/stream - HKDF Key Derivation
 *
 * HMAC-based Key Derivation Function using Web Crypto API.
 * Derives encryption keys from ECDH shared secret.
 */

import { HkdfInfo, AES_256_KEY_SIZE, EncryptionErrorCode } from '@enclave-vm/types';

/**
 * Convert a Uint8Array to an ArrayBuffer.
 * Handles the case where the Uint8Array is a view into a larger buffer.
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) {
    return arr.buffer as ArrayBuffer;
  }
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/**
 * HKDF derivation error.
 */
export class HkdfError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'HkdfError';
  }
}

/**
 * Get the Web Crypto subtle API.
 */
function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  throw new HkdfError('Web Crypto API not available', EncryptionErrorCode.KeyDerivationFailed);
}

/**
 * Derive a key using HKDF-SHA256.
 *
 * @param sharedSecret - The shared secret from ECDH
 * @param salt - Optional salt (defaults to zeros)
 * @param info - Context info string
 * @param keyLength - Output key length in bytes (default: 32 for AES-256)
 */
export async function deriveKey(
  sharedSecret: Uint8Array,
  salt: Uint8Array | null,
  info: string,
  keyLength: number = AES_256_KEY_SIZE,
): Promise<Uint8Array> {
  const subtle = getSubtle();

  try {
    // Import the shared secret as a raw key for HKDF
    const baseKey = await subtle.importKey('raw', toArrayBuffer(sharedSecret), 'HKDF', false, ['deriveBits']);

    // Use empty salt if not provided
    const saltBytes = salt ?? new Uint8Array(32);

    // Encode info string as bytes
    const infoBytes = new TextEncoder().encode(info);

    // Derive the key bits
    const derivedBits = await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(saltBytes),
        info: toArrayBuffer(infoBytes),
      },
      baseKey,
      keyLength * 8, // bits
    );

    return new Uint8Array(derivedBits);
  } catch (err) {
    throw new HkdfError(
      `Failed to derive key: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.KeyDerivationFailed,
    );
  }
}

/**
 * Derive session keys for bidirectional communication.
 *
 * @param sharedSecret - The shared secret from ECDH
 * @param sessionId - Session ID for domain separation
 * @returns Client-to-server and server-to-client encryption keys
 */
export async function deriveSessionKeys(
  sharedSecret: Uint8Array,
  sessionId: string,
): Promise<{
  clientToServerKey: Uint8Array;
  serverToClientKey: Uint8Array;
}> {
  // Use session ID as salt for domain separation
  const salt = new TextEncoder().encode(sessionId);

  // Derive separate keys for each direction
  const [clientToServerKey, serverToClientKey] = await Promise.all([
    deriveKey(sharedSecret, salt, HkdfInfo.ClientToServer),
    deriveKey(sharedSecret, salt, HkdfInfo.ServerToClient),
  ]);

  return {
    clientToServerKey,
    serverToClientKey,
  };
}

/**
 * Import a raw key as a CryptoKey for AES-GCM.
 */
export async function importAesGcmKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();

  try {
    return await subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      {
        name: 'AES-GCM',
        length: keyBytes.length * 8,
      },
      false, // not extractable
      ['encrypt', 'decrypt'],
    );
  } catch (err) {
    throw new HkdfError(
      `Failed to import AES key: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.KeyDerivationFailed,
    );
  }
}

/**
 * Derive and import session keys as CryptoKeys.
 */
export async function deriveSessionCryptoKeys(
  sharedSecret: Uint8Array,
  sessionId: string,
): Promise<{
  clientToServerKey: CryptoKey;
  serverToClientKey: CryptoKey;
}> {
  const { clientToServerKey, serverToClientKey } = await deriveSessionKeys(sharedSecret, sessionId);

  const [c2sKey, s2cKey] = await Promise.all([importAesGcmKey(clientToServerKey), importAesGcmKey(serverToClientKey)]);

  return {
    clientToServerKey: c2sKey,
    serverToClientKey: s2cKey,
  };
}
