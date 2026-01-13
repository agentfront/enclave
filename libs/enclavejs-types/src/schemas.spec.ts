import {
  parseStreamEvent,
  parseEncryptedEnvelope,
  parseCreateSessionRequest,
  SessionIdSchema,
  CallIdSchema,
  RefIdSchema,
  StreamEventSchema,
} from './schemas';
import { PROTOCOL_VERSION } from './protocol';

describe('Schemas', () => {
  describe('ID Schemas', () => {
    it('should validate session IDs', () => {
      expect(SessionIdSchema.safeParse('s_abc123').success).toBe(true);
      expect(SessionIdSchema.safeParse('c_abc123').success).toBe(false);
      expect(SessionIdSchema.safeParse('s_').success).toBe(false);
      expect(SessionIdSchema.safeParse('').success).toBe(false);
    });

    it('should validate call IDs', () => {
      expect(CallIdSchema.safeParse('c_abc123').success).toBe(true);
      expect(CallIdSchema.safeParse('s_abc123').success).toBe(false);
      expect(CallIdSchema.safeParse('c_').success).toBe(false);
    });

    it('should validate ref IDs', () => {
      expect(RefIdSchema.safeParse('ref_abc123').success).toBe(true);
      expect(RefIdSchema.safeParse('s_abc123').success).toBe(false);
      expect(RefIdSchema.safeParse('ref_').success).toBe(false);
    });
  });

  describe('parseStreamEvent', () => {
    it('should parse valid session_init event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 1,
        type: 'session_init',
        payload: {
          cancelUrl: '/sessions/s_test123/cancel',
          expiresAt: '2024-01-01T00:00:00.000Z',
          encryption: { enabled: false },
        },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should parse valid stdout event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 2,
        type: 'stdout',
        payload: { chunk: 'Hello, world!' },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should parse valid log event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 3,
        type: 'log',
        payload: { level: 'info', message: 'Test message' },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should parse valid tool_call event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 4,
        type: 'tool_call',
        payload: {
          callId: 'c_call123',
          toolName: 'get_data',
          args: { key: 'value' },
        },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should parse valid final event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 5,
        type: 'final',
        payload: { ok: true, result: { data: 'success' } },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should parse valid heartbeat event', () => {
      const event = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 6,
        type: 'heartbeat',
        payload: { ts: '2024-01-01T00:00:00.000Z' },
      };
      const result = parseStreamEvent(event);
      expect(result.success).toBe(true);
    });

    it('should reject invalid events', () => {
      expect(parseStreamEvent({ type: 'invalid' }).success).toBe(false);
      expect(parseStreamEvent({ protocolVersion: 2 }).success).toBe(false);
      expect(parseStreamEvent(null).success).toBe(false);
      expect(parseStreamEvent('string').success).toBe(false);
    });
  });

  describe('parseEncryptedEnvelope', () => {
    it('should parse valid encrypted envelope', () => {
      const envelope = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123',
        seq: 1,
        type: 'enc',
        payload: {
          kid: 'k_key123',
          nonceB64: 'dGVzdG5vbmNl',
          ciphertextB64: 'dGVzdGNpcGhlcnRleHQ=',
        },
      };
      const result = parseEncryptedEnvelope(envelope);
      expect(result.success).toBe(true);
    });

    it('should reject invalid encrypted envelopes', () => {
      expect(
        parseEncryptedEnvelope({
          type: 'enc',
          payload: { kid: 'k_1' },
        }).success,
      ).toBe(false);
    });
  });

  describe('parseCreateSessionRequest', () => {
    it('should parse valid session creation request', () => {
      const request = {
        protocolVersion: PROTOCOL_VERSION,
        code: 'const x = await callTool("test", {});',
        limits: {
          sessionTtlMs: 30000,
          maxToolCalls: 10,
        },
      };
      const result = parseCreateSessionRequest(request);
      expect(result.success).toBe(true);
    });

    it('should parse minimal session creation request', () => {
      const request = {
        protocolVersion: PROTOCOL_VERSION,
        code: 'return 42;',
      };
      const result = parseCreateSessionRequest(request);
      expect(result.success).toBe(true);
    });

    it('should reject invalid session creation requests', () => {
      expect(parseCreateSessionRequest({ code: '' }).success).toBe(false);
      expect(parseCreateSessionRequest({ protocolVersion: 2, code: 'test' }).success).toBe(false);
    });
  });
});
