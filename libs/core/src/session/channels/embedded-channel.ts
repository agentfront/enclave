/**
 * Embedded Runtime Channel
 *
 * In-process runtime channel for embedded execution where the Enclave
 * runs in the same process as the broker.
 *
 * @packageDocumentation
 */

import type { StreamEvent, RuntimeChannelMessage } from '@enclave-vm/types';
import type { RuntimeChannel } from '../../session-types';

/**
 * Embedded channel configuration
 */
export interface EmbeddedChannelOptions {
  /**
   * Handler for outgoing stream events
   */
  onEvent?: (event: StreamEvent) => void;

  /**
   * Handler for incoming runtime messages
   */
  onMessage?: (message: RuntimeChannelMessage) => void;
}

/**
 * Embedded Runtime Channel
 *
 * Provides in-memory communication for embedded runtime execution.
 * Messages are delivered synchronously without network overhead.
 */
export class EmbeddedChannel implements RuntimeChannel {
  private _isOpen = true;
  private readonly eventHandlers: Set<(event: StreamEvent) => void>;
  private readonly messageHandlers: Set<(message: RuntimeChannelMessage) => void>;

  constructor(options: EmbeddedChannelOptions = {}) {
    this.eventHandlers = new Set();
    this.messageHandlers = new Set();

    if (options.onEvent) {
      this.eventHandlers.add(options.onEvent);
    }
    if (options.onMessage) {
      this.messageHandlers.add(options.onMessage);
    }
  }

  /**
   * Whether the channel is open
   */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Send a message to the runtime
   * (In embedded mode, this delivers to message handlers)
   */
  send(message: RuntimeChannelMessage): void {
    if (!this._isOpen) {
      throw new Error('Channel is closed');
    }

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Emit an event from the runtime to the broker
   * (Called by the embedded runtime to send events)
   */
  emit(event: StreamEvent): void {
    if (!this._isOpen) {
      return; // Silently ignore if closed
    }

    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Subscribe to stream events from the runtime
   */
  onMessage(handler: (event: StreamEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to runtime channel messages
   * (Used by the runtime to receive tool results and cancel requests)
   */
  onRuntimeMessage(handler: (message: RuntimeChannelMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Close the channel
   */
  close(): void {
    this._isOpen = false;
    this.eventHandlers.clear();
    this.messageHandlers.clear();
  }
}

/**
 * Create an embedded channel pair for bidirectional communication
 *
 * Returns a broker-side and runtime-side interface to the same channel.
 */
export function createEmbeddedChannelPair(): {
  brokerChannel: RuntimeChannel;
  runtimeChannel: {
    emit: (event: StreamEvent) => void;
    onMessage: (handler: (message: RuntimeChannelMessage) => void) => () => void;
    close: () => void;
    readonly isOpen: boolean;
  };
} {
  const channel = new EmbeddedChannel();

  return {
    // Broker-side interface (sends messages, receives events)
    brokerChannel: {
      send: (message) => channel.send(message),
      onMessage: (handler) => channel.onMessage(handler),
      close: () => channel.close(),
      get isOpen() {
        return channel.isOpen;
      },
    },
    // Runtime-side interface (sends events, receives messages)
    runtimeChannel: {
      emit: (event) => channel.emit(event),
      onMessage: (handler) => channel.onRuntimeMessage(handler),
      close: () => channel.close(),
      get isOpen() {
        return channel.isOpen;
      },
    },
  };
}
