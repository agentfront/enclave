import type { ExecutionContext } from './types';
import { inCallOrder, type BridgeReply } from './tool-call-order';
import { sanitizeValue } from './value-sanitizer';
import { ReferenceResolver, ResolutionLimitError } from './sidecar/reference-resolver';
import { JsonTooLargeError, JsonTraversalLimitError, stringifyWithin } from './bounded-json';

const TOOL_BRIDGE_PROTOCOL_VERSION = 1 as const;

type ToolBridgeErrorPayload = {
  name: string;
  message: string;
  code?: string;
  /**
   * Set when the tool itself failed (its handler threw or rejected, or its result could not be
   * delivered), as opposed to the enclave refusing the call. A script's
   * `callTool(..., { throwOnError: false })` receives only such failures as a result object.
   */
  toolError?: true;
};

type ToolBridgeOkResponse = {
  v: typeof TOOL_BRIDGE_PROTOCOL_VERSION;
  ok: true;
  value?: unknown;
};

type ToolBridgeErrorResponse = {
  v: typeof TOOL_BRIDGE_PROTOCOL_VERSION;
  ok: false;
  error: ToolBridgeErrorPayload;
};

type ToolBridgeResponse = ToolBridgeOkResponse | ToolBridgeErrorResponse;

type ToolBridgeRequest = {
  v: typeof TOOL_BRIDGE_PROTOCOL_VERSION;
  tool: string;
  args: Record<string, unknown>;
};

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

function truncateForErrorMessage(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function toErrorPayload(
  error: unknown,
  fallbackName: string,
  fallbackMessage: string,
  code?: string,
): ToolBridgeErrorPayload {
  const safe: ToolBridgeErrorPayload = {
    name: fallbackName,
    message: fallbackMessage,
    code,
  };

  if (error && typeof error === 'object') {
    const maybeName = (error as { name?: unknown }).name;
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCode = (error as { code?: unknown }).code;

    if (typeof maybeName === 'string' && maybeName) safe.name = maybeName;
    if (typeof maybeMessage === 'string' && maybeMessage) safe.message = maybeMessage;
    if (typeof maybeCode === 'string' && maybeCode) safe.code = maybeCode;
  } else if (typeof error === 'string' && error) {
    safe.message = error;
  }

  safe.message = truncateForErrorMessage(String(safe.message || fallbackMessage), 4096);
  safe.name = truncateForErrorMessage(String(safe.name || fallbackName), 128);

  return safe;
}

/** The rest of a reply to a result: stored in the sidecar when it is a large string, then serialized */
function finishReply(
  executionContext: ExecutionContext,
  maxPayloadBytes: number,
  tool: string,
  result: unknown,
): string {
  const { sidecar, referenceConfig } = executionContext;
  let sanitizedResult = result;
  // Lift large string results to sidecar if configured. Such a result reaches the script as
  // a reference or not at all: when the sidecar refuses to store it (a quota), the call fails
  // rather than hand the script the text the sidecar was there to keep from it.
  if (sidecar && referenceConfig && typeof sanitizedResult === 'string') {
    const size = utf8ByteLength(sanitizedResult);
    if (size >= referenceConfig.extractionThreshold) {
      try {
        const refId = sidecar.store(sanitizedResult, 'tool-result', { origin: tool });
        sanitizedResult = refId;
      } catch {
        executionContext.onToolBridgeFailure?.();
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolBridgeError',
              message: 'Tool result could not be stored in the reference sidecar',
              code: 'TOOL_RESULT_NOT_STORED',
              toolError: true,
            },
          },
          maxPayloadBytes,
        );
      }
    }
  }

  const okResponse: ToolBridgeOkResponse =
    sanitizedResult === undefined
      ? { v: TOOL_BRIDGE_PROTOCOL_VERSION, ok: true }
      : { v: TOOL_BRIDGE_PROTOCOL_VERSION, ok: true, value: sanitizedResult };

  let okJson: string;
  try {
    okJson = safeJsonStringify(okResponse);
  } catch (error: unknown) {
    const safeError = toErrorPayload(
      error,
      'ToolBridgeError',
      'Tool result must be JSON-serializable',
      'TOOL_RESULT_NOT_JSON',
    );
    executionContext.onToolBridgeFailure?.();
    return serializeResponse(
      {
        v: TOOL_BRIDGE_PROTOCOL_VERSION,
        ok: false,
        error: { ...safeError, toolError: true },
      },
      maxPayloadBytes,
    );
  }

  if (utf8ByteLength(okJson) > maxPayloadBytes) {
    executionContext.onToolBridgeFailure?.();
    return serializeResponse(
      {
        v: TOOL_BRIDGE_PROTOCOL_VERSION,
        ok: false,
        error: {
          name: 'ToolBridgeError',
          message: `Tool response exceeds maximum size (${maxPayloadBytes} bytes)`,
          code: 'TOOL_BRIDGE_RESPONSE_TOO_LARGE',
          toolError: true,
        },
      },
      maxPayloadBytes,
    );
  }

  return okJson;
}

