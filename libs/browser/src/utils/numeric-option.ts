/**
 * Numeric options
 *
 * Every limit of the enclave is a number, and several of them are written into the source of the
 * frame documents. A value reaches that source only through {@link numberLiteral}, which refuses
 * anything that is not a finite number: text never becomes part of a frame's script, whatever
 * the host passed and whichever way the source writer was reached.
 *
 * @packageDocumentation
 */

/** Longest delay a browser timer takes, in milliseconds (2^31 - 1); a longer one fires at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return `a ${typeof value}`;
}

/**
 * Check that an option is a finite number from 0 to `max`.
 *
 * @param name Name of the option, as the host writes it
 * @param value The value the host passed
 * @param max Largest value the option takes
 * @returns The value
 * @throws TypeError for anything else, a number written as text included
 */
export function requireFiniteNumber(name: string, value: unknown, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new TypeError(`${name} must be a finite number between 0 and ${max}, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * The text of a numeric option for generated source.
 *
 * @throws TypeError unless `value` is a finite, non-negative number
 */
export function numberLiteral(name: string, value: unknown): string {
  return String(requireFiniteNumber(name, value));
}
