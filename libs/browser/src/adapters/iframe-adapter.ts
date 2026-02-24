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
import {
  isEnclaveMessage,
  isToolCallMessage,
  isResultMessage,
  isConsoleMessage,
  isReadyMessage,
  generateId,
} from './iframe-protocol';
import { generateOuterIframeHtml } from './outer-iframe-bootstrap';
import { IFRAME_SANDBOX } from './iframe-html-builder';

/**
 * Execution context passed to the adapter
 */
export interface IframeExecutionContext {
  config: SerializedIframeConfig;
  toolHandler?: ToolHandler;
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

  /**
   * Execute code in the double iframe sandbox
   */
  async execute<T = unknown>(code: string, context: IframeExecutionContext): Promise<ExecutionResult<T>> {
    if (this.disposed) {
      throw new Error('IframeAdapter has been disposed');
    }

    const requestId = generateId();
    const startTime = Date.now();

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
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let messageHandler: ((event: MessageEvent) => void) | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
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
        cleanup();
        resolve(result);
      };

      // Set up message listener
      messageHandler = (event: MessageEvent) => {
        const data = event.data;
        if (!isEnclaveMessage(data)) return;

        if (isToolCallMessage(data) && data.requestId === requestId) {
          // Tool call from the sandbox - relay to toolHandler
          if (!context.toolHandler) {
            // Send error back
            this.sendToOuter({
              __enclave_msg__: true,
              type: 'tool-response',
              requestId,
              callId: data.callId,
              error: {
                name: 'Error',
                message: 'No tool handler configured',
              },
            });
            return;
          }

          // Execute tool handler and relay result/error
          const callId = data.callId;
          const toolHandler = context.toolHandler;
          (async () => {
            try {
              const result = await toolHandler(data.toolName, data.args);
              // Sanitize result through JSON round-trip
              let safeResult: unknown;
              try {
                safeResult = JSON.parse(JSON.stringify(result));
              } catch {
                safeResult = undefined;
              }

              this.sendToOuter({
                __enclave_msg__: true,
                type: 'tool-response',
                requestId,
                callId,
                result: safeResult,
              });
            } catch (error: unknown) {
              const err = error as Error;
              this.sendToOuter({
                __enclave_msg__: true,
                type: 'tool-response',
                requestId,
                callId,
                error: {
                  name: err.name || 'Error',
                  message: err.message || 'Tool call failed',
                },
              });
            }
          })();
        } else if (isResultMessage(data) && data.requestId === requestId) {
          // Execution result
          const stats: ExecutionStats = data.stats
            ? {
                duration: data.stats.duration,
                toolCallCount: data.stats.toolCallCount,
                iterationCount: data.stats.iterationCount,
                startTime: data.stats.startTime,
                endTime: data.stats.endTime,
              }
            : {
                ...defaultStats,
                duration: Date.now() - startTime,
                endTime: Date.now(),
              };

          if (data.success) {
            settle({
              success: true,
              value: data.value as T,
              stats,
            });
          } else {
            settle({
              success: false,
              error: data.error
                ? {
                    name: data.error.name,
                    message: data.error.message,
                    code: data.error.code,
                  }
                : {
                    name: 'ExecutionError',
                    message: 'Unknown execution error',
                  },
              stats,
            });
          }
        } else if (isConsoleMessage(data) && data.requestId === requestId) {
          // Console output - relay to host console
          const method = data.level as 'log' | 'warn' | 'error' | 'info';
          if (typeof console[method] === 'function') {
            console[method]('[Enclave]', ...data.args);
          }
        } else if (isReadyMessage(data)) {
          // Outer iframe is ready - no action needed, inner will auto-execute
        }
      };

      window.addEventListener('message', messageHandler);

      // Set up hard timeout with iframe.remove()
      const totalTimeout = context.config.timeout + (context.doubleIframeConfig.parentTimeoutBuffer || 1000);
      timeoutId = setTimeout(() => {
        settle({
          success: false,
          error: {
            name: 'TimeoutError',
            message: `Execution timed out after ${context.config.timeout}ms`,
            code: 'EXECUTION_TIMEOUT',
          },
          stats: {
            ...defaultStats,
            duration: Date.now() - startTime,
            endTime: Date.now(),
          },
        });
      }, totalTimeout);

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
        const err = error as Error;
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

    // Hard kill
    if (this.outerIframe && this.outerIframe.parentNode) {
      this.outerIframe.parentNode.removeChild(this.outerIframe);
      this.outerIframe = null;
    }
  }

  /**
   * Dispose the adapter and cleanup
   */
  dispose(): void {
    this.disposed = true;
    if (this.outerIframe && this.outerIframe.parentNode) {
      this.outerIframe.parentNode.removeChild(this.outerIframe);
      this.outerIframe = null;
    }
  }
}
