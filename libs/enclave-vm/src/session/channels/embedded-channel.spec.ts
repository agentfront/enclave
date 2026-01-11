import type { StreamEvent, RuntimeChannelMessage } from '@enclavejs/types';
import { EventType, PROTOCOL_VERSION, RuntimeChannelMessageType } from '@enclavejs/types';
import { EmbeddedChannel, createEmbeddedChannelPair } from './embedded-channel';

describe('EmbeddedChannel', () => {
  const sessionId = 's_test' as `s_${string}`;

  const createTestEvent = (seq: number): StreamEvent => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq,
    type: EventType.Stdout,
    payload: { chunk: `test ${seq}` },
  });

  const createTestMessage = (): RuntimeChannelMessage => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    type: RuntimeChannelMessageType.ToolResultSubmit,
    payload: {
      callId: 'c_test' as `c_${string}`,
      ok: true,
      result: { data: 'done' },
    },
  });

  describe('EmbeddedChannel', () => {
    it('should start open', () => {
      const channel = new EmbeddedChannel();
      expect(channel.isOpen).toBe(true);
    });

    it('should emit events to handlers', () => {
      const events: StreamEvent[] = [];
      const channel = new EmbeddedChannel({
        onEvent: (e) => events.push(e),
      });

      const event = createTestEvent(1);
      channel.emit(event);

      expect(events.length).toBe(1);
      expect(events[0]).toEqual(event);
    });

    it('should send messages to handlers', () => {
      const messages: RuntimeChannelMessage[] = [];
      const channel = new EmbeddedChannel({
        onMessage: (m) => messages.push(m),
      });

      const message = createTestMessage();
      channel.send(message);

      expect(messages.length).toBe(1);
      expect(messages[0]).toEqual(message);
    });

    it('should allow subscribing to events after construction', () => {
      const channel = new EmbeddedChannel();
      const events: StreamEvent[] = [];

      channel.onMessage((e) => events.push(e));

      const event = createTestEvent(1);
      channel.emit(event);

      expect(events.length).toBe(1);
    });

    it('should allow subscribing to messages after construction', () => {
      const channel = new EmbeddedChannel();
      const messages: RuntimeChannelMessage[] = [];

      channel.onRuntimeMessage((m) => messages.push(m));

      const message = createTestMessage();
      channel.send(message);

      expect(messages.length).toBe(1);
    });

    it('should allow unsubscribing from events', () => {
      const channel = new EmbeddedChannel();
      const events: StreamEvent[] = [];

      const unsubscribe = channel.onMessage((e) => events.push(e));
      unsubscribe();

      channel.emit(createTestEvent(1));

      expect(events.length).toBe(0);
    });

    it('should allow unsubscribing from messages', () => {
      const channel = new EmbeddedChannel();
      const messages: RuntimeChannelMessage[] = [];

      const unsubscribe = channel.onRuntimeMessage((m) => messages.push(m));
      unsubscribe();

      channel.send(createTestMessage());

      expect(messages.length).toBe(0);
    });

    it('should close correctly', () => {
      const channel = new EmbeddedChannel();
      channel.close();

      expect(channel.isOpen).toBe(false);
    });

    it('should throw when sending to closed channel', () => {
      const channel = new EmbeddedChannel();
      channel.close();

      expect(() => channel.send(createTestMessage())).toThrow('Channel is closed');
    });

    it('should silently ignore emits to closed channel', () => {
      const events: StreamEvent[] = [];
      const channel = new EmbeddedChannel({
        onEvent: (e) => events.push(e),
      });

      channel.close();
      channel.emit(createTestEvent(1)); // Should not throw

      expect(events.length).toBe(0);
    });

    it('should support multiple handlers', () => {
      const channel = new EmbeddedChannel();
      const events1: StreamEvent[] = [];
      const events2: StreamEvent[] = [];

      channel.onMessage((e) => events1.push(e));
      channel.onMessage((e) => events2.push(e));

      channel.emit(createTestEvent(1));

      expect(events1.length).toBe(1);
      expect(events2.length).toBe(1);
    });

    it('should continue on handler errors', () => {
      const channel = new EmbeddedChannel();
      const events: StreamEvent[] = [];

      channel.onMessage(() => {
        throw new Error('Handler error');
      });
      channel.onMessage((e) => events.push(e));

      channel.emit(createTestEvent(1));

      expect(events.length).toBe(1);
    });
  });

  describe('createEmbeddedChannelPair', () => {
    it('should create connected broker and runtime channels', () => {
      const { brokerChannel, runtimeChannel } = createEmbeddedChannelPair();

      expect(brokerChannel.isOpen).toBe(true);
      expect(runtimeChannel.isOpen).toBe(true);
    });

    it('should deliver events from runtime to broker', () => {
      const { brokerChannel, runtimeChannel } = createEmbeddedChannelPair();
      const events: StreamEvent[] = [];

      brokerChannel.onMessage((e) => events.push(e));

      const event = createTestEvent(1);
      runtimeChannel.emit(event);

      expect(events.length).toBe(1);
      expect(events[0]).toEqual(event);
    });

    it('should deliver messages from broker to runtime', () => {
      const { brokerChannel, runtimeChannel } = createEmbeddedChannelPair();
      const messages: RuntimeChannelMessage[] = [];

      runtimeChannel.onMessage((m) => messages.push(m));

      const message = createTestMessage();
      brokerChannel.send(message);

      expect(messages.length).toBe(1);
      expect(messages[0]).toEqual(message);
    });

    it('should close both sides together', () => {
      const { brokerChannel, runtimeChannel } = createEmbeddedChannelPair();

      brokerChannel.close();

      expect(brokerChannel.isOpen).toBe(false);
      expect(runtimeChannel.isOpen).toBe(false);
    });

    it('should support bidirectional communication', () => {
      const { brokerChannel, runtimeChannel } = createEmbeddedChannelPair();
      const events: StreamEvent[] = [];
      const messages: RuntimeChannelMessage[] = [];

      // Broker listens for events
      brokerChannel.onMessage((e) => events.push(e));

      // Runtime listens for messages
      runtimeChannel.onMessage((m) => messages.push(m));

      // Runtime sends event
      runtimeChannel.emit(createTestEvent(1));
      expect(events.length).toBe(1);

      // Broker sends message
      brokerChannel.send(createTestMessage());
      expect(messages.length).toBe(1);
    });
  });
});
