/**
 * Event Filter
 *
 * Filters stream events based on configurable rules.
 *
 * @packageDocumentation
 */

import type {
  StreamEvent,
  EventType,
  EventFilterConfig,
  FilterRule,
  ContentPattern,
  ContentFilter,
} from '@enclavejs/types';
import { FilterMode, PatternType, DEFAULT_ALWAYS_ALLOW } from '@enclavejs/types';
import { minimatch } from 'minimatch';

/**
 * Event filter options.
 */
export interface EventFilterOptions {
  /**
   * Filter configuration.
   */
  config: EventFilterConfig;

  /**
   * Callback for filter errors (e.g., regex errors).
   */
  onError?: (error: Error, event: StreamEvent) => void;
}

/**
 * Compiled regex with metadata.
 */
interface CompiledRegex {
  regex: RegExp;
}

/**
 * Event Filter
 *
 * Provides efficient event filtering with:
 * - Type-based filtering
 * - Content pattern matching (exact, prefix, regex, glob)
 * - Compiled and cached regex patterns
 */
export class EventFilter {
  private readonly config: EventFilterConfig;
  private readonly alwaysAllow: Set<EventType>;
  private readonly compiledRegexes: Map<string, CompiledRegex>;
  private readonly onError?: (error: Error, event: StreamEvent) => void;

  constructor(options: EventFilterOptions) {
    this.config = options.config;
    this.onError = options.onError;
    this.alwaysAllow = new Set((options.config.alwaysAllow ?? DEFAULT_ALWAYS_ALLOW) as EventType[]);
    this.compiledRegexes = new Map();

    // Pre-compile all regex patterns
    this.compilePatterns();
  }

  /**
   * Check if an event should be sent to the client.
   */
  shouldSend(event: StreamEvent): boolean {
    // Always allow protected event types
    if (this.alwaysAllow.has(event.type)) {
      return true;
    }

    // Check if any rule matches
    const matches = this.matchesAnyRule(event);

    // Apply filter mode
    if (this.config.mode === FilterMode.Include) {
      // Whitelist: send only if matches
      return matches;
    } else {
      // Blacklist: send only if doesn't match
      return !matches;
    }
  }

  /**
   * Filter an array of events.
   */
  filter(events: StreamEvent[]): StreamEvent[] {
    return events.filter((event) => this.shouldSend(event));
  }

  /**
   * Check if event matches any filter rule.
   */
  private matchesAnyRule(event: StreamEvent): boolean {
    return this.config.rules.some((rule) => this.matchesRule(event, rule));
  }

  /**
   * Check if event matches a specific rule.
   */
  private matchesRule(event: StreamEvent, rule: FilterRule): boolean {
    // If both type and content filters exist, both must match
    const typeMatch = rule.types ? this.matchesTypeFilter(event, rule.types) : true;
    const contentMatch = rule.content ? this.matchesContentFilter(event, rule.content) : true;

    // If rule has both, require both to match
    if (rule.types && rule.content) {
      return typeMatch && contentMatch;
    }

    // If only one filter type, return its result
    return rule.types ? typeMatch : contentMatch;
  }

  /**
   * Check if event type matches filter.
   */
  private matchesTypeFilter(event: StreamEvent, filter: { types: EventType[] }): boolean {
    return filter.types.includes(event.type);
  }

  /**
   * Check if event content matches filter.
   */
  private matchesContentFilter(event: StreamEvent, filter: ContentFilter): boolean {
    const matchMode = filter.match ?? 'any';

    if (matchMode === 'all') {
      return filter.patterns.every((pattern) => this.matchesPattern(event, pattern));
    } else {
      return filter.patterns.some((pattern) => this.matchesPattern(event, pattern));
    }
  }

  /**
   * Check if event matches a content pattern.
   */
  private matchesPattern(event: StreamEvent, pattern: ContentPattern): boolean {
    // Get the value to match against
    const value = this.getFieldValue(event, pattern.field);
    if (value === undefined) {
      return false;
    }

    // Convert to string for matching
    const stringValue = this.stringify(value);
    const patternValue = pattern.caseInsensitive ? pattern.pattern.toLowerCase() : pattern.pattern;
    const matchValue = pattern.caseInsensitive ? stringValue.toLowerCase() : stringValue;

    try {
      switch (pattern.type) {
        case PatternType.Exact:
          return matchValue === patternValue;

        case PatternType.Prefix:
          return matchValue.startsWith(patternValue);

        case PatternType.Regex:
          return this.matchRegex(pattern.pattern, matchValue, pattern.caseInsensitive);

        case PatternType.Glob:
          return minimatch(matchValue, patternValue, {
            nocase: pattern.caseInsensitive,
          });

        default:
          return false;
      }
    } catch (error) {
      this.onError?.(error as Error, event);
      return false;
    }
  }

  /**
   * Get field value from event using dot notation.
   */
  private getFieldValue(event: StreamEvent, field?: string): unknown {
    if (!field) {
      // Default: stringify entire payload
      return event.payload;
    }

    const parts = field.split('.');
    let value: unknown = event;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      if (typeof value !== 'object') {
        return undefined;
      }
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }

  /**
   * Stringify a value for matching.
   */
  private stringify(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (value === null || value === undefined) {
      return '';
    }
    return JSON.stringify(value);
  }

  /**
   * Match against a compiled regex.
   */
  private matchRegex(pattern: string, value: string, caseInsensitive?: boolean): boolean {
    const cacheKey = `${pattern}:${caseInsensitive ? 'i' : ''}`;
    const compiled = this.compiledRegexes.get(cacheKey);

    if (!compiled) {
      // Pattern wasn't pre-compiled (shouldn't happen, but handle gracefully)
      const flags = caseInsensitive ? 'i' : '';
      return new RegExp(pattern, flags).test(value);
    }

    return compiled.regex.test(value);
  }

  /**
   * Pre-compile all regex patterns for efficiency.
   */
  private compilePatterns(): void {
    for (const rule of this.config.rules) {
      if (!rule.content?.patterns) continue;

      for (const pattern of rule.content.patterns) {
        if (pattern.type !== PatternType.Regex) continue;

        const cacheKey = `${pattern.pattern}:${pattern.caseInsensitive ? 'i' : ''}`;
        if (this.compiledRegexes.has(cacheKey)) continue;

        try {
          const flags = pattern.caseInsensitive ? 'i' : '';
          const regex = new RegExp(pattern.pattern, flags);
          this.compiledRegexes.set(cacheKey, { regex });
        } catch (error) {
          // Invalid regex - will be caught during matching
          console.error(`Invalid regex pattern: ${pattern.pattern}`, error);
        }
      }
    }
  }
}

/**
 * Create an event filter.
 */
export function createEventFilter(options: EventFilterOptions): EventFilter {
  return new EventFilter(options);
}

/**
 * Create a simple type-based filter.
 */
export function createTypeFilter(mode: 'include' | 'exclude', types: EventType[]): EventFilterConfig {
  return {
    mode: mode === 'include' ? FilterMode.Include : FilterMode.Exclude,
    rules: [{ types: { types } }],
  };
}

/**
 * Create a simple content filter.
 */
export function createContentFilter(
  mode: 'include' | 'exclude',
  pattern: string,
  patternType: (typeof PatternType)[keyof typeof PatternType] = PatternType.Regex,
): EventFilterConfig {
  return {
    mode: mode === 'include' ? FilterMode.Include : FilterMode.Exclude,
    rules: [
      {
        content: {
          patterns: [{ type: patternType, pattern }],
        },
      },
    ],
  };
}
