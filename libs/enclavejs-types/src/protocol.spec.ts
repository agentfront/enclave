import {
  PROTOCOL_VERSION,
  SESSION_ID_PREFIX,
  CALL_ID_PREFIX,
  REF_ID_PREFIX,
  generateSessionId,
  generateCallId,
  generateRefId,
  isSessionId,
  isCallId,
  isRefId,
  isRefToken,
  createRefToken,
  DEFAULT_SESSION_LIMITS,
  SessionState,
} from './protocol';

describe('Protocol', () => {
  describe('Constants', () => {
    it('should have correct protocol version', () => {
      expect(PROTOCOL_VERSION).toBe(1);
    });

    it('should have correct ID prefixes', () => {
      expect(SESSION_ID_PREFIX).toBe('s_');
      expect(CALL_ID_PREFIX).toBe('c_');
      expect(REF_ID_PREFIX).toBe('ref_');
    });
  });

  describe('ID Generation', () => {
    it('should generate valid session IDs', () => {
      const id = generateSessionId();
      expect(id).toMatch(/^s_[0-9a-f-]+$/);
      expect(isSessionId(id)).toBe(true);
    });

    it('should generate valid call IDs', () => {
      const id = generateCallId();
      expect(id).toMatch(/^c_[0-9a-f-]+$/);
      expect(isCallId(id)).toBe(true);
    });

    it('should generate valid ref IDs', () => {
      const id = generateRefId();
      expect(id).toMatch(/^ref_[0-9a-f-]+$/);
      expect(isRefId(id)).toBe(true);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateSessionId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('ID Validation', () => {
    it('should validate session IDs correctly', () => {
      expect(isSessionId('s_abc123')).toBe(true);
      expect(isSessionId('c_abc123')).toBe(false);
      expect(isSessionId('abc123')).toBe(false);
      expect(isSessionId('')).toBe(false);
    });

    it('should validate call IDs correctly', () => {
      expect(isCallId('c_abc123')).toBe(true);
      expect(isCallId('s_abc123')).toBe(false);
      expect(isCallId('abc123')).toBe(false);
    });

    it('should validate ref IDs correctly', () => {
      expect(isRefId('ref_abc123')).toBe(true);
      expect(isRefId('s_abc123')).toBe(false);
      expect(isRefId('abc123')).toBe(false);
    });
  });

  describe('Reference Tokens', () => {
    it('should create valid ref tokens', () => {
      const token = createRefToken('ref_test123' as `ref_${string}`);
      expect(token).toEqual({ $ref: { id: 'ref_test123' } });
    });

    it('should validate ref tokens correctly', () => {
      expect(isRefToken({ $ref: { id: 'ref_test' } })).toBe(true);
      expect(isRefToken({ $ref: { id: 's_test' } })).toBe(false);
      expect(isRefToken({ id: 'ref_test' })).toBe(false);
      expect(isRefToken({ $ref: 'ref_test' })).toBe(false);
      expect(isRefToken(null)).toBe(false);
      expect(isRefToken(undefined)).toBe(false);
      expect(isRefToken('ref_test')).toBe(false);
    });
  });

  describe('Default Session Limits', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_SESSION_LIMITS.sessionTtlMs).toBe(60000);
      expect(DEFAULT_SESSION_LIMITS.maxToolCalls).toBe(50);
      expect(DEFAULT_SESSION_LIMITS.maxStdoutBytes).toBe(262144);
      expect(DEFAULT_SESSION_LIMITS.maxToolResultBytes).toBe(5242880);
      expect(DEFAULT_SESSION_LIMITS.toolTimeoutMs).toBe(30000);
      expect(DEFAULT_SESSION_LIMITS.heartbeatIntervalMs).toBe(15000);
    });
  });

  describe('SessionState', () => {
    it('should have all expected states', () => {
      expect(SessionState.Starting).toBe('starting');
      expect(SessionState.Running).toBe('running');
      expect(SessionState.WaitingForTool).toBe('waiting_for_tool');
      expect(SessionState.Completed).toBe('completed');
      expect(SessionState.Cancelled).toBe('cancelled');
      expect(SessionState.Failed).toBe('failed');
    });
  });
});
