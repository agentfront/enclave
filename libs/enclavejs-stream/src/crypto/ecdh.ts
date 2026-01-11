/**
 * @enclavejs/stream - ECDH Key Exchange
 *
 * Elliptic Curve Diffie-Hellman key exchange using Web Crypto API.
 * Uses P-256 curve for broad browser compatibility.
 */

import {
  SupportedCurve,
  EncryptionErrorCode,
  type ClientHello,
  type ServerHello,
  PROTOCOL_VERSION,
  EncryptionAlgorithm,
  KeyDerivation,
} from '@enclavejs/types';

/**
 * ECDH key pair.
 */
export interface EcdhKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/**
 * Serialized ECDH public key.
 */
export interface SerializedPublicKey {
  /** Base64-encoded public key (raw format) */
  publicKeyB64: string;
  /** Curve used */
  curve: SupportedCurve;
}

/**
 * ECDH encryption error.
 */
export class EcdhError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'EcdhError';
  }
}

/**
 * Get the Web Crypto subtle API.
 * Works in both browser and Node.js 20+.
 */
function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  throw new EcdhError('Web Crypto API not available', EncryptionErrorCode.HandshakeFailed);
}

/**
 * Generate an ephemeral ECDH key pair.
 */
export async function generateKeyPair(curve: SupportedCurve = SupportedCurve.P256): Promise<EcdhKeyPair> {
  const subtle = getSubtle();

  try {
    const keyPair = await subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: curve,
      },
      true, // extractable for export
      ['deriveBits'],
    );

    return {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    };
  } catch (err) {
    throw new EcdhError(
      `Failed to generate key pair: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.HandshakeFailed,
    );
  }
}

/**
 * Export a public key to base64 format.
 */
export async function exportPublicKey(publicKey: CryptoKey): Promise<SerializedPublicKey> {
  const subtle = getSubtle();

  try {
    const rawKey = await subtle.exportKey('raw', publicKey);
    const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)));

    // Extract curve from key algorithm
    const algorithm = publicKey.algorithm as EcKeyAlgorithm;
    const curve = algorithm.namedCurve as SupportedCurve;

    return { publicKeyB64, curve };
  } catch (err) {
    throw new EcdhError(
      `Failed to export public key: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.InvalidPublicKey,
    );
  }
}

/**
 * Import a public key from base64 format.
 */
export async function importPublicKey(
  publicKeyB64: string,
  curve: SupportedCurve = SupportedCurve.P256,
): Promise<CryptoKey> {
  const subtle = getSubtle();

  try {
    const rawKey = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));

    return await subtle.importKey(
      'raw',
      rawKey,
      {
        name: 'ECDH',
        namedCurve: curve,
      },
      true,
      [],
    );
  } catch (err) {
    throw new EcdhError(
      `Failed to import public key: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.InvalidPublicKey,
    );
  }
}

/**
 * Derive shared secret from private key and peer's public key.
 */
export async function deriveSharedSecret(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<Uint8Array> {
  const subtle = getSubtle();

  try {
    // Derive 256 bits (32 bytes) of shared secret
    const sharedBits = await subtle.deriveBits(
      {
        name: 'ECDH',
        public: peerPublicKey,
      },
      privateKey,
      256,
    );

    return new Uint8Array(sharedBits);
  } catch (err) {
    throw new EcdhError(
      `Failed to derive shared secret: ${err instanceof Error ? err.message : String(err)}`,
      EncryptionErrorCode.KeyDerivationFailed,
    );
  }
}

/**
 * Create a client hello message for the encryption handshake.
 */
export async function createClientHello(keyPair: EcdhKeyPair): Promise<ClientHello> {
  const { publicKeyB64, curve } = await exportPublicKey(keyPair.publicKey);

  return {
    protocolVersion: PROTOCOL_VERSION,
    clientEphemeralPubKeyB64: publicKeyB64,
    curve,
    supportedAlgorithms: [EncryptionAlgorithm.AES_GCM_256],
  };
}

/**
 * Create a server hello message for the encryption handshake.
 */
export async function createServerHello(keyPair: EcdhKeyPair, keyId: string): Promise<ServerHello> {
  const { publicKeyB64, curve } = await exportPublicKey(keyPair.publicKey);

  return {
    protocolVersion: PROTOCOL_VERSION,
    serverEphemeralPubKeyB64: publicKeyB64,
    curve,
    selectedAlgorithm: EncryptionAlgorithm.AES_GCM_256,
    kdf: KeyDerivation.HKDF_SHA256,
    keyId,
  };
}

/**
 * Process a client hello and generate server response.
 */
export async function processClientHello(clientHello: ClientHello): Promise<{
  serverKeyPair: EcdhKeyPair;
  peerPublicKey: CryptoKey;
  serverHello: ServerHello;
  keyId: string;
}> {
  // Generate server's ephemeral key pair
  const serverKeyPair = await generateKeyPair(clientHello.curve);

  // Import client's public key
  const peerPublicKey = await importPublicKey(clientHello.clientEphemeralPubKeyB64, clientHello.curve);

  // Generate a key ID
  const keyId = `k_${crypto.randomUUID()}`;

  // Create server hello
  const serverHello = await createServerHello(serverKeyPair, keyId);

  return {
    serverKeyPair,
    peerPublicKey,
    serverHello,
    keyId,
  };
}

/**
 * Process a server hello and extract peer's public key.
 */
export async function processServerHello(serverHello: ServerHello): Promise<{
  peerPublicKey: CryptoKey;
  keyId: string;
}> {
  const peerPublicKey = await importPublicKey(serverHello.serverEphemeralPubKeyB64, serverHello.curve);

  return {
    peerPublicKey,
    keyId: serverHello.keyId,
  };
}
