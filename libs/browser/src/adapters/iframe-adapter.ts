/**
 * Iframe Adapter
 *
 * Implements the sandbox adapter interface using a double iframe architecture.
 * Creates an outer iframe (security barrier) containing an inner iframe (user code).
 *
 * This is the browser equivalent of DoubleVmWrapper from @enclave-vm/core.
 *
 * @packageDocumentation
 */

import type {
  ExecutionResult,
  ExecutionStats,
  SecurityLevel,
  ToolHandler,
  SerializedIframeConfig,
  SerializableSuspiciousPattern,
  DoubleIframeConfig,
  SecureProxyLevelConfig,
} from '../types';
import { isEnclaveMessage, parseOuterToHostMessage, generateId, type ToolCallMessage } from './iframe-protocol';
import {
  ConsoleBudget,
  PROTOCOL_VIOLATION_CODE,
  ProtocolViolationError,
  boundError,
  copyScriptResult,
  copyToolArguments,
  createOperationNameCheck,
  normalizeStats,
} from './host-boundary';
import { generateOuterIframeHtml } from './outer-iframe-bootstrap';
import { IFRAME_SANDBOX } from './iframe-html-builder';
import { PausableTimer } from './pausable-timer';

/**
 * Execution context passed to the adapter
 */
export interface IframeExecutionContext {
  config: SerializedIframeConfig;
  toolHandler?: ToolHandler;
  /**
   * How long a tool call in progress when the timeout has passed may still take, in milliseconds
   * (`Infinity`: as long as it takes).
   */
  toolCallGraceMs: number;
  securityLevel: SecurityLevel;
  doubleIframeConfig: DoubleIframeConfig;
  secureProxyConfig: SecureProxyLevelConfig;
  blockedProperties: string[];
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
 * IframeAdapter - Executes code in a double iframe sandbox
 */
export class IframeAdapter {
  private outerIframe: HTMLIFrameElement | null = null;
  private disposed = false;
  private executing = false;
  private pendingSettle: ((result: ExecutionResult<unknown>) => void) | null = null;
  private currentExecutionStart = 0;

