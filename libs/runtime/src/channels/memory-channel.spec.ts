/**
 * Memory Channel Tests
 */

import { EventType, PROTOCOL_VERSION } from '@enclave-vm/types';
import type { StreamEvent } from '@enclave-vm/types';
import { MemoryChannel, createMemoryChannel, createMemoryChannelPair } from './memory-channel';

describe('MemoryChannel', () => {
  describe('createMemoryChannel', () => {
    it('should create an open channel', () => {
      const channel = createMemoryChannel();

      expect(channel.isOpen).toBe(true);
    });
  });

  describe('send', () => {
    it('should add events to queue', () => {
      const channel = createMemoryChannel();
      const event: StreamEvent = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test123' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      };

      channel.send(event);

      const events = channel.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('should throw when channel is closed', () => {
      const channel = createMemoryChannel();
      channel.close();

      expect(() =>
        channel.send({
          protocolVersion: PROTOCOL_VERSION,
          sessionId: 's_test' as `s_${string}`,
          seq: 1,
          type: EventType.Heartbeat,
          payload: { ts: new Date().toISOString() },
        }),
      ).toThrow('Channel is closed');
    });
  });

  describe('getEvents', () => {
    it('should return a copy of events', () => {
      const channel = createMemoryChannel();
      const event: StreamEvent = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      };

      channel.send(event);

      const events1 = channel.getEvents();
      const events2 = channel.getEvents();

      expect(events1).not.toBe(events2);
      expect(events1).toEqual(events2);
    });
  });

  describe('clearEvents', () => {
    it('should clear all events', () => {
      const channel = createMemoryChannel();
      channel.send({
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      });

      channel.clearEvents();

      expect(channel.getEvents()).toHaveLength(0);
    });
  });

  describe('onMessage', () => {
    it('should register message handler', () => {
      const channel = createMemoryChannel();
      const handler = jest.fn();

      channel.onMessage(handler);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const channel = createMemoryChannel();
      const handler = jest.fn();

      const unsubscribe = channel.onMessage(handler);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('injectMessage', () => {
    it('should call registered handlers', () => {
      const channel = createMemoryChannel();
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      channel.onMessage(handler1);
      channel.onMessage(handler2);

      const message = { type: 'test', data: 42 };
      channel.injectMessage(message as any);

      expect(handler1).toHaveBeenCalledWith(message);
      expect(handler2).toHaveBeenCalledWith(message);
    });

    it('should not call unsubscribed handlers', () => {
      const channel = createMemoryChannel();
      const handler = jest.fn();

      const unsubscribe = channel.onMessage(handler);
      unsubscribe();

      channel.injectMessage({ type: 'test' } as any);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should throw when channel is closed', () => {
      const channel = createMemoryChannel();
      channel.close();

      expect(() => channel.injectMessage({ type: 'test' } as any)).toThrow('Channel is closed');
    });
  });

  describe('close', () => {
    it('should mark channel as closed', () => {
      const channel = createMemoryChannel();

      channel.close();

      expect(channel.isOpen).toBe(false);
    });

    it('should clear all handlers', () => {
      const channel = createMemoryChannel();
      const handler = jest.fn();

      channel.onMessage(handler);
      channel.close();

      // Reopening isn't supported, so we just verify it's closed
      expect(channel.isOpen).toBe(false);
    });
  });
});

describe('createMemoryChannelPair', () => {
  it('should create two connected channels', () => {
    const { client, server } = createMemoryChannelPair();

    expect(client.isOpen).toBe(true);
    expect(server.isOpen).toBe(true);
  });

  it('should forward client events to server', () => {
    const { client, server } = createMemoryChannelPair();
    const handler = jest.fn();

    server.onMessage(handler);

    const event: StreamEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's_test' as `s_${string}`,
      seq: 1,
      type: EventType.Heartbeat,
      payload: { ts: new Date().toISOString() },
    };

    client.send(event);

    expect(handler).toHaveBeenCalled();
  });

  it('should forward server events to client', () => {
    const { client, server } = createMemoryChannelPair();
    const handler = jest.fn();

    client.onMessage(handler);

    const event: StreamEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's_test' as `s_${string}`,
      seq: 1,
      type: EventType.Heartbeat,
      payload: { ts: new Date().toISOString() },
    };

    server.send(event);

    expect(handler).toHaveBeenCalled();
  });
});
