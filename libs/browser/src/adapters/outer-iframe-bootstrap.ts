/**
 * Outer Iframe Bootstrap Generator
 *
 * Generates the HTML/JS content for the outer iframe which acts as the
 * security barrier between the host page and the inner iframe where
 * user code runs.
 *
 * The outer iframe:
 * - Creates and manages the inner iframe
 * - Validates tool calls (rate limiting, pattern detection, name whitelisting)
 * - Relays validated messages between inner iframe and host page
 * - Handles console relay
 * - Enforces timeouts
 *
 * This is the browser equivalent of parent-vm-bootstrap.ts from @enclave-vm/core.
 *
 * @packageDocumentation
 */

import { buildIframeHtml } from './iframe-html-builder';
import { generateInnerIframeHtml } from './inner-iframe-bootstrap';
import type { SerializedIframeConfig, SerializableSuspiciousPattern } from '../types';

export interface OuterIframeBootstrapOptions {
  userCode: string;
  config: SerializedIframeConfig;
  requestId: string;
  suspiciousPatterns: SerializableSuspiciousPattern[];
  validationConfig: {
    validateOperationNames: boolean;
    allowedOperationPatternSource?: string;
    allowedOperationPatternFlags?: string;
    blockedOperationPatternSources?: string[];
    blockedOperationPatternFlags?: string[];
    maxOperationsPerSecond: number;
    blockSuspiciousSequences: boolean;
    rapidEnumerationThreshold: number;
    rapidEnumerationOverrides: Record<string, number>;
  };
}

/**
 * Generate the outer iframe HTML content
 */
export function generateOuterIframeHtml(options: OuterIframeBootstrapOptions): string {
  const script = generateOuterIframeScript(options);
  return buildIframeHtml(script, { title: 'Enclave Outer Sandbox' });
}

