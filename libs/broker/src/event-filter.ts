/**
 * Event Filter
 *
 * Filters stream events based on configurable rules.
 *
 * Two properties hold for every filter, whatever its patterns and whatever the event:
 *
 * - Evaluating one event takes a bounded time. Patterns that can take long (regular expressions
 *   and globs) run under a time limit (`regexTimeoutMs`, 100 ms by default), and a filter can be
 *   given a budget for all of its evaluations together.
 * - An event the filter could not evaluate is not sent. In exclude mode a pattern that cannot
 *   be evaluated counts as matching; in include mode it counts as not matching.
 *
 * A filter decides what a client is sent, for the client's convenience. It is not a
 * confidentiality control: keep data that a client must not see out of the events.
 *
 * @packageDocumentation
 */

import { Script, createContext } from 'node:vm';
import type {
  StreamEvent,
  EventType,
  EventFilterConfig,
  FilterRule,
  ContentPattern,
  ContentFilter,
} from '@enclave-vm/types';
import { FilterMode, PatternType, DEFAULT_ALWAYS_ALLOW } from '@enclave-vm/types';
import { Minimatch } from 'minimatch';

/**
 * Time limit for the evaluation of one event when the configuration names none.
 */
const DEFAULT_EVALUATION_TIMEOUT_MS = 100;

/**
 * The longest time limit a configuration can ask for.
 */
const MAX_EVALUATION_TIMEOUT_MS = 10_000;

/**
 * How often the evaluation of one event is tried when the time limit was reached while the
 * evaluating thread got less than STARVED_CPU_SHARE of that time on a processor.
 */
const MAX_EVALUATION_ATTEMPTS = 5;
const STARVED_CPU_SHARE = 0.5;

/**
 * Processor time this thread has used, in milliseconds. A runtime that does not report it per
 * thread reports it for the process; that is never less, so an evaluation is never taken for
 * one that got too little processor time when it did not.
 */
function cpuTimeMs(): number {
  const perThread = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  const usage = typeof perThread === 'function' ? perThread.call(process) : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

/**
 * Event filter options.
 */
export interface EventFilterOptions {
  /**
   * Filter configuration.
   */
  config: EventFilterConfig;

  /**
   * Callback for filter errors (a pattern that could not be evaluated, an evaluation that ran
   * out of time).
   */
  onError?: (error: Error, event: StreamEvent) => void;

  /**
   * Total processor time, in milliseconds, this filter may spend evaluating regular
   * expressions and globs over its whole life. When it is used up, those patterns count as not
   * evaluable for every later event. Set it for a filter that lives as long as one stream and whose patterns
   * were not written by the embedder.
   *
   * @default no budget
   */
  budgetMs?: number;

  /**
   * Expand brace sets (`{a,b}`) and extended globs (`+(a|b)`) in glob patterns. When false,
   * those characters are matched as text.
   *
   * @default true
   */
  expandGlobs?: boolean;
}

/**
 * Outcome of matching one pattern or rule: yes, no, or (while slow patterns are being put
 * off) not known yet.
 */
type Match = boolean | undefined;

interface CompiledPattern {
  type: string;
  /** Path of the field to read, or undefined for the whole payload */
  path?: string[];
  /** Key of the field in the per-event cache */
  key: string;
  caseInsensitive: boolean;
  /** Pattern text for exact and prefix matching (lower-cased when case-insensitive) */
  text: string;
  /** Compiled regular expression; null when the pattern does not compile */
  regex?: RegExp | null;
  /** Compiled glob; null when the pattern does not compile */
  glob?: Minimatch | null;
  /** Source of the glob, to compile it again */
  source: string;
  /** The glob as a text wildcard (exclude mode only) */
  wildcard?: Wildcard;
}

interface CompiledRule {
  types?: Set<string>;
  patterns?: CompiledPattern[];
  matchAll: boolean;
}

/** A glob read as a wildcard over text: `*` is any run of characters, `?` any one character. */
type Wildcard = { contains: string } | { tokens: Array<string | typeof ANY | typeof ONE> };
const ANY = 0;
const ONE = 1;

/** The text of one field of an event, as patterns see it. */
interface Subject {
  /** undefined: the event has no such field */
  text?: string;
  lower?: string;
  /** The field exists and could not be turned into text */
  failed: boolean;
  /** Why it could not, until it has been reported */
  error?: Error;
}

// One realm for the time limit: the runtime can stop code that was started through it.
const boundedRealm: { run?: () => unknown } = {};
let boundedScript: Script | undefined;
let insideBounded = false;

/**
 * Run `fn` and stop it when it takes longer than `timeoutMs`.
 */
function runBounded<T>(fn: () => T, timeoutMs: number): { done: true; value: T } | { done: false } {
  if (insideBounded) {
    // Already under a time limit: the outer one applies.
    return { done: true, value: fn() };
  }
  if (!boundedScript) {
    createContext(boundedRealm);
    boundedScript = new Script('run()');
  }
  boundedRealm.run = fn;
  insideBounded = true;
  try {
    return { done: true, value: boundedScript.runInContext(boundedRealm, { timeout: timeoutMs }) as T };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { done: false };
    }
    throw error;
  } finally {
    insideBounded = false;
    boundedRealm.run = undefined;
  }
}

