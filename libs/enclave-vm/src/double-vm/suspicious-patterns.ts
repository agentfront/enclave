/**
 * Default Suspicious Pattern Detectors
 *
 * These patterns detect potentially malicious operation sequences
 * that may indicate data exfiltration, enumeration attacks, or
 * other security threats.
 *
 * @packageDocumentation
 */

import type { SuspiciousPattern, SerializableSuspiciousPattern, OperationHistory } from './types';

/**
 * Detect list/query followed by send/export (potential data exfiltration)
 *
 * This pattern detects when a script queries data and then attempts
 * to send it somewhere, which could indicate data theft.
 */
const EXFIL_LIST_SEND: SuspiciousPattern = {
  id: 'EXFIL_LIST_SEND',
  description: 'List/query followed by send/export (potential exfiltration)',
  detect: (operationName: string, _args: unknown, history: OperationHistory[]): boolean => {
    // Look for recent data retrieval operations
    const recentQueries = history.filter(
      (h) => /list|query|get|fetch|read|search|find|select/i.test(h.operationName) && Date.now() - h.timestamp < 5000,
    );

    // Check if current operation is a send/export operation
    const isSendOperation = /send|export|post|write|upload|publish|emit|transmit|forward/i.test(operationName);

    return recentQueries.length > 0 && isSendOperation;
  },
};

/**
 * Detect rapid enumeration of resources
 *
 * This pattern detects when the same operation is called repeatedly
 * in quick succession, which could indicate enumeration attacks.
 * Uses a 5-second window to be resilient to varying execution speeds.
 */
const RAPID_ENUMERATION: SuspiciousPattern = {
  id: 'RAPID_ENUMERATION',
  description: 'Rapid enumeration of resources (same operation called >10 times in 5s)',
  detect: (operationName: string, _args: unknown, history: OperationHistory[]): boolean => {
    const recentSameOperation = history.filter(
      (h) => h.operationName === operationName && Date.now() - h.timestamp < 5000,
    );
    return recentSameOperation.length > 10;
  },
};

/**
 * Detect credential/secret access followed by external call
 *
 * This pattern detects when credentials are accessed and then
 * an external-looking operation is attempted.
 */
const CREDENTIAL_EXFIL: SuspiciousPattern = {
  id: 'CREDENTIAL_EXFIL',
  description: 'Credential access followed by external operation',
  detect: (operationName: string, _args: unknown, history: OperationHistory[]): boolean => {
    // Look for recent credential access
    const recentCredentialAccess = history.filter(
      (h) =>
        /secret|credential|password|token|key|auth|api[_-]?key/i.test(h.operationName) &&
        Date.now() - h.timestamp < 10000,
    );

    // Check if current operation looks like external communication
    const isExternalOperation = /http|api|external|webhook|slack|email|sms|notification/i.test(operationName);

    return recentCredentialAccess.length > 0 && isExternalOperation;
  },
};

/**
 * Detect bulk data operations
 *
 * This pattern detects when bulk/batch operations are used,
 * which could indicate mass data extraction.
 * Note: Uses word boundaries to avoid false positives like "install" matching "all"
 */
const BULK_OPERATION: SuspiciousPattern = {
  id: 'BULK_OPERATION',
  description: 'Bulk/batch operation detected',
  detect: (operationName: string, args: unknown, _history: OperationHistory[]): boolean => {
    // Check operation name for bulk indicators (with word boundaries to avoid false positives)
    // Examples that should match: bulk_export, batch:process, export_all, mass-delete
    // Examples that should NOT match: install, deleteAll, getAllUsers
    const isBulkOperation = /\b(bulk|batch|mass|dump)\b|export[_-]all\b/i.test(operationName);

    // Check for suspicious arguments that indicate bulk access
    if (typeof args === 'object' && args !== null) {
      const argStr = JSON.stringify(args).toLowerCase();
      const hasBulkArgs = /limit.*[0-9]{4,}|"\*"|no[_-]?limit/i.test(argStr);
      if (hasBulkArgs) return true;
    }

    return isBulkOperation;
  },
};

/**
 * Detect delete operations after data access
 *
 * This pattern detects potential cover-up attempts where
 * data is accessed and then deleted.
 */
