import type { ExecutionContext } from './types';
import { sanitizeValue } from './value-sanitizer';
import { ReferenceResolver, ResolutionLimitError } from './sidecar/reference-resolver';

const TOOL_BRIDGE_PROTOCOL_VERSION = 1 as const;

type ToolBridgeErrorPayload = {
  name: string;
  message: string;
  code?: string;
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

export function createHostToolBridge(
  executionContext: ExecutionContext,
  options: { updateStats: boolean },
): (requestJson: string) => Promise<string> {
  const { config, stats, toolHandler, sidecar, referenceConfig } = executionContext;
  const maxPayloadBytes = config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;

  const resolver = sidecar && referenceConfig ? new ReferenceResolver(sidecar, referenceConfig) : undefined;

  return async (requestJson: string): Promise<string> => {
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

      if (stats.toolCallCount > config.maxToolCalls) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolLimitError',
              message: `Maximum tool call limit exceeded (${config.maxToolCalls}). This limit prevents runaway script execution.`,
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
            error: safeError,
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
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: safeError,
          },
          maxPayloadBytes,
        );
      }

      // Lift large string results to sidecar if configured
      if (sidecar && referenceConfig && typeof sanitizedResult === 'string') {
        const size = utf8ByteLength(sanitizedResult);
        if (size >= referenceConfig.extractionThreshold) {
          try {
            const refId = sidecar.store(sanitizedResult, 'tool-result', { origin: tool });
            sanitizedResult = refId;
          } catch {
            // If storage fails (limits), keep original value and fall through.
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
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: safeError,
          },
          maxPayloadBytes,
        );
      }

      if (utf8ByteLength(okJson) > maxPayloadBytes) {
        return serializeResponse(
          {
            v: TOOL_BRIDGE_PROTOCOL_VERSION,
            ok: false,
            error: {
              name: 'ToolBridgeError',
              message: `Tool response exceeds maximum size (${maxPayloadBytes} bytes)`,
              code: 'TOOL_BRIDGE_RESPONSE_TOO_LARGE',
            },
          },
          maxPayloadBytes,
        );
      }

      return okJson;
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