/**
 * Event Filter
 *
 * Provides event filtering with:
 * - Type-based filtering
 * - Content pattern matching (exact, prefix, regex, glob)
 * - Patterns compiled once per filter
 * - A time limit per evaluated event and an optional budget per filter
 */
export class EventFilter {
  private readonly exclude: boolean;
  private readonly alwaysAllow: Set<EventType>;
  private readonly rules: CompiledRule[];
  private readonly timeoutMs: number;
  private readonly budgetMs?: number;
  private readonly expandGlobs: boolean;
  private readonly onError?: (error: Error, event: StreamEvent) => void;
  private spentMs = 0;

  constructor(options: EventFilterOptions) {
    const config = options.config;
    if (typeof config !== 'object' || config === null || !Array.isArray(config.rules)) {
      throw new TypeError('EventFilter: the configuration needs a "rules" array');
    }

    this.onError = options.onError;
    this.exclude = config.mode !== FilterMode.Include;
    this.alwaysAllow = new Set((config.alwaysAllow ?? DEFAULT_ALWAYS_ALLOW) as EventType[]);
    this.expandGlobs = options.expandGlobs ?? true;

    const timeout = config.regexTimeoutMs;
    this.timeoutMs =
      typeof timeout === 'number' && timeout > 0
        ? Math.min(Math.max(Math.ceil(timeout), 1), MAX_EVALUATION_TIMEOUT_MS)
        : DEFAULT_EVALUATION_TIMEOUT_MS;

    const budget = options.budgetMs;
    this.budgetMs = typeof budget === 'number' && budget >= 0 ? budget : undefined;

    // Compile every pattern once
    this.rules = config.rules.map((rule) => this.compileRule(rule));
  }

  /**
   * Check if an event should be sent to the client.
   */
  shouldSend(event: StreamEvent): boolean {
    // Always allow protected event types
    if (this.alwaysAllow.has(event.type)) {
      return true;
    }

    const subjects = new Map<string, Subject>();
    const send = this.decide(event, subjects);

    if (this.onError) {
      for (const subject of subjects.values()) {
        if (subject.error) this.onError(subject.error, event);
      }
    }
    return send;
  }

  /**
   * Decide one event that is not always allowed.
   */
  private decide(event: StreamEvent, subjects: Map<string, Subject>): boolean {
    // First everything that is cheap: types, exact and prefix patterns. A rule that matches
    // on those alone decides the event without a slow pattern being run.
    let matches = this.matchesAnyRule(event, subjects, false);

    if (matches === undefined) {
      // The decision needs a regular expression or a glob: run them under the time limit.
      // Without time left, or when the evaluation does not finish, the event is not sent,
      // in either mode.
      if (this.budgetUsedUp()) {
        return false;
      }
      matches = this.evaluateWithinLimit(event, subjects);
      if (matches === undefined) {
        return false;
      }
    }

    // Include: send only what matches. Exclude: send only what does not match.
    return this.exclude ? !matches : matches;
  }

  /**
   * Filter an array of events.
   */
  filter(events: StreamEvent[]): StreamEvent[] {
    return events.filter((event) => this.shouldSend(event));
  }

  /**
   * Whether the budget of this filter is used up.
   */
  private budgetUsedUp(): boolean {
    return this.budgetMs !== undefined && this.spentMs >= this.budgetMs;
  }