const DELETE_AFTER_ACCESS: SuspiciousPattern = {
  id: 'DELETE_AFTER_ACCESS',
  description: 'Delete operation after data access (potential cover-up)',
  detect: (operationName: string, _args: unknown, history: OperationHistory[]): boolean => {
    // Check if current operation is a delete operation
    const isDeleteOperation = /delete|remove|destroy|purge|clear|wipe|erase/i.test(operationName);

    if (!isDeleteOperation) return false;

    // Look for recent data access
    const recentDataAccess = history.filter(
      (h) => /list|query|get|fetch|read|search|find|select/i.test(h.operationName) && Date.now() - h.timestamp < 30000,
    );

    return recentDataAccess.length > 0;
  },
};

/**
 * Default suspicious patterns
 *
 * These are enabled by default when blockSuspiciousSequences is true.
 */
export const DEFAULT_SUSPICIOUS_PATTERNS: SuspiciousPattern[] = [
  EXFIL_LIST_SEND,
  RAPID_ENUMERATION,
  CREDENTIAL_EXFIL,
  BULK_OPERATION,
  DELETE_AFTER_ACCESS,
];

/**
 * Convert a SuspiciousPattern to serializable form
 *
 * Since functions cannot be passed across VM boundaries,
 * we extract the function body as a string.
 *
 * @remarks
 * This function expects standard JavaScript function definitions. It may not work
 * correctly with:
 * - Minified/bundled code where functions are transformed
 * - Native functions (returns "[native code]")
 * - Functions with unusual formatting
 *
 * @throws {Error} If the function cannot be serialized or appears malformed
 */
export function serializePattern(pattern: SuspiciousPattern): SerializableSuspiciousPattern {
  if (typeof pattern.detect !== 'function') {
    throw new Error(`Pattern "${pattern.id}": detect must be a function`);
  }

  const funcStr = pattern.detect.toString();

  // Validate the function string is usable
  if (funcStr.includes('[native code]')) {
    throw new Error(`Pattern "${pattern.id}": Cannot serialize native functions`);
  }

  // Extract the function body
  // Handles arrow functions: (a, b, c) => { body } or (a, b, c) => expr
  // Handles regular functions: function(a, b, c) { body }
  let detectBody: string;

  try {
    if (funcStr.includes('=>')) {
      // Arrow function
      const arrowIndex = funcStr.indexOf('=>');
      const bodyPart = funcStr.substring(arrowIndex + 2).trim();

      if (bodyPart.startsWith('{')) {
        // Block body - extract contents
        detectBody = bodyPart.slice(1, -1).trim();
      } else {
        // Expression body - wrap in return
        detectBody = `return ${bodyPart};`;
      }
    } else {
      // Regular function - extract body between first { and last }
      const firstBrace = funcStr.indexOf('{');
      const lastBrace = funcStr.lastIndexOf('}');

      if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
        throw new Error('Could not extract function body');
      }

      detectBody = funcStr.substring(firstBrace + 1, lastBrace).trim();
    }

    // Basic validation that extracted body is not empty
    if (!detectBody || detectBody.length === 0) {
      throw new Error('Extracted function body is empty');
    }
  } catch (error) {
    throw new Error(`Pattern "${pattern.id}": Failed to serialize detect function - ${(error as Error).message}`);
  }

  return {
    id: pattern.id,
    description: pattern.description,
    detectBody,
  };
}

/**
 * Serialize all patterns for passing to parent VM
 */
export function serializePatterns(patterns: SuspiciousPattern[]): SerializableSuspiciousPattern[] {
  return patterns.map(serializePattern);
}

/**
 * Create detection function source code for parent VM
 *
 * This generates JavaScript code that recreates the detection functions
 * inside the parent VM context.
 */
export function generatePatternDetectorsCode(patterns: SerializableSuspiciousPattern[]): string {
  const patternDefs = patterns
    .map(
      (p) => `{
    id: ${JSON.stringify(p.id)},
    description: ${JSON.stringify(p.description)},
    detect: function(operationName, args, history) {
      ${p.detectBody}
    }
  }`,
    )
    .join(',\n  ');

  return `[${patternDefs}]`;
}
