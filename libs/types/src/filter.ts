/**
 * @enclave-vm/types - Event filter definitions
 *
 * Types for server-side event filtering configuration.
 *
 * @packageDocumentation
 */

import type { EventType } from './events.js';

/**
 * Filter mode - how filters should be applied.
 */
export const FilterMode = {
  /** Include only events matching the filter (whitelist) */
  Include: 'include',
  /** Exclude events matching the filter (blacklist) */
  Exclude: 'exclude',
} as const;

export type FilterMode = (typeof FilterMode)[keyof typeof FilterMode];

/**
 * Pattern type for content matching.
 */
export const PatternType = {
  /** Exact string match */
  Exact: 'exact',
  /** Prefix match (startsWith) */
  Prefix: 'prefix',
  /** Regular expression */
  Regex: 'regex',
  /** Glob pattern (supports * and **) */
  Glob: 'glob',
} as const;

export type PatternType = (typeof PatternType)[keyof typeof PatternType];

/**
 * Content pattern for payload filtering.
 */
export interface ContentPattern {
  /** Pattern type */
  type: PatternType;
  /** Pattern value */
  pattern: string;
  /** Field path to match against (dot notation, e.g., "payload.message") */
  field?: string;
  /** Case insensitive matching (default: false) */
  caseInsensitive?: boolean;
}

/**
 * Type-based filter rule.
 */
export interface TypeFilter {
  /** Event types to match */
  types: EventType[];
}

/**
 * Content-based filter rule.
 */
export interface ContentFilter {
  /** Content patterns to match */
  patterns: ContentPattern[];
  /** Match mode: 'any' (OR) or 'all' (AND). Default: 'any' */
  match?: 'any' | 'all';
}

/**
 * Combined filter rule.
 * If both types and content are specified, both must match (AND).
 * Multiple rules are combined with OR.
 */
export interface FilterRule {
  /** Type-based filter (optional) */
  types?: TypeFilter;
  /** Content-based filter (optional) */
  content?: ContentFilter;
}

/**
 * Complete event filter configuration.
 */
export interface EventFilterConfig {
  /** Filter mode: include (whitelist) or exclude (blacklist) */
  mode: FilterMode;
  /** Filter rules - multiple rules are combined with OR */
  rules: FilterRule[];
  /**
   * Events that should always be sent regardless of filter.
   * Default: ['session_init', 'final']
   */
  alwaysAllow?: EventType[];
  /**
   * Maximum regex execution time in milliseconds.
   * Default: 100
   */
  regexTimeoutMs?: number;
}

/**
 * Default events that bypass filtering.
 */
export const DEFAULT_ALWAYS_ALLOW: EventType[] = ['session_init', 'final'];
