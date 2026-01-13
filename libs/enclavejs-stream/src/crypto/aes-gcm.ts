/**
 * @enclavejs/stream - AES-GCM Encryption
 *
 * AES-GCM authenticated encryption using Web Crypto API.
 */

import {
  AES_GCM_NONCE_SIZE,
  AES_GCM_TAG_SIZE,
  MAX_MESSAGES_PER_KEY,
  EncryptionErrorCode,
  type EncryptedEnvelopePayload,
  type SessionKeyInfo,
  PROTOCOL_VERSION,
  EventType,
  type EncryptedEnvelope,
  type SessionId,
  EncryptionAlgorithm,
} from '@enclavejs/types';

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
 * AES-GCM encryption error.
 */
export class AesGcmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AesGcmError';
  }
}

/**
 * Get the Web Crypto subtle API.
 */
function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  throw new AesGcmError('Web Crypto API not available', EncryptionErrorCode.DecryptionFailed);
}

/**
 * Generate a random nonce for AES-GCM.
 */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(AES_GCM_NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Generate a counter-based nonce for deterministic nonce generation.
 * Uses 8 bytes of random prefix + 4 bytes of counter.
 */
export function generateCounterNonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  if (prefix.length !== 8) {
    throw new AesGcmError('Nonce prefix must be 8 bytes', EncryptionErrorCode.NonceReuse);
  }

  const nonce = new Uint8Array(AES_GCM_NONCE_SIZE);
  nonce.set(prefix);

  // Write counter as big-endian 4 bytes
  const counterValue = Number(counter & 0xffffffffn);
  nonce[8] = (counterValue >> 24) & 0xff;
  nonce[9] = (counterValue >> 16) & 0xff;
  nonce[10] = (counterValue >> 8) & 0xff;
  nonce[11] = counterValue & 0xff;

  return nonce;
}

/**
 * Encode bytes to base64.
 */
export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode base64 to bytes.
 */
export function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * Encrypt data using AES-GCM.
 *
 * @param key - CryptoKey for AES-GCM
 * @param plaintext - Data to encrypt
 * @param nonce - 12-byte nonce/IV
 * @param additionalData - Optional additional authenticated data (AAD)
 * @returns Ciphertext with appended authentication tag
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtle();

  if (nonce.length !== AES_GCM_NONCE_SIZE) {
    throw new AesGcmError(
      `Invalid nonce length: expected ${AES_GCM_NONCE_SIZE}, got ${nonce.length}`,
      EncryptionErrorCode.DecryptionFailed,
    );
  }

  try {
    const ciphertext = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        tagLength: AES_GCM_TAG_SIZE * 8, // bits
        additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
      },
      key,
      toArrayBuffer(plaintext),
    );

    return new Uint8Array(ciphertext);
  } catch (err) {
    throw new AesGcmError(
      `Encryption failed: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.DecryptionFailed,
    );
  }
}

/**
 * Decrypt data using AES-GCM.
 *
 * @param key - CryptoKey for AES-GCM
 * @param ciphertext - Data to decrypt (with authentication tag)
 * @param nonce - 12-byte nonce/IV used during encryption
 * @param additionalData - Optional additional authenticated data (AAD)
 * @returns Decrypted plaintext
 */
export async function decrypt(
  key: CryptoKey,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtle();

  if (nonce.length !== AES_GCM_NONCE_SIZE) {
    throw new AesGcmError(
      `Invalid nonce length: expected ${AES_GCM_NONCE_SIZE}, got ${nonce.length}`,
      EncryptionErrorCode.DecryptionFailed,
    );
  }

  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        tagLength: AES_GCM_TAG_SIZE * 8, // bits
        additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
      },
      key,
      toArrayBuffer(ciphertext),
    );

    return new Uint8Array(plaintext);
  } catch (err) {
    throw new AesGcmError(
      `Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.DecryptionFailed,
    );
  }
}

/**
 * Encrypt a JSON object and create an encrypted envelope payload.
 */
export async function encryptJson(
  key: CryptoKey,
  keyId: string,
  data: unknown,
  nonce?: Uint8Array,
): Promise<EncryptedEnvelopePayload> {
  const actualNonce = nonce ?? generateNonce();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await encrypt(key, plaintext, actualNonce);

  return {
    kid: keyId,
    nonceB64: toBase64(actualNonce),
    ciphertextB64: toBase64(ciphertext),
  };
}

/**
 * Decrypt an encrypted envelope payload and parse as JSON.
 */
