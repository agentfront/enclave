/**
 * Cross-platform SHA-256 hashing utility.
 *
 * Uses Web Crypto API (crypto.subtle) which is available in both
 * Node.js 18+ and modern browsers.
 *
 * @packageDocumentation
 */

/**
 * Compute SHA-256 hex digest of a string.
 */
export async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
