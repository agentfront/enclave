import {
  ConnectionState,
  ReconnectionStateMachine,
  SequenceTracker,
  EventBuffer,
  HeartbeatMonitor,
  DEFAULT_RECONNECTION_CONFIG,
} from './reconnect';
import type { ReconnectionEvent } from './reconnect';

describe('Reconnection', () => {
  describe('ReconnectionStateMachine', () => {
    it('should start in disconnected state', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        onEvent: (e) => events.push(e),
      });
      expect(machine.getState()).toBe(ConnectionState.Disconnected);
    });

    it('should transition to connecting on connect()', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      expect(machine.getState()).toBe(ConnectionState.Connecting);
      expect(events).toContainEqual({
        type: 'state_change',
        state: ConnectionState.Connecting,
        previousState: ConnectionState.Disconnected,
      });
    });

    it('should transition to connected on onConnected()', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      machine.onConnected();
      expect(machine.getState()).toBe(ConnectionState.Connected);
      expect(events).toContainEqual({ type: 'connected' });
    });

    it('should schedule retry on disconnect', () => {
      jest.useFakeTimers();
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        config: { maxRetries: 3, initialDelayMs: 100 },
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      machine.onConnected();
      machine.onDisconnected('test');

      expect(machine.getState()).toBe(ConnectionState.Reconnecting);
      expect(events).toContainEqual({ type: 'disconnected', reason: 'test' });

      // Should schedule retry
      const retryEvent = events.find((e) => e.type === 'retry_scheduled');
      expect(retryEvent).toBeDefined();

      jest.useRealTimers();
    });

    it('should transition to failed after max retries', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        config: { maxRetries: 0 },
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      machine.onConnected();
      machine.onDisconnected();

      expect(machine.getState()).toBe(ConnectionState.Failed);
      expect(events.some((e) => e.type === 'failed')).toBe(true);
    });

    it('should transition to closed on close()', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      machine.onConnected();
      machine.close();

      expect(machine.getState()).toBe(ConnectionState.Closed);
    });

    it('should reset correctly', () => {
      const events: ReconnectionEvent[] = [];
      const machine = new ReconnectionStateMachine({
        onEvent: (e) => events.push(e),
      });

      machine.connect();
      machine.onConnected();
      machine.reset();

      expect(machine.getState()).toBe(ConnectionState.Disconnected);
      expect(machine.getRetryCount()).toBe(0);
    });
  });

  describe('SequenceTracker', () => {
    it('should track sequence numbers', () => {
      const tracker = new SequenceTracker();
      expect(tracker.getLastSeq()).toBe(0);

      tracker.receive(1);
      expect(tracker.getLastSeq()).toBe(1);

      tracker.receive(2);
      expect(tracker.getLastSeq()).toBe(2);
    });

    it('should detect gaps', () => {
      const tracker = new SequenceTracker();
      tracker.receive(1);

      const result = tracker.receive(5);
      expect(result.gap).toBe(true);
      expect(result.missingStart).toBe(2);
      expect(result.missingEnd).toBe(4);
    });

    it('should track gaps', () => {
      const tracker = new SequenceTracker();
      tracker.receive(1);
      tracker.receive(5);

      expect(tracker.hasGaps()).toBe(true);
      expect(tracker.getGaps()).toEqual([{ start: 2, end: 4 }]);
    });

    it('should clear gaps', () => {
      const tracker = new SequenceTracker();
      tracker.receive(1);
      tracker.receive(5);

      tracker.clearGap(2, 4);
      expect(tracker.hasGaps()).toBe(false);
    });

    it('should ignore duplicates', () => {
      const tracker = new SequenceTracker();
      tracker.receive(1);
      tracker.receive(2);

      const result = tracker.receive(1);
      expect(result.gap).toBe(false);
      expect(tracker.getLastSeq()).toBe(2);
    });

    it('should reset correctly', () => {
      const tracker = new SequenceTracker();
      tracker.receive(1);
      tracker.receive(5);

      tracker.reset();
      expect(tracker.getLastSeq()).toBe(0);
      expect(tracker.hasGaps()).toBe(false);
    });
  });

  describe('EventBuffer', () => {
    it('should buffer events', () => {
      const buffer = new EventBuffer(10);
      const event = { type: 'test' } as any;

      expect(buffer.add(event)).toBe(true);
      expect(buffer.size()).toBe(1);
      expect(buffer.getAll()).toContain(event);
    });

    it('should enforce max size', () => {
      const buffer = new EventBuffer(2);

      expect(buffer.add({ type: '1' } as any)).toBe(true);
      expect(buffer.add({ type: '2' } as any)).toBe(true);
      expect(buffer.add({ type: '3' } as any)).toBe(false);
      expect(buffer.size()).toBe(2);
    });

    it('should drain correctly', () => {
      const buffer = new EventBuffer(10);
      buffer.add({ type: '1' } as any);
      buffer.add({ type: '2' } as any);

      const events = buffer.drain();
      expect(events.length).toBe(2);
      expect(buffer.size()).toBe(0);
    });

    it('should clear correctly', () => {
      const buffer = new EventBuffer(10);
      buffer.add({ type: '1' } as any);

      buffer.clear();
      expect(buffer.size()).toBe(0);
    });
  });

  describe('HeartbeatMonitor', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should call onTimeout when heartbeat is missed', () => {
      const onTimeout = jest.fn();
      const monitor = new HeartbeatMonitor({
        timeoutMs: 1000,
        onTimeout,
      });

      monitor.start();
      jest.advanceTimersByTime(1500);

      expect(onTimeout).toHaveBeenCalled();
    });

    it('should not timeout if heartbeat is received', () => {
      const onTimeout = jest.fn();
      const monitor = new HeartbeatMonitor({
        timeoutMs: 1000,
        onTimeout,
      });

      monitor.start();
      jest.advanceTimersByTime(500);
      monitor.onHeartbeat();
      jest.advanceTimersByTime(500);
      monitor.onHeartbeat();
      jest.advanceTimersByTime(500);

      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('should stop correctly', () => {
      const onTimeout = jest.fn();
      const monitor = new HeartbeatMonitor({
        timeoutMs: 1000,
        onTimeout,
      });

      monitor.start();
      monitor.stop();
      jest.advanceTimersByTime(2000);

      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  describe('DEFAULT_RECONNECTION_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_RECONNECTION_CONFIG.maxRetries).toBe(5);
      expect(DEFAULT_RECONNECTION_CONFIG.initialDelayMs).toBe(1000);
      expect(DEFAULT_RECONNECTION_CONFIG.maxDelayMs).toBe(30000);
      expect(DEFAULT_RECONNECTION_CONFIG.backoffMultiplier).toBe(2);
      expect(DEFAULT_RECONNECTION_CONFIG.jitter).toBe(true);
    });
  });
});