export async function decryptJson<T>(key: CryptoKey, payload: EncryptedEnvelopePayload): Promise<T> {
  const nonce = fromBase64(payload.nonceB64);
  const ciphertext = fromBase64(payload.ciphertextB64);

  const plaintext = await decrypt(key, ciphertext, nonce);
  const json = new TextDecoder().decode(plaintext);

  return JSON.parse(json) as T;
}

/**
 * Create an encrypted envelope from an event.
 */
export async function createEncryptedEnvelope(
  key: CryptoKey,
  keyId: string,
  sessionId: SessionId,
  seq: number,
  innerEvent: unknown,
  nonce?: Uint8Array,
): Promise<EncryptedEnvelope> {
  const payload = await encryptJson(key, keyId, innerEvent, nonce);

  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq,
    type: EventType.Encrypted,
    payload,
  };
}

/**
 * Session encryption context for managing key state.
 */
export class SessionEncryptionContext {
  private readonly key: CryptoKey;
  private readonly keyInfo: SessionKeyInfo;
  private nonceCounter: bigint;
  private readonly noncePrefix: Uint8Array;

  constructor(key: CryptoKey, keyInfo: SessionKeyInfo) {
    this.key = key;
    this.keyInfo = keyInfo;
    this.nonceCounter = keyInfo.nonceCounter;
    this.noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  }

  /**
   * Get the key ID.
   */
  get keyId(): string {
    return this.keyInfo.keyId;
  }

  /**
   * Check if the key needs rotation.
   */
  needsRotation(): boolean {
    return this.nonceCounter >= this.keyInfo.maxNonces;
  }

  /**
   * Encrypt data and increment the nonce counter.
   */
  async encrypt(plaintext: Uint8Array): Promise<{
    ciphertext: Uint8Array;
    nonce: Uint8Array;
  }> {
    if (this.needsRotation()) {
      throw new AesGcmError('Key needs rotation: nonce limit reached', EncryptionErrorCode.KeyExpired);
    }

    const nonce = generateCounterNonce(this.noncePrefix, this.nonceCounter);
    this.nonceCounter++;

    const ciphertext = await encrypt(this.key, plaintext, nonce);

    return { ciphertext, nonce };
  }

  /**
   * Encrypt JSON data.
   */
  async encryptJson(data: unknown): Promise<EncryptedEnvelopePayload> {
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const { ciphertext, nonce } = await this.encrypt(plaintext);

    return {
      kid: this.keyId,
      nonceB64: toBase64(nonce),
      ciphertextB64: toBase64(ciphertext),
    };
  }

  /**
   * Create an encrypted envelope.
   */
  async createEnvelope(sessionId: SessionId, seq: number, innerEvent: unknown): Promise<EncryptedEnvelope> {
    const payload = await this.encryptJson(innerEvent);

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      seq,
      type: EventType.Encrypted,
      payload,
    };
  }

  /**
   * Decrypt an encrypted envelope payload.
   */
  async decrypt(payload: EncryptedEnvelopePayload): Promise<Uint8Array> {
    const nonce = fromBase64(payload.nonceB64);
    const ciphertext = fromBase64(payload.ciphertextB64);

    return decrypt(this.key, ciphertext, nonce);
  }

  /**
   * Decrypt and parse JSON from an encrypted envelope payload.
   */
  async decryptJson<T>(payload: EncryptedEnvelopePayload): Promise<T> {
    const plaintext = await this.decrypt(payload);
    const json = new TextDecoder().decode(plaintext);
    return JSON.parse(json) as T;
  }

  /**
   * Get the current nonce counter value.
   */
  getNonceCounter(): bigint {
    return this.nonceCounter;
  }

  /**
   * Create session key info for serialization.
   */
  toKeyInfo(): SessionKeyInfo {
    return {
      ...this.keyInfo,
      nonceCounter: this.nonceCounter,
    };
  }

  /**
   * Create a new encryption context from raw key bytes.
   */
  static async fromKeyBytes(keyBytes: Uint8Array, keyId: string): Promise<SessionEncryptionContext> {
    const subtle = getSubtle();

    const key = await subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      {
        name: 'AES-GCM',
        length: keyBytes.length * 8,
      },
      false,
      ['encrypt', 'decrypt'],
    );

    const keyInfo: SessionKeyInfo = {
      keyId,
      algorithm: EncryptionAlgorithm.AES_GCM_256,
      keyBytes,
      nonceCounter: 0n,
      maxNonces: MAX_MESSAGES_PER_KEY,
      createdAt: Date.now(),
    };

    return new SessionEncryptionContext(key, keyInfo);
  }
}
