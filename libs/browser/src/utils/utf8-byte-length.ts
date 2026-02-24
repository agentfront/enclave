/**
 * UTF-8 Byte Length Utility
 *
 * Browser replacement for Node.js Buffer.byteLength().
 * Uses TextEncoder which is available in all modern browsers.
 *
 * @packageDocumentation
 */

const encoder = new TextEncoder();

/**
 * Calculate the UTF-8 byte length of a string
 *
 * @param value - The string to measure
 * @returns The byte length in UTF-8 encoding
 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
