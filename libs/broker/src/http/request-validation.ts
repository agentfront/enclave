/**
 * Request validation
 *
 * What a request to the session routes must look like before any part of it is used. A request
 * body is data of the caller: every field is checked for its type and its range here, and what
 * is not a known field is not read at all.
 *
 * @packageDocumentation
 */

import type { SessionId } from '@enclave-vm/types';

/**
 * Outcome of a validation: the checked value, or the answer for the caller.
 */
export type Validated<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * The limits a request may ask for, as they arrived (checked, not yet bounded).
 */
export interface RequestedLimits {
  maxExecutionMs?: number;
  maxToolCalls?: number;
  heartbeatIntervalMs?: number;
}

/**
 * A checked body of `POST /sessions`.
 */
export interface ParsedCreateSessionRequest {
  code: string;
  sessionId?: SessionId;
  config: RequestedLimits;
}

/**
 * A session id a request may name: the prefix, then 1 to 128 characters that need no encoding
 * in a URL path or a header value.
 */
const SESSION_ID_PATTERN = /^s_[A-Za-z0-9._:~-]{1,128}$/;

/**
 * Whether a value is a session id a request may name.
 */
export function isRequestSessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

const invalid = (message: string, code = 'INVALID_REQUEST'): { ok: false; code: string; message: string } => ({
  ok: false,
  code,
  message,
});

/**
 * A plain JSON object: not null, not an array.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An own property of a JSON object; `null` counts as "not given".
 */
function field(object: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  return value === null ? undefined : value;
}

/**
 * A whole number above zero that a number can hold exactly.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const LIMIT_FIELDS = ['maxExecutionMs', 'maxToolCalls', 'heartbeatIntervalMs'] as const;

/**
 * Check the body of `POST /sessions`.
 */
export function parseCreateSessionRequest(body: unknown): Validated<ParsedCreateSessionRequest> {
  if (!isPlainObject(body)) {
    return invalid('Missing or invalid "code" field');
  }

  const code = field(body, 'code');
  if (typeof code !== 'string') {
    return invalid('Missing or invalid "code" field');
  }

  const sessionId = field(body, 'sessionId');
  if (sessionId !== undefined && !isRequestSessionId(sessionId)) {
    return invalid('Invalid "sessionId" field');
  }

  const config: RequestedLimits = {};
  const rawConfig = field(body, 'config');
  if (rawConfig !== undefined) {
    if (!isPlainObject(rawConfig)) {
      return invalid('Invalid "config" field: expected an object');
    }
    for (const key of LIMIT_FIELDS) {
      const value = field(rawConfig, key);
      if (value === undefined) continue;
      if (!isPositiveInteger(value)) {
        return invalid(`Invalid "config.${key}" field: expected a positive integer`);
      }
      config[key] = value;
    }
  }

  // This broker does not encrypt a session. A caller that requires encryption gets a refusal,
  // not a session in clear.
  const encryption = field(body, 'encryption');
  if (encryption !== undefined) {
    if (!isPlainObject(encryption)) {
      return invalid('Invalid "encryption" field: expected an object');
    }
    if (field(encryption, 'mode') === 'required') {
      return invalid('Encrypted sessions are not supported by this broker', 'ENCRYPTION_NOT_SUPPORTED');
    }
  }

  return { ok: true, value: { code, sessionId, config } };
}
