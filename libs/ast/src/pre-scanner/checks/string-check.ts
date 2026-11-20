/**
 * String literal validation for the pre-scanner.
 * Checks string lengths and total string content.
 *
 * @module pre-scanner/checks/string-check
 */

import type { PreScannerConfig } from '../config';
import type { ScanState } from '../scan-state';
import { PRESCANNER_ERROR_CODES } from '../errors';
import { walkCode } from './code-walk';

/**
 * Check string literals for excessive length.
 * This is a heuristic scan that finds string literals and validates their sizes.
 *
 * @param source - The source code to check
 * @param config - Pre-scanner configuration
 * @param state - Scan state for recording issues
 */
export function checkStringLiterals(source: string, config: PreScannerConfig, state: ScanState): void {
  let totalStringContent = 0;

  // Every string literal, also those written in the interpolations of a template (see walkCode)
  walkCode(source, {
    string: (stringStart, stringLine, stringLength) => {
      totalStringContent += stringLength;
      state.addStringContent(stringLength);

      // Check individual string length
      if (stringLength > config.maxStringLength) {
        state.reportFatalError({
          code: PRESCANNER_ERROR_CODES.STRING_TOO_LONG,
          message: `String literal length (${formatSize(stringLength)}) exceeds maximum allowed (${formatSize(
            config.maxStringLength,
          )})`,
          position: stringStart,
          line: stringLine,
          data: { actual: stringLength, limit: config.maxStringLength },
        });
        return true;
      }

      // Check total string content
      if (totalStringContent > config.maxTotalStringContent) {
        state.reportFatalError({
          code: PRESCANNER_ERROR_CODES.STRING_TOTAL_EXCEEDED,
          message: `Total string content (${formatSize(totalStringContent)}) exceeds maximum allowed (${formatSize(
            config.maxTotalStringContent,
          )})`,
          position: stringStart,
          line: stringLine,
          data: { actual: totalStringContent, limit: config.maxTotalStringContent },
        });
        return true;
      }
      return false;
    },
  });
}

/**
 * Perform string checks.
 *
 * @param source - The source code to check
 * @param config - Pre-scanner configuration
 * @param state - Scan state for recording issues
 */
export function performStringChecks(source: string, config: PreScannerConfig, state: ScanState): void {
  checkStringLiterals(source, config, state);
}

/**
 * Format size as human-readable string
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} chars`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
