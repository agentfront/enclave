/**
 * @enclave-vm/stream - Reconnection State Machine
 *
 * Handles connection drops and automatic reconnection with exponential backoff.
 */

import type { StreamEvent, EncryptedEnvelope } from '@enclave-vm/types';

/**
 * Connection state.
 */
export const ConnectionState = {
  /** Not connected */
  Disconnected: 'disconnected',
  /** Attempting to connect */
  Connecting: 'connecting',
  /** Successfully connected */
  Connected: 'connected',
  /** Connection lost, will attempt reconnection */
  Reconnecting: 'reconnecting',
  /** Permanently failed (max retries exceeded or fatal error) */
  Failed: 'failed',
  /** Intentionally closed */
  Closed: 'closed',
} as const;

export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/**
 * Reconnection configuration.
 */
export interface ReconnectionConfig {
  /** Maximum number of reconnection attempts (default: 5) */
  maxRetries: number;
  /** Initial backoff delay in milliseconds (default: 1000) */
  initialDelayMs: number;
  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Add random jitter to backoff (default: true) */
  jitter: boolean;
  /** Jitter factor (0-1, default: 0.3) */
  jitterFactor: number;
}

/**
 * Default reconnection configuration.
 */
export const DEFAULT_RECONNECTION_CONFIG: ReconnectionConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  jitterFactor: 0.3,
};

/**
 * Event emitted by the reconnection state machine.
 */
export type ReconnectionEvent =
  | { type: 'state_change'; state: ConnectionState; previousState: ConnectionState }
  | { type: 'retry_scheduled'; attempt: number; delayMs: number }
  | { type: 'retry_started'; attempt: number }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'failed'; reason: string };

/**
 * Reconnection state machine.
 * Manages connection state and handles automatic reconnection.
 */
export class ReconnectionStateMachine {
  private state: ConnectionState = ConnectionState.Disconnected;
  private retryCount = 0;
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly config: ReconnectionConfig;
  private readonly onEvent: (event: ReconnectionEvent) => void;

  constructor(options: { config?: Partial<ReconnectionConfig>; onEvent: (event: ReconnectionEvent) => void }) {
    this.config = { ...DEFAULT_RECONNECTION_CONFIG, ...options.config };
    this.onEvent = options.onEvent;
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get current retry count.
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Transition to a new state.
   */
  private transition(newState: ConnectionState): void {
    const previousState = this.state;
    if (previousState === newState) return;

    this.state = newState;
    this.onEvent({ type: 'state_change', state: newState, previousState });
  }

  /**
   * Calculate backoff delay with optional jitter.
   */
  private calculateBackoff(): number {
    const { initialDelayMs, maxDelayMs, backoffMultiplier, jitter, jitterFactor } = this.config;

    // Exponential backoff
    let delay = initialDelayMs * Math.pow(backoffMultiplier, this.retryCount);
    delay = Math.min(delay, maxDelayMs);

    // Add jitter
    if (jitter) {
      const jitterAmount = delay * jitterFactor;
      delay = delay - jitterAmount + Math.random() * jitterAmount * 2;
    }

    return Math.round(delay);
  }

  /**
   * Start connecting.
   */
  connect(): void {
    if (this.state === ConnectionState.Connected || this.state === ConnectionState.Connecting) {
      return;
    }

    this.cancelRetry();
    this.retryCount = 0;
    this.transition(ConnectionState.Connecting);
  }

  /**
   * Called when connection succeeds.
   */
  onConnected(): void {
    this.cancelRetry();
    this.retryCount = 0;
    this.transition(ConnectionState.Connected);
    this.onEvent({ type: 'connected' });
  }

  /**
   * Called when connection is lost.
   */
  onDisconnected(reason?: string): void {
    this.cancelRetry();

    // If already closed or failed, don't change state
    if (this.state === ConnectionState.Closed || this.state === ConnectionState.Failed) {
      return;
    }

    this.onEvent({ type: 'disconnected', reason });

    // Check if we should attempt reconnection
    if (this.retryCount < this.config.maxRetries) {
      this.scheduleRetry();
    } else {
      this.transition(ConnectionState.Failed);
      this.onEvent({ type: 'failed', reason: reason ?? 'Max retries exceeded' });
    }
  }

  /**
   * Called when connection fails with a fatal error.
   */
  onFatalError(reason: string): void {
    this.cancelRetry();
    this.transition(ConnectionState.Failed);
    this.onEvent({ type: 'failed', reason });
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleRetry(): void {
    this.transition(ConnectionState.Reconnecting);

    const delayMs = this.calculateBackoff();
    const attempt = this.retryCount + 1;

    this.onEvent({ type: 'retry_scheduled', attempt, delayMs });

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null;
      this.retryCount++;
      this.onEvent({ type: 'retry_started', attempt });
      this.transition(ConnectionState.Connecting);
    }, delayMs);
  }

