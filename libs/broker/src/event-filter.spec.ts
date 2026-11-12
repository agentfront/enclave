/**
 * Glob content patterns of the event filter (`PatternType.Glob`).
 *
 * The filter hands the value of a field and the pattern to `minimatch`, so these cases pin what a
 * host can rely on whichever version of that library is installed.
 */

import { EventType, FilterMode, PatternType, PROTOCOL_VERSION, generateSessionId } from '@enclave-vm/types';
import type { EventFilterConfig, StreamEvent } from '@enclave-vm/types';
import { EventFilter, createContentFilter } from './event-filter';

const sessionId = generateSessionId();

function toolCall(toolName: string): StreamEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq: 1,
    type: EventType.ToolCall,
    payload: { callId: 'c_1' as never, toolName, args: {} },
  } as StreamEvent;
}

function log(message: string): StreamEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq: 2,
    type: EventType.Log,
    payload: { level: 'info', message },
  } as StreamEvent;
}

function globOn(field: string, pattern: string, caseInsensitive?: boolean): EventFilterConfig {
  return {
    mode: FilterMode.Include,
    rules: [{ content: { patterns: [{ type: PatternType.Glob, pattern, field, caseInsensitive }] } }],
  };
}

describe('EventFilter glob patterns', () => {
  it.each([
    ['a star matches the rest of a name', 'users:*', 'users:list', true],
    ['a star does not match another name', 'orders:*', 'users:list', false],
    ['a question mark matches one character', 'users:lis?', 'users:list', true],
    ['braces list alternatives', '{users,orders}:list', 'orders:list', true],
    ['a star stops at a slash', 'files/*', 'files/a/b', false],
    ['a double star crosses slashes', 'files/**', 'files/a/b', true],
    ['a pattern without magic is an exact match', 'users:list', 'users:list', true],
    ['a leading ! negates the pattern', '!users:list', 'orders:list', true],
  ])('%s', (_name, pattern, toolName, expected) => {
    const filter = new EventFilter({ config: globOn('payload.toolName', pattern) });

    expect(filter.shouldSend(toolCall(toolName))).toBe(expected);
  });

  it('is case sensitive unless caseInsensitive is set', () => {
    const sensitive = new EventFilter({ config: globOn('payload.toolName', 'USERS:*') });
    const insensitive = new EventFilter({ config: globOn('payload.toolName', 'USERS:*', true) });

    expect(sensitive.shouldSend(toolCall('users:list'))).toBe(false);
    expect(insensitive.shouldSend(toolCall('users:list'))).toBe(true);
  });

  it('matches text with spaces and brackets as data', () => {
    const filter = new EventFilter({ config: globOn('payload.message', '[[]error[]]*') });

    expect(filter.shouldSend(log('[error] disk full'))).toBe(true);
    expect(filter.shouldSend(log('[info] started'))).toBe(false);
  });

  it('matches the JSON text of the payload when no field is named', () => {
    const filter = new EventFilter({ config: createContentFilter('include', '*disk full*', PatternType.Glob) });

    expect(filter.shouldSend(log('disk full'))).toBe(true);
    expect(filter.shouldSend(log('all good'))).toBe(false);
  });

  it('drops the events a glob matches in exclude mode', () => {
    const filter = new EventFilter({ config: createContentFilter('exclude', '*secret*', PatternType.Glob) });
    const events = [log('public note'), log('the secret value')];

    expect(filter.filter(events)).toEqual([events[0]]);
  });

  it('does not match a field the event does not have', () => {
    const filter = new EventFilter({ config: globOn('payload.missing', '*') });

    expect(filter.shouldSend(toolCall('users:list'))).toBe(false);
  });

  it('lets the always-allowed events through whatever the pattern', () => {
    const filter = new EventFilter({ config: globOn('payload.toolName', 'nothing-matches-this') });
    const final = { ...toolCall('users:list'), type: EventType.Final } as StreamEvent;

    expect(filter.shouldSend(final)).toBe(true);
  });
});
