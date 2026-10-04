/**
 * UTF-8 byte length without Node.js `Buffer`, so the package runs in browsers and edge runtimes.
 *
 * @module utils/utf8-byte-length
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

/**
 * Count the bytes `value` takes in UTF-8, as `Buffer.byteLength(value, 'utf8')` does: a lone
 * surrogate counts as the 3 bytes of U+FFFD. Walks the string without allocating a copy, since
 * the pre-scanner measures untrusted input before any other check.
 *
 * @param value - The string to measure
 * @returns The byte length in UTF-8 encoding
 */
export function utf8ByteLength(value: string): number {
  let byteLength = 0;

  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit < 0x80) {
      byteLength += 1;
    } else if (codeUnit < 0x800) {
      byteLength += 2;
    } else if (isSurrogatePairAt(value, index)) {
      byteLength += 4;
      index++;
    } else {
      byteLength += 3;
    }
  }

  return byteLength;
}

function isSurrogatePairAt(value: string, index: number): boolean {
  const highCodeUnit = value.charCodeAt(index);
  const lowCodeUnit = value.charCodeAt(index + 1);
  return (
    highCodeUnit >= HIGH_SURROGATE_START &&
    highCodeUnit <= HIGH_SURROGATE_END &&
    lowCodeUnit >= LOW_SURROGATE_START &&
    lowCodeUnit <= LOW_SURROGATE_END
  );
}