  /**
   * Evaluate all rules, slow patterns included, under the time limit. Returns undefined when
   * the evaluation did not finish.
   *
   * The limit is a limit on elapsed time. When it is reached although the thread got little
   * processor time meanwhile (the machine was busy with something else), the evaluation is
   * tried again, a bounded number of times, so that a busy machine does not drop events. An
   * evaluation that used its time on a processor is not tried again.
   */
  private evaluateWithinLimit(event: StreamEvent, subjects: Map<string, Subject>): boolean | undefined {
    for (let attempt = 1; ; attempt++) {
      let limit = this.timeoutMs;
      if (this.budgetMs !== undefined) {
        limit = Math.max(1, Math.min(limit, Math.ceil(this.budgetMs - this.spentMs)));
      }

      const cpuBefore = cpuTimeMs();
      const outcome = runBounded(() => {
        const started = cpuTimeMs();
        const matches = this.matchesAnyRule(event, subjects, true) === true;
        return { matches, used: cpuTimeMs() - started };
      }, limit);

      if (outcome.done) {
        this.spentMs += outcome.value.used;
        return outcome.value.matches;
      }

      // The matchers were stopped in the middle of their work: build them again.
      this.recompileGlobs();

      const cpuMs = cpuTimeMs() - cpuBefore;
      const starved = cpuMs < limit * STARVED_CPU_SHARE;
      this.spentMs += starved ? cpuMs : limit;
      if (starved && attempt < MAX_EVALUATION_ATTEMPTS && !this.budgetUsedUp()) {
        continue;
      }

      this.onError?.(new Error('Event filter evaluation exceeded its time limit'), event);
      return undefined;
    }
  }

  /**
   * Check if event matches any filter rule. With `slow` false, patterns that need the time
   * limit are put off and the answer is undefined when it depends on one of them.
   */
  private matchesAnyRule(event: StreamEvent, subjects: Map<string, Subject>, slow: boolean): Match {
    let putOff = false;
    for (const rule of this.rules) {
      const match = this.matchesRule(event, rule, subjects, slow);
      if (match === true) return true;
      if (match === undefined) putOff = true;
    }
    return putOff ? undefined : false;
  }

  /**
   * Check if event matches a specific rule. If the rule has both a type filter and a content
   * filter, both must match.
   */
  private matchesRule(event: StreamEvent, rule: CompiledRule, subjects: Map<string, Subject>, slow: boolean): Match {
    if (rule.types && !rule.types.has(event.type)) {
      return false;
    }
    if (!rule.patterns) {
      return true;
    }

    let putOff = false;
    for (const pattern of rule.patterns) {
      const match = this.matchesPattern(event, pattern, subjects, slow);
      if (match === undefined) {
        putOff = true;
      } else if (match !== rule.matchAll) {
        // 'any': the first match decides. 'all': the first miss decides.
        return match;
      }
    }
    return putOff ? undefined : rule.matchAll;
  }

  /**
   * Check if event matches a content pattern.
   */
  private matchesPattern(
    event: StreamEvent,
    pattern: CompiledPattern,
    subjects: Map<string, Subject>,
    slow: boolean,
  ): Match {
    const subject = this.subjectOf(event, pattern, subjects);
    if (subject.failed) {
      return this.notEvaluable();
    }
    if (subject.text === undefined) {
      return false;
    }

    switch (pattern.type) {
      case PatternType.Exact:
        return this.textOf(subject, pattern) === pattern.text;

      case PatternType.Prefix:
        return this.textOf(subject, pattern).startsWith(pattern.text);

      case PatternType.Regex:
        if (!pattern.regex) return this.notEvaluable();
        if (!slow) return undefined;
        return pattern.regex.test(subject.text);

      case PatternType.Glob:
        if (!pattern.glob) return this.notEvaluable();
        if (!slow) return undefined;
        if (pattern.glob.match(subject.text)) return true;
        return pattern.wildcard ? matchesWildcard(this.textOf(subject, pattern), pattern.wildcard) : false;

      default:
        return this.notEvaluable();
    }
  }

  /**
   * What a pattern that cannot be evaluated counts as: a match when matching keeps an event
   * back (exclude), no match when matching lets it through (include).
   */
  private notEvaluable(): boolean {
    return this.exclude;
  }

  /**
   * The subject text in the case the pattern compares in.
   */
  private textOf(subject: Subject, pattern: CompiledPattern): string {
    if (!pattern.caseInsensitive) return subject.text as string;
    if (subject.lower === undefined) subject.lower = (subject.text as string).toLowerCase();
    return subject.lower;
  }

  /**
   * The text of the field a pattern reads, computed once per event.
   */
  private subjectOf(event: StreamEvent, pattern: CompiledPattern, subjects: Map<string, Subject>): Subject {
    let subject = subjects.get(pattern.key);
    if (subject) return subject;

    subject = { failed: false };
    const value = pattern.path ? readField(event, pattern.path) : event.payload;
    if (typeof value === 'string') {
      subject.text = value;
    } else if (value === null) {
      subject.text = '';
    } else if (value !== undefined) {
      try {
        subject.text = JSON.stringify(value) ?? '';
      } catch (error) {
        subject.failed = true;
        subject.error = error as Error;
      }
    }
    subjects.set(pattern.key, subject);
    return subject;
  }

