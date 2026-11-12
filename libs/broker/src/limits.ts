/**
 * Session limits
 *
 * How the limits of a session are put together from the package defaults, the broker's
 * configuration and the configuration of one session, and what a limit must be before it is used.
 *
 * @packageDocumentation
 */

import type { SessionLimits } from '@enclave-vm/types';
import { DEFAULT_SESSION_LIMITS } from '@enclave-vm/types';

const LIMIT_KEYS = Object.keys(DEFAULT_SESSION_LIMITS) as Array<keyof SessionLimits>;

/**
 * The longest delay a timer can hold.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A delay that a timer runs as given.
 */
export function timerDelay(ms: number): number {
  return Math.min(Math.max(ms, 1), MAX_TIMER_MS);
}

/**
 * Merge limit objects field by field. A later object replaces a field only when it gives it a
 * value, so a session that names one limit keeps every other limit of the layers before it.
 * Keys that are not session limits are dropped.
 */
export function mergeSessionLimits(...layers: Array<Partial<SessionLimits> | undefined>): Partial<SessionLimits> {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (typeof layer !== 'object') {
      throw new TypeError('Session limits must be an object');
    }
    for (const key of LIMIT_KEYS) {
      const value = (layer as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  return merged as Partial<SessionLimits>;
}

/**
 * The complete limits of a session: the given fields over the package defaults.
 *
 * Every numeric limit must be a number. A limit ends up in the configuration of the sandbox and
 * in timers, so a value of another type is refused here instead of being passed on.
 *
 * @throws TypeError when a limit has the wrong type
 */
export function resolveSessionLimits(limits?: Partial<SessionLimits>): Required<SessionLimits> {
  const resolved = { ...DEFAULT_SESSION_LIMITS, ...mergeSessionLimits(limits) } as Required<SessionLimits>;

  for (const key of LIMIT_KEYS) {
    const value: unknown = resolved[key];
    if (key === 'cancelOnFirstError') {
      if (typeof value !== 'boolean') {
        throw new TypeError(`Session limit "${key}" must be a boolean`);
      }
    } else if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(`Session limit "${key}" must be a number`);
    }
  }

  return resolved;
}
