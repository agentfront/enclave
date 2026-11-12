/**
 * Request validation
 *
 * What a request to the session routes must look like before any part of it is used. A request
 * body is data of the caller: every field is checked for its type and its range here, and what
 * is not a known field is not read at all.
 *
 * @packageDocumentation
 */

import type { SessionId, EventFilterConfig, FilterRule, ContentPattern, EventType } from '@enclave-vm/types';
import { FilterMode, PatternType } from '@enclave-vm/types';

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
  filter?: EventFilterConfig;
}

/**
 * Bounds of an event filter that arrives in a request. They keep the work a filter can cause
 * per event small; an embedder that builds a filter in process is not bound by them.
 */
export const REQUEST_FILTER_LIMITS = {
  /** Rules per filter */
  maxRules: 16,
  /** Content patterns per filter, over all rules */
  maxPatterns: 32,
  /** Characters per pattern */
  maxPatternLength: 256,
  /** Characters per field path */
  maxFieldLength: 128,
  /** Event types per type filter and per always-allow list */
  maxTypes: 32,
  /** Characters per event type */
  maxTypeLength: 64,
  /** Characters of the JSON text in the `filter` query parameter */
  maxQueryLength: 8192,
  /** Time limit for the evaluation of one event, in milliseconds */
  evaluationTimeoutMs: 50,
  /** Time all evaluations of one filter may take together, in milliseconds */
  budgetMs: 250,
} as const;

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

  let filter: EventFilterConfig | undefined;
  const rawFilter = field(body, 'filter');
  if (rawFilter !== undefined) {
    const parsedFilter = parseFilterConfig(rawFilter);
    if (!parsedFilter.ok) return parsedFilter;
    filter = parsedFilter.value;
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

  return { ok: true, value: { code, sessionId, config, filter } };
}

const invalidFilter = (message: string): { ok: false; code: string; message: string } =>
  invalid(`Invalid filter configuration: ${message}`, 'INVALID_FILTER');

const PATTERN_TYPES: readonly string[] = Object.values(PatternType);

/**
 * A list of event type names within the bounds.
 */
function parseTypeList(value: unknown): EventType[] | undefined {
  if (!Array.isArray(value) || value.length > REQUEST_FILTER_LIMITS.maxTypes) return undefined;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > REQUEST_FILTER_LIMITS.maxTypeLength) {
      return undefined;
    }
  }
  return [...value] as EventType[];
}

/**
 * Check an event filter that arrived in a request and copy it. The copy holds the known fields
 * only, each within the bounds of REQUEST_FILTER_LIMITS, and its time limit is the request
 * limit or lower.
 */