function generateOuterIframeScript(options: OuterIframeBootstrapOptions): string {
  const { userCode, config, requestId, suspiciousPatterns, validationConfig } = options;

  // Pre-generate the inner iframe HTML
  const innerHtml = generateInnerIframeHtml({
    userCode,
    config,
    requestId,
  });

  const patternDetectorsCode = generatePatternDetectors(suspiciousPatterns);

  return `
"use strict";
(function() {
  var requestId = ${JSON.stringify(requestId)};
  var aborted = false;
  var completed = false;

  // ============================================================
  // Safe Error
  // ============================================================
  function createSafeError(message, name) {
    var error = new Error(message);
    error.name = name || 'Error';
    try { Object.setPrototypeOf(error, null); } catch(e) {}
    try { Object.freeze(error); } catch(e) {}
    return error;
  }

  // ============================================================
  // Validation Configuration
  // ============================================================
  var validationConfig = ${JSON.stringify({
    validateOperationNames: validationConfig.validateOperationNames,
    maxOperationsPerSecond: validationConfig.maxOperationsPerSecond,
    blockSuspiciousSequences: validationConfig.blockSuspiciousSequences,
    rapidEnumerationThreshold: validationConfig.rapidEnumerationThreshold,
    rapidEnumerationOverrides: validationConfig.rapidEnumerationOverrides,
  })};

  ${
    validationConfig.allowedOperationPatternSource
      ? `var allowedOperationPattern = new RegExp(${JSON.stringify(validationConfig.allowedOperationPatternSource)}, ${JSON.stringify(validationConfig.allowedOperationPatternFlags || '')});`
      : ''
  }

  ${
    validationConfig.blockedOperationPatternSources
      ? `var blockedOperationPatterns = [${validationConfig.blockedOperationPatternSources
          .map(
            (src, i) =>
              `new RegExp(${JSON.stringify(src)}, ${JSON.stringify(validationConfig.blockedOperationPatternFlags?.[i] || '')})`,
          )
          .join(',')}];`
      : ''
  }

  // Suspicious pattern detectors
  var suspiciousPatterns = ${patternDetectorsCode};

  // Operation history for pattern detection
  var operationHistory = [];

  // Tool call counter
  var toolCallCount = 0;

  // ============================================================
  // Validation Logic (ported from parent-vm-bootstrap.ts)
  // ============================================================
  function validateOperation(operationName, args) {
    var now = Date.now();

    // Sliding window cleanup
    while (operationHistory.length > 0 && now - operationHistory[0].timestamp > 2000) {
      operationHistory.shift();
    }

    // Rate limiting
    var recentOps = operationHistory.filter(function(h) { return now - h.timestamp < 1000; });
    if (recentOps.length >= validationConfig.maxOperationsPerSecond) {
      throw createSafeError('Operation rate limit exceeded (' + validationConfig.maxOperationsPerSecond + ' operations/second)');
    }

    // Name validation
    if (typeof operationName !== 'string' || !operationName) {
      throw createSafeError('Operation name must be a non-empty string', 'TypeError');
    }

    // Whitelist check
    if (validationConfig.validateOperationNames && typeof allowedOperationPattern !== 'undefined') {
      allowedOperationPattern.lastIndex = 0;
      if (!allowedOperationPattern.test(operationName)) {
        throw createSafeError('Operation "' + operationName + '" does not match allowed pattern');
      }
    }

    // Blacklist check
    if (typeof blockedOperationPatterns !== 'undefined') {
      for (var i = 0; i < blockedOperationPatterns.length; i++) {
        blockedOperationPatterns[i].lastIndex = 0;
        if (blockedOperationPatterns[i].test(operationName)) {
          throw createSafeError('Operation "' + operationName + '" matches blocked pattern');
        }
      }
    }

    // Suspicious sequence detection
    if (validationConfig.blockSuspiciousSequences) {
      for (var j = 0; j < suspiciousPatterns.length; j++) {
        var pattern = suspiciousPatterns[j];
        var detected = false;
        try { detected = !!pattern.detect(operationName, args, operationHistory); }
        catch(e) { detected = false; }
        if (detected) {
          throw createSafeError('Suspicious pattern detected: ' + pattern.description + ' [' + pattern.id + ']');
        }
      }
    }
  }

  // ============================================================
  // Message Sending
  // ============================================================
  function sendToHost(msg) {
    msg.__enclave_msg__ = true;
    msg.requestId = requestId;
    try { window.parent.postMessage(msg, '*'); } catch(e) {}
  }

  var innerFrame = null;

  function sendToInner(msg) {
    msg.__enclave_msg__ = true;
    msg.requestId = requestId;
    if (innerFrame && innerFrame.contentWindow) {
      try { innerFrame.contentWindow.postMessage(msg, '*'); } catch(e) {}
    }
  }

  // ============================================================
  // Message Relay Logic (Three-Hop)
  // ============================================================
  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.__enclave_msg__ !== true) return;
    if (completed) return;

    var fromInner = (innerFrame && event.source === innerFrame.contentWindow);
    var fromHost = (event.source === window.parent);

    // Messages from inner iframe (tool-call, result, console)
    if (data.type === 'tool-call') {
      if (!fromInner) return;
      // Validate before forwarding to host
      try {
        // Double sanitize args
        var sanitizedArgs;
        try { sanitizedArgs = JSON.parse(JSON.stringify(data.args)); }
        catch(e) { throw createSafeError('Tool arguments must be JSON-serializable'); }

        toolCallCount++;
        validateOperation(data.toolName, sanitizedArgs);

        // Record in history
        operationHistory.push({
          operationName: data.toolName,
          timestamp: Date.now(),
          argKeys: Object.keys(sanitizedArgs)
        });

        // Forward validated tool call to host
        sendToHost({
          type: 'tool-call',
          callId: data.callId,
          toolName: data.toolName,
          args: sanitizedArgs
        });
      } catch(error) {
        // Validation failed - send error back to inner as tool-response
        sendToInner({
          type: 'tool-response',
          callId: data.callId,
          error: {
            name: (error && error.name) ? String(error.name) : 'ValidationError',
            message: (error && error.message) ? String(error.message) : 'Validation failed'
          }
        });
      }
    }
    else if (data.type === 'result') {
      if (!fromInner) return;
      // Forward execution result to host
      completed = true;
      sendToHost({
        type: 'result',
        success: data.success,
        value: data.value,
        error: data.error,
        stats: data.stats
      });
    }
    else if (data.type === 'console') {
      if (!fromInner) return;
      // Forward console output to host
      sendToHost({
        type: 'console',
        level: data.level,
        args: data.args
      });
    }
    else if (data.type === 'tool-response') {
      if (!fromHost) return;
      // Message from host - forward tool response to inner
      sendToInner({
        type: 'tool-response',
        callId: data.callId,
        result: data.result,
        error: data.error
      });
    }
    else if (data.type === 'abort') {
      if (!fromHost) return;
      // Abort from host - forward to inner and destroy it
      aborted = true;
      sendToInner({ type: 'abort' });
      // Remove inner iframe for hard termination
      if (innerFrame && innerFrame.parentNode) {
        innerFrame.parentNode.removeChild(innerFrame);
        innerFrame = null;
      }
    }
  });

  // ============================================================
  // Create Inner Iframe
  // ============================================================
  var innerHtml = ${JSON.stringify(innerHtml).replace(/<\//g, '<\\/')};

  innerFrame = document.createElement('iframe');
  innerFrame.sandbox = 'allow-scripts';
  innerFrame.srcdoc = innerHtml;
  innerFrame.style.cssText = 'position:absolute;width:0;height:0;border:none;overflow:hidden;';
  document.body.appendChild(innerFrame);

  // Signal ready to host
  sendToHost({ type: 'ready' });

  // ============================================================
  // Timeout Handling
  // ============================================================
  var timeout = ${config.timeout};
  setTimeout(function() {
    if (!completed) {
      completed = true;
      // Hard kill inner iframe
      if (innerFrame && innerFrame.parentNode) {
        innerFrame.parentNode.removeChild(innerFrame);
        innerFrame = null;
      }
      sendToHost({
        type: 'result',
        success: false,
        error: {
          name: 'TimeoutError',
          message: 'Execution timed out after ' + timeout + 'ms',
          code: 'EXECUTION_TIMEOUT'
        },
        stats: {
          duration: timeout,
          toolCallCount: toolCallCount,
          iterationCount: 0,
          startTime: Date.now() - timeout,
          endTime: Date.now()
        }
      });
    }
  }, timeout);
})();
`.trim();
}