  /**
   * Execute code in the double iframe sandbox
   */
  async execute<T = unknown>(code: string, context: IframeExecutionContext): Promise<ExecutionResult<T>> {
    if (this.disposed) {
      throw new Error('IframeAdapter has been disposed');
    }
    if (this.executing) {
      throw new Error('IframeAdapter: concurrent execution not supported');
    }
    this.executing = true;

    const requestId = generateId();
    const startTime = Date.now();
    this.currentExecutionStart = startTime;

    // Default stats
    const defaultStats: ExecutionStats = {
      duration: 0,
      toolCallCount: 0,
      iterationCount: 0,
      startTime,
      endTime: 0,
    };

    return new Promise<ExecutionResult<T>>((resolve) => {
      let settled = false;
      let timeoutTimer: PausableTimer | null = null;
      let toolCallCap: ReturnType<typeof setTimeout> | null = null;
      let pendingToolCalls = 0;
      let messageHandler: ((event: MessageEvent) => void) | null = null;

      // The hard stop of the host: the timeout, and what the outer iframe gets to report its own.
      const totalTimeout = context.config.timeout + (context.doubleIframeConfig.parentTimeoutBuffer || 1000);
      // Elapsed time on a clock the page cannot set (`Date.now` can be replaced, and jumps with
      // the system clock).
      const startedAt = performance.now();

      const cleanup = () => {
        timeoutTimer?.stop();
        if (toolCallCap !== null) {
          clearTimeout(toolCallCap);
          toolCallCap = null;
        }
        if (messageHandler) {
          window.removeEventListener('message', messageHandler);
          messageHandler = null;
        }
        // Remove iframe
        if (this.outerIframe && this.outerIframe.parentNode) {
          this.outerIframe.parentNode.removeChild(this.outerIframe);
          this.outerIframe = null;
        }
      };

      const settle = (result: ExecutionResult<T>) => {
        if (settled) return;
        settled = true;
        this.executing = false;
        this.pendingSettle = null;
        cleanup();
        resolve(result);
      };

      this.pendingSettle = settle as (result: ExecutionResult<unknown>) => void;

      // The sandbox broke the protocol: nothing it sent is acted on any more, and the iframes go.
      const endForProtocolViolation = (violation: ProtocolViolationError) => {
        settle({
          success: false,
          error: { name: violation.name, message: violation.message, code: PROTOCOL_VIOLATION_CODE },
          stats: { ...defaultStats, duration: Date.now() - startTime, endTime: Date.now() },
        });
      };

      // Limits and rules the host applies itself, whatever the iframes have already applied
      const operationNameRefusal = createOperationNameCheck(context.validationConfig);
      const consoleBudget = new ConsoleBudget(context.config.maxConsoleCalls, context.config.maxConsoleOutputBytes);
      const maxToolCalls = context.config.maxToolCalls;
      let toolCallsReceived = 0;

      const refuseToolCall = (callId: string, message: string) => {
        this.sendToOuter({
          __enclave_msg__: true,
          type: 'tool-response',
          requestId,
          callId,
          error: { name: 'Error', message },
        });
      };

      const handleToolCall = (data: ToolCallMessage) => {
        const callId = data.callId;

        toolCallsReceived++;
        if (toolCallsReceived > maxToolCalls) {
          refuseToolCall(callId, `Maximum tool call limit exceeded (${maxToolCalls}).`);
          return;
        }

        const refusal = operationNameRefusal(data.toolName);
        if (refusal) {
          refuseToolCall(callId, refusal);
          return;
        }

        // What the handler receives is a copy made here, of JSON data only, without the keys that
        // reach Object.prototype when a handler merges or assigns its arguments.
        const args = copyToolArguments(data.args);

        if (!context.toolHandler) {
          refuseToolCall(callId, 'No tool handler configured');
          return;
        }

        // The sandbox refuses a tool call once the timeout has passed. The host does not rely on
        // that: a call that arrives after its own hard stop is not started either, so no call can
        // begin once the time in which a call may still be in progress has started to run out.
        if (performance.now() - startedAt > totalTimeout) {
          refuseToolCall(callId, 'Execution aborted');
          return;
        }

        // Execute tool handler and relay result/error. The timeout does not run while the host
        // handles a tool call, as in @enclave-vm/core, which does not cut off a call in progress
        // at the deadline. How long it may still take is bounded below (toolCallGraceMs).
        const toolHandler = context.toolHandler;
        const toolName = data.toolName;
        pendingToolCalls++;
        timeoutTimer?.pause();
        (async () => {
          try {
            const result = await toolHandler(toolName, args);
            // The run is over (the call outlasted its grace, or the run was aborted): what the
            // handler returns now belongs to no script. It must not reach the iframe of a later run.
            if (settled) return;
            // Sanitize result through JSON round-trip. A result that cannot be delivered is a
            // failure of the tool, as in @enclave-vm/core, not a successful `undefined`.
            let safeResult: unknown;
            let undeliverable: { message: string; code: string } | undefined;
            if (result !== undefined) {
              try {
                const json = JSON.stringify(result);
                if (json === undefined) {
                  undeliverable = { message: 'Tool returned an unsupported value', code: 'TOOL_RESULT_NOT_SAFE' };
                } else {
                  safeResult = JSON.parse(json);
                }
              } catch {
                undeliverable = { message: 'Tool result must be JSON-serializable', code: 'TOOL_RESULT_NOT_JSON' };
              }
            }

            if (undeliverable) {
              this.sendToOuter({
                __enclave_msg__: true,
                type: 'tool-response',
                requestId,
                callId,
                error: { name: 'ToolBridgeError', ...undeliverable },
                toolError: true,
              });
              return;
            }

            this.sendToOuter({
              __enclave_msg__: true,
              type: 'tool-response',
              requestId,
              callId,
              result: safeResult,
            });
          } catch (error: unknown) {
            if (settled) return;
            const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
            const code = (error as { code?: unknown } | null)?.code;
            this.sendToOuter({
              __enclave_msg__: true,
              type: 'tool-response',
              requestId,
              callId,
              error: {
                name: err.name,
                message: err.message,
                ...(typeof code === 'string' ? { code } : {}),
              },
              // A failure of the tool itself (not a refusal by the enclave): a script's
              // callTool(..., { throwOnError: false }) receives it as a result object.
              toolError: true,
            });
          } finally {
            pendingToolCalls--;
            if (pendingToolCalls === 0) timeoutTimer?.resume();
          }
        })();
      };

      // Set up message listener
      messageHandler = (event: MessageEvent) => {
        const data = event.data;
        if (!isEnclaveMessage(data)) return;
        // Only the outer iframe of this execution speaks to this handler. Anything else that
        // posts to the page (another frame, the script itself through `top`) is not listened to.
        if (event.source !== this.outerIframe?.contentWindow) return;

        // The sandbox is the less trusted side of this boundary: every message is checked against
        // the protocol before anything here acts on it, and the data it carries is copied.
        const parsed = parseOuterToHostMessage(data, requestId);
        if (!parsed.ok) {
          endForProtocolViolation(new ProtocolViolationError(parsed.reason));
          return;
        }
        const message = parsed.message;

        try {
          if (message.type === 'tool-call') {
            handleToolCall(message);
          } else if (message.type === 'result') {
            const stats = normalizeStats(message.stats);
            if (message.success) {
              settle({
                success: true,
                value: copyScriptResult(message.value, {
                  maxDepth: context.config.maxSanitizeDepth,
                  maxProperties: context.config.maxSanitizeProperties,
                }) as T,
                stats,
              });
            } else {
              settle({
                success: false,
                error: message.error
                  ? boundError(message.error)
                  : { name: 'ExecutionError', message: 'Unknown execution error' },
                stats,
              });
            }
          } else if (message.type === 'console') {
            // Console output - relay to the host console, within the limits of the execution
            if (consoleBudget.admit(message.args)) {
              console[message.level]('[Enclave]', ...message.args);
            }
          }
          // 'ready': the outer iframe is up; the inner one starts by itself
        } catch (error: unknown) {
          if (error instanceof ProtocolViolationError) {
            endForProtocolViolation(error);
            return;
          }
          throw error;
        }
      };

      window.addEventListener('message', messageHandler);

      // Hard timeout with iframe.remove(), backing up the outer iframe's own timeout
      const endForTimeout = () => {
        settle({
          success: false,
          error: {
            name: 'TimeoutError',
            message: `Execution timed out after ${context.config.timeout}ms`,
            code: 'EXECUTION_TIMEOUT',
            // As in @enclave-vm/core: how many tool calls the run stopped waiting for
            ...(pendingToolCalls > 0 ? { data: { pendingHostCalls: pendingToolCalls } } : {}),
          },
          stats: {
            ...defaultStats,
            duration: Date.now() - startTime,
            endTime: Date.now(),
          },
        });
      };
      timeoutTimer = new PausableTimer(totalTimeout, endForTimeout);
      timeoutTimer.resume();

      // The hard timeout does not run while a tool call is in progress, so by itself it would
      // wait for a handler that never settles for ever. This timer runs whatever is in progress:
      // a tool call that has still not delivered when the grace is over is abandoned and the run
      // ends with the timeout error, as in @enclave-vm/core. No call starts after the hard stop
      // (see handleToolCall), so nothing can be in progress later than this.
      if (Number.isFinite(context.toolCallGraceMs)) {
        toolCallCap = setTimeout(() => {
          toolCallCap = null;
          if (pendingToolCalls > 0) endForTimeout();
        }, totalTimeout + context.toolCallGraceMs);
      }

      // Generate outer iframe HTML
      try {
        const outerHtml = generateOuterIframeHtml({
          userCode: code,
          config: context.config,
          requestId,
          suspiciousPatterns: context.suspiciousPatterns,
          validationConfig: context.validationConfig,
        });

        // Create outer iframe
        this.outerIframe = document.createElement('iframe');
        this.outerIframe.sandbox = IFRAME_SANDBOX;
        this.outerIframe.srcdoc = outerHtml;
        this.outerIframe.style.position = 'absolute';
        this.outerIframe.style.width = '0';
        this.outerIframe.style.height = '0';
        this.outerIframe.style.border = 'none';
        this.outerIframe.style.overflow = 'hidden';
        this.outerIframe.setAttribute('aria-hidden', 'true');

        document.body.appendChild(this.outerIframe);
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
        settle({
          success: false,
          error: {
            name: 'IframeError',
            message: `Failed to create sandbox iframe: ${err.message}`,
            code: 'IFRAME_CREATE_FAILED',
          },
          stats: {
            ...defaultStats,
            duration: Date.now() - startTime,
            endTime: Date.now(),
          },
        });
      }
    });
  }