  /**
   * Cancel any pending retry.
   */
  private cancelRetry(): void {
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  }

  /**
   * Intentionally close the connection.
   */
  close(): void {
    this.cancelRetry();
    this.transition(ConnectionState.Closed);
  }

  /**
   * Reset to initial state.
   */
  reset(): void {
    this.cancelRetry();
    this.retryCount = 0;
    this.transition(ConnectionState.Disconnected);
  }

  /**
   * Check if reconnection is possible.
   */
  canReconnect(): boolean {
    return (
      this.state !== ConnectionState.Failed &&
      this.state !== ConnectionState.Closed &&
      this.retryCount < this.config.maxRetries
    );
  }
}

/**
 * Sequence tracker for detecting gaps and enabling replay.
 */
export class SequenceTracker {
  private lastSeq = 0;
  private readonly gaps: Array<{ start: number; end: number }> = [];
  private readonly maxGaps: number;

  constructor(maxGaps = 100) {
    this.maxGaps = maxGaps;
  }

  /**
   * Process a received sequence number.
   * Returns any gaps detected.
   */
  receive(seq: number): { gap: boolean; missingStart?: number; missingEnd?: number } {
    // First event
    if (this.lastSeq === 0) {
      this.lastSeq = seq;
      return { gap: false };
    }

    // Expected sequence
    if (seq === this.lastSeq + 1) {
      this.lastSeq = seq;
      return { gap: false };
    }

    // Duplicate or old event
    if (seq <= this.lastSeq) {
      return { gap: false };
    }

    // Gap detected
    const missingStart = this.lastSeq + 1;
    const missingEnd = seq - 1;

    // Track gap (for replay)
    if (this.gaps.length < this.maxGaps) {
      this.gaps.push({ start: missingStart, end: missingEnd });
    }

    this.lastSeq = seq;
    return { gap: true, missingStart, missingEnd };
  }

  /**
   * Get the last received sequence number.
   */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /**
   * Get all detected gaps.
   */
  getGaps(): Array<{ start: number; end: number }> {
    return [...this.gaps];
  }

  /**
   * Clear a gap after it's been filled.
   */
  clearGap(start: number, end: number): void {
    const index = this.gaps.findIndex((g) => g.start === start && g.end === end);
    if (index !== -1) {
      this.gaps.splice(index, 1);
    }
  }

  /**
   * Check if there are pending gaps.
   */
  hasGaps(): boolean {
    return this.gaps.length > 0;
  }

  /**
   * Reset the tracker.
   */
  reset(): void {
    this.lastSeq = 0;
    this.gaps.length = 0;
  }
}

/**
 * Event buffer for storing events during reconnection.
 */
export class EventBuffer {
  private readonly buffer: (StreamEvent | EncryptedEnvelope)[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Add an event to the buffer.
   */
  add(event: StreamEvent | EncryptedEnvelope): boolean {
    if (this.buffer.length >= this.maxSize) {
      return false; // Buffer full
    }
    this.buffer.push(event);
    return true;
  }

  /**
   * Get all buffered events.
   */
  getAll(): (StreamEvent | EncryptedEnvelope)[] {
    return [...this.buffer];
  }

  /**
   * Drain the buffer (get all events and clear).
   */
  drain(): (StreamEvent | EncryptedEnvelope)[] {
    const events = [...this.buffer];
    this.buffer.length = 0;
    return events;
  }

  /**
   * Get buffer size.
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Check if buffer is full.
   */
  isFull(): boolean {
    return this.buffer.length >= this.maxSize;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * Heartbeat monitor for detecting stale connections.
 */
export class HeartbeatMonitor {
  private lastHeartbeat = Date.now();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly onTimeout: () => void;

  constructor(options: { timeoutMs: number; onTimeout: () => void }) {
    this.timeoutMs = options.timeoutMs;
    this.onTimeout = options.onTimeout;
  }

  /**
   * Start monitoring.
   */
  start(): void {
    this.lastHeartbeat = Date.now();
    this.scheduleCheck();
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Reset the heartbeat timer.
   */
  reset(): void {
    this.lastHeartbeat = Date.now();
  }

  /**
   * Called when a heartbeat is received.
   */
  onHeartbeat(): void {
    this.lastHeartbeat = Date.now();
  }

  /**
   * Get time since last heartbeat in milliseconds.
   */
  getTimeSinceLastHeartbeat(): number {
    return Date.now() - this.lastHeartbeat;
  }

  private scheduleCheck(): void {
    this.timeoutId = setTimeout(() => {
      const elapsed = Date.now() - this.lastHeartbeat;
      if (elapsed >= this.timeoutMs) {
        this.onTimeout();
      } else {
        // Schedule next check
        this.scheduleCheck();
      }
    }, this.timeoutMs);
  }
}