function serializeResponse(response: ToolBridgeResponse, maxPayloadBytes: number): string {
  let json: string;
  try {
    json = safeJsonStringify(response);
  } catch {
    json = JSON.stringify({
      v: TOOL_BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        name: 'ToolBridgeError',
        message: 'Tool bridge failed to serialize response',
        code: 'TOOL_BRIDGE_SERIALIZE_FAILED',
      },
    } satisfies ToolBridgeErrorResponse);
  }

  if (utf8ByteLength(json) <= maxPayloadBytes) return json;

  // Fail-safe: if even the error payload is too large, return a minimal message.
  const minimal: ToolBridgeErrorResponse = {
    v: TOOL_BRIDGE_PROTOCOL_VERSION,
    ok: false,
    error: {
      name: 'ToolBridgeError',
      message: 'Tool bridge payload exceeded maximum size',
      code: 'TOOL_BRIDGE_PAYLOAD_TOO_LARGE',
    },
  };
  return JSON.stringify(minimal);
}

function parseToolBridgeRequest(
  requestJson: string,
): { ok: true; request: ToolBridgeRequest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return { ok: false, error: 'Tool request must be valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Tool request must be a JSON object' };
  }

  const v = (parsed as { v?: unknown }).v;
  const tool = (parsed as { tool?: unknown }).tool;
  const args = (parsed as { args?: unknown }).args;

  if (v !== TOOL_BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, error: 'Unsupported tool bridge protocol version' };
  }

  if (typeof tool !== 'string' || !tool) {
    return { ok: false, error: 'Tool name must be a non-empty string' };
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Tool arguments must be a JSON object' };
  }

  return { ok: true, request: { v: TOOL_BRIDGE_PROTOCOL_VERSION, tool, args: args as Record<string, unknown> } };
}

/**
 * Encode a tool call as a tool-bridge request.
 */
export function encodeToolBridgeRequest(tool: string, args: Record<string, unknown>): string {
  return safeJsonStringify({ v: TOOL_BRIDGE_PROTOCOL_VERSION, tool, args } satisfies ToolBridgeRequest);
}

/**
 * Decode a tool-bridge request into the tool name and arguments it carries.
 *
 * @returns The tool call, or the reason the request is malformed
 */
export function decodeToolBridgeRequest(
  requestJson: string,
): { ok: true; tool: string; args: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseToolBridgeRequest(requestJson);
  return parsed.ok ? { ok: true, tool: parsed.request.tool, args: parsed.request.args } : parsed;
}

/**
 * Encode a failure as a tool-bridge response (a refusal by the enclave, not a failure of the tool).
 */
export function encodeToolBridgeFailure(name: string, message: string, code: string, maxPayloadBytes: number): string {
  return serializeResponse(
    { v: TOOL_BRIDGE_PROTOCOL_VERSION, ok: false, error: { name, message, code } },
    maxPayloadBytes,
  );
}

/** Error message for an exceeded `maxToolCalls` (shared by every place that enforces it). */
export function toolCallLimitMessage(maxToolCalls: number): string {
  return `Maximum tool call limit exceeded (${maxToolCalls}). This limit prevents runaway script execution.`;
}