  /**
   * Send a message to the outer iframe
   */
  private sendToOuter(msg: Record<string, unknown>): void {
    if (this.outerIframe && this.outerIframe.contentWindow) {
      try {
        // '*' is required: srcdoc iframes have a null origin, so no specific targetOrigin can be used.
        // Re-evaluate if loading strategy changes to blob URLs or a known origin.
        this.outerIframe.contentWindow.postMessage(msg, '*');
      } catch {
        // Iframe may have been removed
      }
    }
  }

  /**
   * Abort current execution
   */
  abort(requestId: string): void {
    this.sendToOuter({
      __enclave_msg__: true,
      type: 'abort',
      requestId,
    });

    // Settle the pending promise with an AbortError so it doesn't hang until timeout
    if (this.pendingSettle) {
      this.pendingSettle({
        success: false,
        error: {
          name: 'AbortError',
          message: 'Execution was aborted',
          code: 'EXECUTION_ABORTED',
        },
        stats: {
          duration: this.currentExecutionStart ? Date.now() - this.currentExecutionStart : 0,
          toolCallCount: 0,
          iterationCount: 0,
          startTime: this.currentExecutionStart,
          endTime: Date.now(),
        },
      });
    }
  }

  /**
   * Dispose the adapter and cleanup
   */
  dispose(): void {
    this.disposed = true;
    if (this.pendingSettle) {
      this.pendingSettle({
        success: false,
        error: {
          name: 'DisposedError',
          message: 'IframeAdapter was disposed during execution',
          code: 'ADAPTER_DISPOSED',
        },
        stats: {
          duration: this.currentExecutionStart ? Date.now() - this.currentExecutionStart : 0,
          toolCallCount: 0,
          iterationCount: 0,
          startTime: this.currentExecutionStart,
          endTime: Date.now(),
        },
      });
    }
    if (this.outerIframe && this.outerIframe.parentNode) {
      this.outerIframe.parentNode.removeChild(this.outerIframe);
      this.outerIframe = null;
    }
  }
}
