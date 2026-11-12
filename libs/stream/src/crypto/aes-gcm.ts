/**
 * @enclave-vm/stream - AES-GCM Encryption
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
} from '@enclave-vm/types';

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

  // The counter has four bytes in the nonce. A value outside them would repeat the nonce of
  // another counter, so it is refused, never reduced.
  if (typeof counter !== 'bigint' || counter < 0n || counter > 0xffffffffn) {
    throw new AesGcmError('Nonce counter must be between 0 and 2^32 - 1', EncryptionErrorCode.NonceReuse);
  }

  // Write counter as big-endian 4 bytes
  const counterValue = Number(counter);
  nonce[8] = (counterValue >> 24) & 0xff;
  nonce[9] = (counterValue >> 16) & 0xff;
  nonce[10] = (counterValue >> 8) & 0xff;
  nonce[11] = counterValue & 0xff;

  return nonce;
}

/**
 * Bytes converted to characters per step of `toBase64`: far below the number of arguments a
 * call may take, so the size of the input is not limited by the call stack.
 */
const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Encode bytes to base64.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Decode base64 to bytes.
 *
 * @throws AesGcmError when the input is not base64
 */
export function fromBase64(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new AesGcmError('Invalid base64 input', EncryptionErrorCode.DecryptionFailed);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * The header fields of an encrypted envelope: everything that travels in clear next to the
 * ciphertext.
 */
export interface EnvelopeHeader {
  protocolVersion: number;
  sessionId: string;
  seq: number;
  /** Key ID (`payload.kid` of the envelope) */
  kid: string;
}

/**
 * Encode an envelope header as additional authenticated data.
 *
 * The envelope functions pass this to AES-GCM, so the header is covered by the authentication
 * tag: an envelope whose protocol version, session id, sequence number or key id differs from
 * what the sender encrypted under does not decrypt.
 *
 * @throws AesGcmError when a field is not of its type (the encoding must be unambiguous)
 */
export function encodeEnvelopeHeader(header: EnvelopeHeader): Uint8Array {
  const { protocolVersion, sessionId, seq, kid } = header;

  if (
    !Number.isSafeInteger(protocolVersion) ||
    typeof sessionId !== 'string' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof kid !== 'string'
  ) {
    throw new AesGcmError('Invalid envelope header', EncryptionErrorCode.DecryptionFailed);
  }

  return new TextEncoder().encode(JSON.stringify(['enclavejs-envelope', protocolVersion, sessionId, seq, kid]));
}

/**
 * The additional authenticated data of a received envelope, from its own header.
 */
function receivedEnvelopeHeader(envelope: EnvelopeLike): Uint8Array {
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.payload !== 'object' || !envelope.payload) {
    throw new AesGcmError('Invalid envelope', EncryptionErrorCode.DecryptionFailed);
  }

  return encodeEnvelopeHeader({
    protocolVersion: envelope.protocolVersion,
    sessionId: envelope.sessionId,
    seq: envelope.seq,
    kid: envelope.payload.kid,
  });
}

/**
 * An encrypted envelope as it is received: an `EncryptedEnvelope`, or what the schema of
 * `@enclave-vm/types` parses one into.
 */
export interface EnvelopeLike {
  protocolVersion: number;
  sessionId: string;
  seq: number;
  payload: EncryptedEnvelopePayload;
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
 *
 * @param additionalData - Optional additional authenticated data; the same bytes must be given
 *   to `decryptJson`
 */
export async function encryptJson(
  key: CryptoKey,
  keyId: string,
  data: unknown,
  nonce?: Uint8Array,
  additionalData?: Uint8Array,
): Promise<EncryptedEnvelopePayload> {
  const actualNonce = nonce ?? generateNonce();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await encrypt(key, plaintext, actualNonce, additionalData);

  return {
    kid: keyId,
    nonceB64: toBase64(actualNonce),
    ciphertextB64: toBase64(ciphertext),
  };
}

/**
 * Decrypt an encrypted envelope payload and parse as JSON.
 *
 * This reads a payload made by `encryptJson`. The payload of an envelope is read with
 * `openEncryptedEnvelope`, which also checks the envelope's header.
 *
 * @param additionalData - The additional authenticated data given to `encryptJson`, if any
 */
export async function decryptJson<T>(
  key: CryptoKey,
  payload: EncryptedEnvelopePayload,
  additionalData?: Uint8Array,
): Promise<T> {
  const nonce = fromBase64(payload.nonceB64);
  const ciphertext = fromBase64(payload.ciphertextB64);

  const plaintext = await decrypt(key, ciphertext, nonce, additionalData);
  const json = new TextDecoder().decode(plaintext);

  return JSON.parse(json) as T;
}

/**
 * Create an encrypted envelope from an event.
 *
 * The envelope's header (protocol version, session id, sequence number, key id) is
 * authenticated together with the event: read the envelope with `openEncryptedEnvelope`.
 */
export async function createEncryptedEnvelope(
  key: CryptoKey,
  keyId: string,
  sessionId: SessionId,
  seq: number,
  innerEvent: unknown,
  nonce?: Uint8Array,
): Promise<EncryptedEnvelope> {
  const header = encodeEnvelopeHeader({ protocolVersion: PROTOCOL_VERSION, sessionId, seq, kid: keyId });
  const payload = await encryptJson(key, keyId, innerEvent, nonce, header);

  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq,
    type: EventType.Encrypted,
    payload,
  };
}