export interface HostToolBridgeOptions {
  /** Count the call in `stats.toolCallCount` here (false when the caller counted it already) */
  updateStats: boolean;
  /**
   * The caller counted the call AND checked it against `maxToolCalls` where the script made it,
   * and only passes on calls that were within the limit. The bridge then does not compare the
   * running count again: by the time it runs, calls made later in the same tick have been
   * counted too, and it would refuse a call that was within the limit when it was made.
   */
  limitChecked?: boolean;
}

/**
 * The tool bridge of an execution whose host is on another thread (see
 * `ExecutionContext.hostToolBridge`). The checks that depend on this thread's state run here: the
 * request size, the abort flag and the tool-call count. The request then goes to the host thread,
 * where the ordinary bridge runs the handler, resolves sidecar references and sanitizes the
 * result. A tool call is therefore treated the same wherever the sandbox runs.
 */
function createRelayedToolBridge(
  executionContext: ExecutionContext,
  options: HostToolBridgeOptions,
  relay: (requestJson: string) => Promise<string>,
): (requestJson: string) => Promise<string> {
  const { config, stats } = executionContext;
  const maxPayloadBytes = config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;

  return async (requestJson: string): Promise<string> => {
    try {
      if (typeof requestJson !== 'string') {
        return encodeToolBridgeFailure(
          'ToolBridgeError',
          'Tool request must be a string',
          'TOOL_BRIDGE_BAD_REQUEST',
          maxPayloadBytes,
        );
      }
      if (utf8ByteLength(requestJson) > maxPayloadBytes) {
        return encodeToolBridgeFailure(
          'ToolBridgeError',
          `Tool request exceeds maximum size (${maxPayloadBytes} bytes)`,
          'TOOL_BRIDGE_REQUEST_TOO_LARGE',
          maxPayloadBytes,
        );
      }
      if (executionContext.aborted) {
        return encodeToolBridgeFailure('AbortError', 'Execution aborted', 'EXECUTION_ABORTED', maxPayloadBytes);
      }
      if (options.updateStats) {
        stats.toolCallCount++;
      }
      if (!options.limitChecked && stats.toolCallCount > config.maxToolCalls) {
        return encodeToolBridgeFailure(
          'ToolLimitError',
          toolCallLimitMessage(config.maxToolCalls),
          'MAX_TOOL_CALLS_EXCEEDED',
          maxPayloadBytes,
        );
      }

      const responseJson = await relay(requestJson);
      if (typeof responseJson !== 'string' || utf8ByteLength(responseJson) > maxPayloadBytes) {
        return encodeToolBridgeFailure(
          'ToolBridgeError',
          `Tool response exceeds maximum size (${maxPayloadBytes} bytes)`,
          'TOOL_BRIDGE_RESPONSE_TOO_LARGE',
          maxPayloadBytes,
        );
      }
      return responseJson;
    } catch (error: unknown) {
      const safeError = toErrorPayload(error, 'ToolBridgeError', 'Tool bridge failure', 'TOOL_BRIDGE_FAILURE');
      return serializeResponse({ v: TOOL_BRIDGE_PROTOCOL_VERSION, ok: false, error: safeError }, maxPayloadBytes);
    }
  };
}

export function createHostToolBridge(
  executionContext: ExecutionContext,
  options: HostToolBridgeOptions,
): (requestJson: string) => Promise<string> {
  if (executionContext.toolResultOrder !== 'call') {
    return createUnorderedToolBridge(executionContext, options, false) as (requestJson: string) => Promise<string>;
  }
  const maxPayloadBytes = executionContext.config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;
  return inCallOrder(
    createUnorderedToolBridge(executionContext, options, true),
    executionContext.abortController.signal,
    {
      maxHeldBytes: maxPayloadBytes,
      failed: encodeToolBridgeFailure('ToolBridgeError', 'Tool bridge failure', 'TOOL_BRIDGE_FAILURE', maxPayloadBytes),
      overflow: encodeToolBridgeFailure(
        'ToolBridgeError',
        `Tool results waiting for their turn exceed ${maxPayloadBytes} bytes`,
        'TOOL_RESULTS_WAITING_TOO_LARGE',
        maxPayloadBytes,
      ),
    },
  );
}

