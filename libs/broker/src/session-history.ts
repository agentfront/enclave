/**
 * Session history
 *
 * The events a session keeps so that a client can replay what it missed. The history is the
 * end of the session's event sequence, bounded in number and in size: when a bound is reached,
 * the oldest events are dropped, and a replay can only start at an event that is still kept.
 *
 * @packageDocumentation
 */

import type { StreamEvent } from '@enclave-vm/types';
import { SessionEmitter } from '@enclave-vm/core';
import type { SessionEmitterConfig } from '@enclave-vm/core';

/**
 * Bounds of the events a session keeps for a replay.
 */
export interface SessionHistoryLimits {
  /**
   * Maximum number of kept events.
   * @default 10000
   */
  maxEvents?: number;

  /**
   * Maximum size of the kept events together, measured as serialized JSON.
   * @default 4194304 (4MB)
   */
  maxBytes?: number;
}

/**
 * Default bounds of a session's history.
 */
export const DEFAULT_SESSION_HISTORY_LIMITS: Required<SessionHistoryLimits> = {
  maxEvents: 10_000,
  maxBytes: 4 * 1024 * 1024,
};

/**
 * What an event counts for when its size cannot be measured.
 */
const UNMEASURED_EVENT_BYTES = 1024;

/**
 * The complete history bounds: the given fields over the defaults.
 *
 * @throws TypeError when a bound is not a non-negative number
 */
export function resolveHistoryLimits(limits?: SessionHistoryLimits): Required<SessionHistoryLimits> {
  const resolved = { ...DEFAULT_SESSION_HISTORY_LIMITS };
  if (limits === undefined || limits === null) return resolved;
  if (typeof limits !== 'object') {
    throw new TypeError('Session history limits must be an object');
  }
  for (const key of ['maxEvents', 'maxBytes'] as const) {
    const value: unknown = limits[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new TypeError(`Session history limit "${key}" must be a non-negative number`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * A session emitter whose history is bounded.
 */
export class BoundedSessionEmitter extends SessionEmitter {
  private readonly limits: Required<SessionHistoryLimits>;
  private kept: Array<{ event: StreamEvent; size: number }> = [];
  private keptBytes = 0;
  private droppedThrough = 0;

  /**
   * Size of the event that is emitted next, when the caller knows it already. Used once.
   */
  nextEventSize?: number;

  constructor(config: SessionEmitterConfig, limits?: SessionHistoryLimits) {
    super(config);
    this.limits = resolveHistoryLimits(limits);
  }

  /**
   * Emit a stream event: keep it within the bounds, then hand it to the listeners.
   */
  override emit(event: StreamEvent): void {
    this.keep(event);
    try {
      super.emit(event);
    } finally {
      // The history is the one kept here.
      super.clearHistory();
    }
  }

  /**
   * The kept events, oldest first.
   */
  override getEmittedEvents(): StreamEvent[] {
    return this.kept.map((entry) => entry.event);
  }

  /**
   * Drop every kept event.
   */
  override clearHistory(): void {
    super.clearHistory();
    const last = this.kept[this.kept.length - 1];
    if (last) {
      this.droppedThrough = Math.max(this.droppedThrough, last.event.seq);
    }
    this.kept = [];
    this.keptBytes = 0;
  }

  /**
   * The lowest sequence number a replay can start from: every event from there on is kept.
   */
  get firstReplayableSeq(): number {
    return this.droppedThrough + 1;
  }

  private keep(event: StreamEvent): void {
    let size = this.nextEventSize;
    this.nextEventSize = undefined;
    if (size === undefined) {
      try {
        size = JSON.stringify(event).length;
      } catch {
        size = UNMEASURED_EVENT_BYTES;
      }
    }

    this.kept.push({ event, size });
    this.keptBytes += size;

    while (
      this.kept.length > 0 &&
      (this.kept.length > this.limits.maxEvents || this.keptBytes > this.limits.maxBytes)
    ) {
      const oldest = this.kept.shift() as { event: StreamEvent; size: number };
      this.keptBytes -= oldest.size;
      this.droppedThrough = Math.max(this.droppedThrough, oldest.event.seq);
    }
  }
}
