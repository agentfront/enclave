/**
 * In-Memory Channel
 *
 * Simple in-process channel for testing and embedded use.
 *
 * @packageDocumentation
 */

import type { StreamEvent, RuntimeChannelMessage } from '@enclavejs/types';
import type { RuntimeChannel } from '../types';

/**
 * In-memory channel implementation
 *
 * Provides a simple channel that stores events in memory.
 * Useful for testing and embedded runtime scenarios.
 */
export class MemoryChannel implements RuntimeChannel {
  private readonly eventQueue: StreamEvent[] = [];
  private readonly messageHandlers: Set<(message: RuntimeChannelMessage) => void> = new Set();
  private _isOpen = true;

  /**
   * Whether the channel is open
   */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Send a stream event
   */
  send(event: StreamEvent): void {
    if (!this._isOpen) {
      throw new Error('Channel is closed');
    }
    this.eventQueue.push(event);
  }

  /**
   * Get all queued events
   */
  getEvents(): StreamEvent[] {
    return [...this.eventQueue];
  }

  /**
   * Clear the event queue
   */
  clearEvents(): void {
    this.eventQueue.length = 0;
  }

  /**
   * Receive messages
   */
  onMessage(handler: (message: RuntimeChannelMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Inject a message (simulate incoming message)
   */
  injectMessage(message: RuntimeChannelMessage): void {
    if (!this._isOpen) {
      throw new Error('Channel is closed');
    }
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  /**
   * Close the channel
   */
  close(): void {
    this._isOpen = false;
    this.messageHandlers.clear();
  }
}

/**
 * Create a memory channel
 */
export function createMemoryChannel(): MemoryChannel {
  return new MemoryChannel();
}

/**
 * Create a pair of connected memory channels
 *
 * Messages sent to one channel are received by the other.
 * Useful for simulating bidirectional communication.
 */
export function createMemoryChannelPair(): {
  client: MemoryChannel;
  server: MemoryChannel;
} {
  const client = new MemoryChannel();
  const server = new MemoryChannel();

  // Connect them bidirectionally
  // When client sends, server receives
  const originalClientSend = client.send.bind(client);
  client.send = (event: StreamEvent) => {
    originalClientSend(event);
    // Forward to server's message handlers
    server.injectMessage(event as unknown as RuntimeChannelMessage);
  };

  // When server sends, client receives
  const originalServerSend = server.send.bind(server);
  server.send = (event: StreamEvent) => {
    originalServerSend(event);
    // Forward to client's message handlers
    client.injectMessage(event as unknown as RuntimeChannelMessage);
  };

  return { client, server };
}