/**
 * Dangerous patterns that should not appear in detectBody.
 * Duplicated from libs/core/src/double-vm/suspicious-patterns.ts
 * because the browser package does not depend on core.
 */
const DANGEROUS_BODY_PATTERNS = [
  /\bfunction\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/g, // Named function declarations
  /\bclass\s+[a-zA-Z_$]/g, // Class declarations
  /\brequire\s*\(/g, // CommonJS require
  /\bimport\s*\(/g, // Dynamic import
  /\bimport\s+/g, // Static import
  /\bglobal\b/g, // Global object
  /\bglobalThis\b/g, // GlobalThis object
  /\bprocess\b/g, // Node.js process
];

function validateDetectBody(detectBody: string, patternId: string): void {
  for (const pattern of DANGEROUS_BODY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(detectBody)) {
      throw new Error(
        `Pattern "${patternId}": detectBody contains potentially dangerous code. ` +
          `Custom patterns should only contain detection logic, not function declarations, ` +
          `imports, or global object access.`,
      );
    }
  }
}

/**
 * Generate code for pattern detectors
 */
function generatePatternDetectors(patterns: SerializableSuspiciousPattern[]): string {
  if (patterns.length === 0) return '[]';

  for (const p of patterns) {
    validateDetectBody(p.detectBody, p.id);
  }

  const patternDefs = patterns
    .map(
      (p) =>
        `{ id: ${JSON.stringify(p.id)}, description: ${JSON.stringify(p.description)}, detect: function(operationName, args, history) { ${p.detectBody} } }`,
    )
    .join(',\n    ');

  return `[${patternDefs}]`;
}