function createUnorderedToolBridge(
  executionContext: ExecutionContext,
  options: HostToolBridgeOptions,
  deferSidecar: boolean,
): (requestJson: string) => Promise<BridgeReply> {
  if (typeof executionContext.hostToolBridge === 'function') {
    return createRelayedToolBridge(executionContext, options, executionContext.hostToolBridge);
  }

  const { config, stats, toolHandler, sidecar, referenceConfig } = executionContext;
  const maxPayloadBytes = config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;

  const resolver = sidecar && referenceConfig ? new ReferenceResolver(sidecar, referenceConfig) : undefined;

  return async (requestJson: string): Promise<BridgeReply> => {
    try {
      if (typeof requestJson !== 'string') {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolBridgeError',
              message: 'Tool request must be a string',
              code: 'TOOL_BRIDGE_BAD_REQUEST',
            },
          },
          maxPayloadBytes,
        );
      }

      if (utf8ByteLength(requestJson) > maxPayloadBytes) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolBridgeError',
              message: `Tool request exceeds maximum size (${maxPayloadBytes} bytes)`,
              code: 'TOOL_BRIDGE_REQUEST_TOO_LARGE',
            },
          },
          maxPayloadBytes,
        );
      }

      if (executionContext.aborted) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: { name: 'AbortError', message: 'Execution aborted', code: 'EXECUTION_ABORTED' },
          },
          maxPayloadBytes,
        );
      }

      if (options.updateStats) {
        stats.toolCallCount++;
      }

      if (!options.limitChecked && stats.toolCallCount > config.maxToolCalls) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolLimitError',
              message: toolCallLimitMessage(config.maxToolCalls),
              code: 'MAX_TOOL_CALLS_EXCEEDED',
            },
          },
          maxPayloadBytes,
        );
      }

      if (!toolHandler) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolBridgeError',
              message: 'No tool handler configured. Cannot execute tool calls.',
              code: 'NO_TOOL_HANDLER',
            },
          },
          maxPayloadBytes,
        );
      }

      const parsed = parseToolBridgeRequest(requestJson);
      if (!parsed.ok) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: { name: 'ToolBridgeError', message: parsed.error, code: 'TOOL_BRIDGE_BAD_REQUEST' },
          },
          maxPayloadBytes,
        );
      }

      const { tool, args } = parsed.request;

      // Sanitize tool args defensively (strip __proto__/constructor, enforce size limits).
      const sanitizedArgs = sanitizeValue(args, {
        maxDepth: config.maxSanitizeDepth,
        maxProperties: config.maxSanitizeProperties,
        allowDates: false,
        allowErrors: false,
      });

      if (!sanitizedArgs || typeof sanitizedArgs !== 'object' || Array.isArray(sanitizedArgs)) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: { name: 'TypeError', message: 'Tool arguments must be an object', code: 'INVALID_TOOL_ARGS' },
          },
          maxPayloadBytes,
        );
      }

      // Resolve sidecar references if present
      let resolvedArgs = sanitizedArgs as Record<string, unknown>;
      if (resolver && resolver.containsReferences(resolvedArgs)) {
        if (resolver.wouldExceedLimit(resolvedArgs)) {
          return serializeResponse(
            {
              v: TOOL_BRIDGE_PROTOCOL_VERSION,
              ok: false,
              error: {
                name: 'ToolBridgeError',
                message:
                  'Arguments would exceed maximum resolved size when references are expanded. Reduce the amount of data passed to the tool.',
                code: 'REFERENCE_RESOLUTION_LIMIT',
              },
            },
            maxPayloadBytes,
          );
        }

        try {
          resolvedArgs = resolver.resolve(resolvedArgs) as Record<string, unknown>;
        } catch (error: unknown) {
          if (error instanceof ResolutionLimitError) {
            return serializeResponse(
              {
                v: TOOL_BRIDGE_PROTOCOL_VERSION,
                ok: false,
                error: {
                  name: 'ToolBridgeError',
                  message: `Failed to resolve references in tool arguments: ${error.message}`,
                  code: 'REFERENCE_RESOLUTION_FAILED',
                },
              },
              maxPayloadBytes,
            );
          }

          const safeError = toErrorPayload(
            error,
            'ToolBridgeError',
            'Reference resolution failed',
            'REFERENCE_RESOLUTION_FAILED',
          );
          return serializeResponse(
            {
              v: TOOL_BRIDGE_PROTOCOL_VERSION,
              ok: false,
              error: safeError,
            },
            maxPayloadBytes,
          );
        }
      }

      // Execute tool handler and serialize the result (never throw into the sandbox realm).
      let result: unknown;
      try {
        result = await toolHandler(tool, resolvedArgs);
      } catch (error: unknown) {
        const safeError = toErrorPayload(error, 'ToolError', `Tool call failed: ${tool}`, 'TOOL_CALL_FAILED');
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: { ...safeError, toolError: true },
          },
          maxPayloadBytes,
        );
      }

      // Sanitize tool result to prevent function/symbol/prototype attacks.
      let sanitizedResult: unknown;
      try {
        sanitizedResult = sanitizeValue(result, {
          maxDepth: config.maxSanitizeDepth,
          maxProperties: config.maxSanitizeProperties,
          allowDates: false,
          allowErrors: true,
        });
      } catch (error: unknown) {
        const safeError = toErrorPayload(
          error,
          'ToolBridgeError',
          'Tool returned an unsupported value',
          'TOOL_RESULT_NOT_SAFE',
        );
        executionContext.onToolBridgeFailure?.();
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: { ...safeError, toolError: true },
          },
          maxPayloadBytes,
        );
      }

      // A host may impose a result limit below the bridge cap. Measure the sanitized copy:
      // JSON.stringify(Map) is "{}", while the copy delivered to the script can be large.
      const resultLimit = executionContext.maxToolResultBytes;
      if (resultLimit !== undefined && Number.isFinite(resultLimit) && resultLimit > 0) {
        let tooLarge = false;
        let tooComplex = false;
        try {
          const resultJson = stringifyWithin(sanitizedResult, resultLimit);
          tooLarge = resultJson !== undefined && utf8ByteLength(resultJson) > resultLimit;
        } catch (error: unknown) {
          tooLarge = error instanceof JsonTooLargeError;
          tooComplex = error instanceof JsonTraversalLimitError;
        }
        if (tooLarge || tooComplex) {
          executionContext.onToolBridgeFailure?.();
          return serializeResponse(
            {
              v: TOOL_BRIDGE_PROTOCOL_VERSION,
              ok: false,
              error: {
                name: 'ToolBridgeError',
                message: tooComplex
                  ? 'Tool result exceeds the traversal limit'
                  : `Tool result exceeds the limit of ${resultLimit} bytes`,
                code: tooComplex ? 'TOOL_RESULT_TOO_COMPLEX' : 'TOOL_RESULT_TOO_LARGE',
                toolError: true,
              },
            },
            maxPayloadBytes,
          );
        }
      }

      // In call order a large result is stored at its turn, so the order decides which call meets a full sidecar
      if (deferSidecar && typeof sanitizedResult === 'string' && referenceConfig) {
        const size = utf8ByteLength(sanitizedResult);
        const text = sanitizedResult;
        if (size >= referenceConfig.extractionThreshold) {
          return { bytes: size, finish: () => finishReply(executionContext, maxPayloadBytes, tool, text) };
        }
      }
      return finishReply(executionContext, maxPayloadBytes, tool, sanitizedResult);
    } catch (error: unknown) {
      const safeError = toErrorPayload(error, 'ToolBridgeError', 'Tool bridge failure', 'TOOL_BRIDGE_FAILURE');
      return serializeResponse(
        {
          v: TOOL_BRIDGE_PROTOCOL_VERSION,
          ok: false,
          error: safeError,
        },
        maxPayloadBytes,
      );
    }
  };
}
