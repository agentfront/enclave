import { EventType, PROTOCOL_VERSION } from '@enclave-vm/types';
import {
  AesGcmError,
  SessionEncryptionContext,
  createEncryptedEnvelope,
  decryptJson,
  encodeEnvelopeHeader,
  encryptJson,
  fromBase64,
  importAesGcmKey,
  openEncryptedEnvelope,
  toBase64,
} from './index';

describe('encrypted envelopes', () => {
  const sessionId = 's_test123' as `s_${string}`;
  const event = { type: 'stdout', payload: { chunk: 'hello' } };

  async function makeKey() {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    return { keyBytes, key: await importAesGcmKey(keyBytes) };
  }

  it('should create an envelope and open it again', async () => {
    const { key } = await makeKey();

    const envelope = await createEncryptedEnvelope(key, 'k_1', sessionId, 3, event);

    expect(envelope.type).toBe(EventType.Encrypted);
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.seq).toBe(3);
    expect(envelope.payload.kid).toBe('k_1');
    expect(await openEncryptedEnvelope(key, envelope)).toEqual(event);
  });

  it('should open envelopes of a session context with openEnvelope', async () => {
    const { keyBytes } = await makeKey();
    const sender = await SessionEncryptionContext.fromKeyBytes(keyBytes, 'k_1');
    const receiver = await SessionEncryptionContext.fromKeyBytes(keyBytes, 'k_1');

    const envelope = await sender.createEnvelope(sessionId, 1, event);

    expect(await receiver.openEnvelope(envelope)).toEqual(event);
    expect(sender.getNonceCounter()).toBe(1n);
  });

  it('should refuse an envelope whose header was changed', async () => {
    const { key } = await makeKey();
    const envelope = await createEncryptedEnvelope(key, 'k_1', sessionId, 3, event);

    await expect(openEncryptedEnvelope(key, { ...envelope, seq: 4 })).rejects.toBeInstanceOf(AesGcmError);
  });

  it('should pass additional authenticated data through encryptJson and decryptJson', async () => {
    const { key } = await makeKey();
    const aad = new TextEncoder().encode('context');

    const payload = await encryptJson(key, 'k_1', event, undefined, aad);

    expect(await decryptJson(key, payload, aad)).toEqual(event);
    await expect(decryptJson(key, payload)).rejects.toBeInstanceOf(AesGcmError);
  });

  it('should encode an envelope header without ambiguity', () => {
    const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

    expect(decode(encodeEnvelopeHeader({ protocolVersion: 2, sessionId: 's_a', seq: 7, kid: 'k_1' }))).toEqual([
      'enclavejs-envelope',
      2,
      's_a',
      7,
      'k_1',
    ]);
    expect(() => encodeEnvelopeHeader({ protocolVersion: 2, sessionId: 's_a', seq: -1, kid: 'k_1' })).toThrow(
      AesGcmError,
    );
  });

  it('should convert bytes to base64 and back', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i & 0xff);

    const encoded = toBase64(bytes);

    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(fromBase64(encoded).subarray(0, 4))).toEqual([0, 1, 2, 3]);
    expect(() => fromBase64('not base64!')).toThrow(AesGcmError);
  });
});
