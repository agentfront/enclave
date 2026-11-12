/**
 * WebSocket Channel
 *
 * WebSocket-based channel for remote runtime communication.
 *
 * The channel connects to a URL and nothing more: it sends no credentials, and it hands every
 * JSON message it receives to its handlers without checking the message against a schema.
 * Authenticate the connection in the URL's server and validate messages in the handler.
 *
 * @packageDocumentation
 */

import type { StreamEvent, RuntimeChannelMessage } from '@enclave-vm/types';
import { serializeEvent } from '@enclave-vm/stream';
import type { RuntimeChannel } from '../types';

/**
 * WebSocket channel configuration
 */
export interface WebSocketChannelConfig {
  /**
   * WebSocket URL to connect to
   */
  url: string;

  /**
   * Reconnection options
   */
  reconnect?: {
    enabled?: boolean;
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };

  /**
   * Connection timeout in milliseconds
   * @default 10000
   */
  connectionTimeoutMs?: number;

  /**
   * Events kept while the channel is not connected. Events sent beyond that are dropped
   * until the channel is connected again. A positive integer.
   * @default 1000
   */
  maxBufferedMessages?: number;

  /**
   * Debug mode
   */
  debug?: boolean;
}

/**
 * Default number of events kept while the channel is not connected
 */
const DEFAULT_MAX_BUFFERED_MESSAGES = 1000;

/**
 * Internal resolved configuration type
 */
interface ResolvedConfig {
  url: string;
  reconnect: {
    enabled: boolean;
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
  connectionTimeoutMs: number;
  maxBufferedMessages: number;
  debug: boolean;
}

/**
 * WebSocket channel state
 */
export type WebSocketChannelState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'closed';

/**
 * WebSocket channel implementation
 *
 * Provides a channel over WebSocket for remote runtime communication.
 */
export class WebSocketChannel implements RuntimeChannel {
  private readonly config: ResolvedConfig;
  private ws: WebSocket | null = null;
  private state: WebSocketChannelState = 'disconnected';
  private readonly messageHandlers: Set<(message: RuntimeChannelMessage) => void> = new Set();
  private retryCount = 0;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private messageBuffer: string[] = [];

  constructor(config: WebSocketChannelConfig) {
    const maxBufferedMessages = config.maxBufferedMessages ?? DEFAULT_MAX_BUFFERED_MESSAGES;
    if (
      typeof maxBufferedMessages !== 'number' ||
      !Number.isSafeInteger(maxBufferedMessages) ||
      maxBufferedMessages < 1
    ) {
      throw new RangeError('maxBufferedMessages must be a positive integer');
    }

    this.config = {
      url: config.url,
      reconnect: {
        enabled: config.reconnect?.enabled ?? true,
        maxRetries: config.reconnect?.maxRetries ?? 5,
        initialDelayMs: config.reconnect?.initialDelayMs ?? 1000,
        maxDelayMs: config.reconnect?.maxDelayMs ?? 30000,
      },
      connectionTimeoutMs: config.connectionTimeoutMs ?? 10000,
      maxBufferedMessages,
      debug: config.debug ?? false,
    };
  }

  /**
   * Whether the channel is open
   */
  get isOpen(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get current state
   */
  get channelState(): WebSocketChannelState {
    return this.state;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      this.log(`Connecting to ${this.config.url}`);

      // Create WebSocket (works in both browser and Node.js with ws package)
      const WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');

      const socket: WebSocket = new WebSocketImpl(this.config.url);
      this.ws = socket;

      const timeout = setTimeout(() => {
        if (this.state === 'connecting') {
          socket.close();
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectionTimeoutMs);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.state = 'connected';
        this.retryCount = 0;
        this.log('Connected');

        // Send buffered messages
        this.flushBuffer();

        resolve();
      };

      socket.onclose = (event: CloseEvent) => {
        clearTimeout(timeout);
        this.log(`Disconnected: ${event.code} ${event.reason}`);

        if (this.state !== 'closed') {
          this.state = 'disconnected';
          this.handleDisconnect();
        }
      };

      socket.onerror = (error: Event) => {
        clearTimeout(timeout);
        this.log(`Error: ${error}`);

        if (this.state === 'connecting') {
          reject(new Error('Connection failed'));
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };
    });
  }

  /**
   * Send a stream event
   */
  send(event: StreamEvent): void {
    const data = serializeEvent(event);

    if (this.isOpen && this.ws) {
      this.ws.send(data);
    } else if (this.messageBuffer.length < this.config.maxBufferedMessages) {
      // Buffer message for later
      this.messageBuffer.push(data);
    } else {
      // The buffer is bounded: what does not fit while disconnected is not kept
      this.log('Message buffer is full, dropping event');
    }
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
   * Close the channel
   */
  close(): void {
    this.state = 'closed';

    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Channel closed');
      this.ws = null;
    }

    this.messageHandlers.clear();
    this.messageBuffer = [];
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      // Parse JSON directly - messages can be raw JSON or stream events
      const message = JSON.parse(data) as RuntimeChannelMessage;

      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (error) {
          this.log(`Message handler error: ${error}`);
        }
      }
    } catch (error) {
      this.log(`Failed to parse message: ${error}`);
    }
  }

  /**
   * Handle disconnect
   */
  private handleDisconnect(): void {
    if (!this.config.reconnect.enabled) {
      return;
    }

    if (this.retryCount >= this.config.reconnect.maxRetries) {
      this.log('Max reconnection attempts reached');
      this.state = 'closed';
      return;
    }

    this.state = 'reconnecting';
    this.retryCount++;

    const delay = Math.min(
      this.config.reconnect.initialDelayMs * Math.pow(2, this.retryCount - 1),
      this.config.reconnect.maxDelayMs,
    );

    this.log(`Reconnecting in ${delay}ms (attempt ${this.retryCount})`);

    this.retryTimeout = setTimeout(() => {
      this.connect().catch((error) => {
        this.log(`Reconnection failed: ${error}`);
      });
    }, delay);
  }

  /**
   * Flush message buffer
   */
  private flushBuffer(): void {
    if (!this.isOpen || !this.ws) {
      return;
    }

    for (const data of this.messageBuffer) {
      this.ws.send(data);
    }
    this.messageBuffer = [];
  }

  /**
   * Log debug message
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[WebSocketChannel] ${message}`);
    }
  }
}

/**
 * Create a WebSocket channel
 */
export function createWebSocketChannel(config: WebSocketChannelConfig): WebSocketChannel {
  return new WebSocketChannel(config);
}