export function parseFilterConfig(value: unknown): Validated<EventFilterConfig> {
  if (!isPlainObject(value)) {
    return invalidFilter('expected an object');
  }

  const mode = field(value, 'mode');
  if (mode !== FilterMode.Include && mode !== FilterMode.Exclude) {
    return invalidFilter('"mode" must be "include" or "exclude"');
  }

  const rawRules = field(value, 'rules');
  if (!Array.isArray(rawRules) || rawRules.length > REQUEST_FILTER_LIMITS.maxRules) {
    return invalidFilter(`"rules" must be a list of at most ${REQUEST_FILTER_LIMITS.maxRules} rules`);
  }

  const rules: FilterRule[] = [];
  let patternCount = 0;
  for (const rawRule of rawRules) {
    if (!isPlainObject(rawRule)) {
      return invalidFilter('a rule must be an object');
    }
    const rule: FilterRule = {};

    const rawTypes = field(rawRule, 'types');
    if (rawTypes !== undefined) {
      const types = isPlainObject(rawTypes) ? parseTypeList(field(rawTypes, 'types')) : undefined;
      if (!types) {
        return invalidFilter(`"types" must hold a list of at most ${REQUEST_FILTER_LIMITS.maxTypes} event types`);
      }
      rule.types = { types };
    }

    const rawContent = field(rawRule, 'content');
    if (rawContent !== undefined) {
      if (!isPlainObject(rawContent)) {
        return invalidFilter('"content" must be an object');
      }
      const rawPatterns = field(rawContent, 'patterns');
      if (!Array.isArray(rawPatterns)) {
        return invalidFilter('"content.patterns" must be a list');
      }
      patternCount += rawPatterns.length;
      if (patternCount > REQUEST_FILTER_LIMITS.maxPatterns) {
        return invalidFilter(`a filter may hold at most ${REQUEST_FILTER_LIMITS.maxPatterns} patterns`);
      }
      const patterns: ContentPattern[] = [];
      for (const rawPattern of rawPatterns) {
        const pattern = parseContentPattern(rawPattern);
        if (!pattern.ok) return pattern;
        patterns.push(pattern.value);
      }
      const match = field(rawContent, 'match');
      if (match !== undefined && match !== 'any' && match !== 'all') {
        return invalidFilter('"content.match" must be "any" or "all"');
      }
      rule.content = match === undefined ? { patterns } : { patterns, match };
    }

    rules.push(rule);
  }

  const config: EventFilterConfig = { mode, rules, regexTimeoutMs: REQUEST_FILTER_LIMITS.evaluationTimeoutMs };

  const rawAlwaysAllow = field(value, 'alwaysAllow');
  if (rawAlwaysAllow !== undefined) {
    const alwaysAllow = parseTypeList(rawAlwaysAllow);
    if (!alwaysAllow) {
      return invalidFilter(`"alwaysAllow" must be a list of at most ${REQUEST_FILTER_LIMITS.maxTypes} event types`);
    }
    config.alwaysAllow = alwaysAllow;
  }

  const rawTimeout = field(value, 'regexTimeoutMs');
  if (rawTimeout !== undefined) {
    if (!isPositiveInteger(rawTimeout)) {
      return invalidFilter('"regexTimeoutMs" must be a positive integer');
    }
    config.regexTimeoutMs = Math.min(rawTimeout, REQUEST_FILTER_LIMITS.evaluationTimeoutMs);
  }

  return { ok: true, value: config };
}

/**
 * Check one content pattern of a filter that arrived in a request.
 */
function parseContentPattern(value: unknown): Validated<ContentPattern> {
  if (!isPlainObject(value)) {
    return invalidFilter('a pattern must be an object');
  }

  const type = field(value, 'type');
  if (typeof type !== 'string' || !PATTERN_TYPES.includes(type)) {
    return invalidFilter('"type" of a pattern must be "exact", "prefix", "regex" or "glob"');
  }

  const text = field(value, 'pattern');
  if (typeof text !== 'string' || text.length > REQUEST_FILTER_LIMITS.maxPatternLength) {
    return invalidFilter(`"pattern" must be a string of at most ${REQUEST_FILTER_LIMITS.maxPatternLength} characters`);
  }

  const pattern: ContentPattern = { type: type as ContentPattern['type'], pattern: text };

  const path = field(value, 'field');
  if (path !== undefined) {
    if (typeof path !== 'string' || path.length === 0 || path.length > REQUEST_FILTER_LIMITS.maxFieldLength) {
      return invalidFilter(`"field" must be a string of at most ${REQUEST_FILTER_LIMITS.maxFieldLength} characters`);
    }
    pattern.field = path;
  }

  const caseInsensitive = field(value, 'caseInsensitive');
  if (caseInsensitive !== undefined) {
    if (typeof caseInsensitive !== 'boolean') {
      return invalidFilter('"caseInsensitive" must be a boolean');
    }
    pattern.caseInsensitive = caseInsensitive;
  }

  if (type === PatternType.Regex) {
    try {
      new RegExp(text, pattern.caseInsensitive ? 'i' : '');
    } catch {
      return invalidFilter('a "regex" pattern must be a valid regular expression');
    }
  }

  return { ok: true, value: pattern };
}

/**
 * Check the `filter` query parameter of the stream route: JSON text of a filter.
 */
export function parseFilterParameter(value: unknown): Validated<EventFilterConfig> {
  if (typeof value !== 'string' || value.length > REQUEST_FILTER_LIMITS.maxQueryLength) {
    return invalidFilter(`expected JSON text of at most ${REQUEST_FILTER_LIMITS.maxQueryLength} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidFilter('expected JSON text');
  }
  return parseFilterConfig(parsed);
}