  /**
   * Compile one rule.
   */
  private compileRule(rule: FilterRule): CompiledRule {
    const compiled: CompiledRule = { matchAll: false };
    if (typeof rule !== 'object' || rule === null) {
      throw new TypeError('EventFilter: a rule must be an object');
    }
    if (rule.types) {
      if (!Array.isArray(rule.types.types)) {
        throw new TypeError('EventFilter: a type filter needs a "types" array');
      }
      compiled.types = new Set(rule.types.types as string[]);
    }
    if (rule.content) {
      const content: ContentFilter = rule.content;
      if (!Array.isArray(content.patterns)) {
        throw new TypeError('EventFilter: a content filter needs a "patterns" array');
      }
      compiled.patterns = content.patterns.map((pattern) => this.compilePattern(pattern));
      compiled.matchAll = content.match === 'all';
    }
    return compiled;
  }

  /**
   * Compile a glob. Returns null when the pattern does not compile.
   */
  private compileGlob(source: string, caseInsensitive: boolean): Minimatch | null {
    try {
      return new Minimatch(source, {
        nocase: caseInsensitive,
        nobrace: !this.expandGlobs,
        noext: !this.expandGlobs,
        // An exclude glob is matched as text: also against a leading dot.
        dot: this.exclude,
      });
    } catch {
      return null;
    }
  }

  /**
   * Compile every glob of this filter again.
   */
  private recompileGlobs(): void {
    for (const rule of this.rules) {
      for (const pattern of rule.patterns ?? []) {
        if (pattern.glob) {
          pattern.glob = this.compileGlob(pattern.source, pattern.caseInsensitive);
        }
      }
    }
  }

  /**
   * Compile one content pattern. A pattern that does not compile is kept as "cannot be
   * evaluated"; its text is not logged.
   */
  private compilePattern(pattern: ContentPattern): CompiledPattern {
    if (typeof pattern !== 'object' || pattern === null || typeof pattern.pattern !== 'string') {
      throw new TypeError('EventFilter: a content pattern needs a "pattern" string');
    }
    const caseInsensitive = pattern.caseInsensitive === true;
    const field = typeof pattern.field === 'string' && pattern.field.length > 0 ? pattern.field : undefined;
    const compiled: CompiledPattern = {
      type: pattern.type,
      path: field?.split('.'),
      key: field ?? '',
      caseInsensitive,
      text: caseInsensitive ? pattern.pattern.toLowerCase() : pattern.pattern,
      source: pattern.pattern,
    };

    if (pattern.type === PatternType.Regex) {
      try {
        compiled.regex = new RegExp(pattern.pattern, caseInsensitive ? 'i' : '');
      } catch {
        compiled.regex = null;
      }
    } else if (pattern.type === PatternType.Glob) {
      compiled.glob = this.compileGlob(pattern.pattern, caseInsensitive);
      if (this.exclude) {
        // An exclude glob is matched as text: `*` also matches a path separator.
        compiled.wildcard = compileWildcard(compiled.text);
      }
    }

    return compiled;
  }
}

/**
 * Read a field of an event by path. Only own properties are followed.
 */
function readField(event: StreamEvent, path: string[]): unknown {
  let value: unknown = event;
  for (const part of path) {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Read a glob as a wildcard over text.
 */
function compileWildcard(pattern: string): Wildcard {
  const tokens: Array<string | typeof ANY | typeof ONE> = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (tokens[tokens.length - 1] !== ANY) tokens.push(ANY);
    } else if (char === '?') {
      tokens.push(ONE);
    } else if (char === '\\' && i + 1 < pattern.length) {
      tokens.push(pattern[++i] as string);
    } else {
      tokens.push(char);
    }
  }

  // `*text*` is a search for the text
  const inner = tokens.slice(1, -1);
  if (
    tokens.length >= 3 &&
    tokens[0] === ANY &&
    tokens[tokens.length - 1] === ANY &&
    inner.every((token) => typeof token === 'string')
  ) {
    return { contains: inner.join('') };
  }
  return { tokens };
}

/**
 * Match text against a wildcard.
 */
function matchesWildcard(text: string, wildcard: Wildcard): boolean {
  if ('contains' in wildcard) {
    return text.includes(wildcard.contains);
  }

  const tokens = wildcard.tokens;
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (p < tokens.length && (token === ONE || token === text[t])) {
      t++;
      p++;
    } else if (p < tokens.length && token === ANY) {
      star = p;
      mark = t;
      p++;
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p] === ANY) p++;
  return p === tokens.length;
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