/**
 * Decrypt an encrypted envelope and parse the event inside it.
 *
 * Fails when the ciphertext or any header field of the envelope (protocol version, session id,
 * sequence number, key id) is not what the sender encrypted. The header fields can therefore be
 * trusted after this returns; whether a sequence number was seen before is for the caller to
 * check.
 */
export async function openEncryptedEnvelope<T>(key: CryptoKey, envelope: EnvelopeLike): Promise<T> {
  return decryptJson<T>(key, envelope.payload, receivedEnvelopeHeader(envelope));
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
   *
   * @param additionalData - Optional additional authenticated data
   */
  async encrypt(
    plaintext: Uint8Array,
    additionalData?: Uint8Array,
  ): Promise<{
    ciphertext: Uint8Array;
    nonce: Uint8Array;
  }> {
    if (this.needsRotation()) {
      throw new AesGcmError('Key needs rotation: nonce limit reached', EncryptionErrorCode.KeyExpired);
    }

    const nonce = generateCounterNonce(this.noncePrefix, this.nonceCounter);
    this.nonceCounter++;

    const ciphertext = await encrypt(this.key, plaintext, nonce, additionalData);

    return { ciphertext, nonce };
  }

  /**
   * Encrypt JSON data.
   *
   * @param additionalData - Optional additional authenticated data; the same bytes must be
   *   given to `decryptJson`
   */
  async encryptJson(data: unknown, additionalData?: Uint8Array): Promise<EncryptedEnvelopePayload> {
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const { ciphertext, nonce } = await this.encrypt(plaintext, additionalData);

    return {
      kid: this.keyId,
      nonceB64: toBase64(nonce),
      ciphertextB64: toBase64(ciphertext),
    };
  }

  /**
   * Create an encrypted envelope.
   *
   * The envelope's header (protocol version, session id, sequence number, key id) is
   * authenticated together with the event: read the envelope with `openEnvelope`.
   */
  async createEnvelope(sessionId: SessionId, seq: number, innerEvent: unknown): Promise<EncryptedEnvelope> {
    const header = encodeEnvelopeHeader({ protocolVersion: PROTOCOL_VERSION, sessionId, seq, kid: this.keyId });
    const payload = await this.encryptJson(innerEvent, header);

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      seq,
      type: EventType.Encrypted,
      payload,
    };
  }

  /**
   * Decrypt a payload made by `encrypt` or `encryptJson`.
   * The payload of an envelope is read with `openEnvelope`.
   *
   * @param additionalData - The additional authenticated data given when encrypting, if any
   */
  async decrypt(payload: EncryptedEnvelopePayload, additionalData?: Uint8Array): Promise<Uint8Array> {
    const nonce = fromBase64(payload.nonceB64);
    const ciphertext = fromBase64(payload.ciphertextB64);

    return decrypt(this.key, ciphertext, nonce, additionalData);
  }

  /**
   * Decrypt and parse JSON from a payload made by `encryptJson`.
   * The payload of an envelope is read with `openEnvelope`.
   *
   * @param additionalData - The additional authenticated data given when encrypting, if any
   */
  async decryptJson<T>(payload: EncryptedEnvelopePayload, additionalData?: Uint8Array): Promise<T> {
    const plaintext = await this.decrypt(payload, additionalData);
    const json = new TextDecoder().decode(plaintext);
    return JSON.parse(json) as T;
  }

  /**
   * Decrypt an encrypted envelope and parse the event inside it.
   *
   * Fails when the ciphertext or any header field of the envelope (protocol version, session
   * id, sequence number, key id) is not what the sender encrypted. Whether a sequence number
   * was seen before is for the caller to check.
   */
  async openEnvelope<T>(envelope: EnvelopeLike): Promise<T> {
    return this.decryptJson<T>(envelope.payload, receivedEnvelopeHeader(envelope));
  }

  /**
   * Get the current nonce counter value.
   */
  getNonceCounter(): bigint {
    return this.nonceCounter;
  }

  /**
   * Create session key info for serialization.
   * The result holds the raw key bytes: treat it as the key itself.
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
