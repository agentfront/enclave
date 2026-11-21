/**
 * Routes a script's console calls to a host `consoleHandler` instead of the host console.
 *
 * @packageDocumentation
 */

import { hasHostStackReserve } from './stack-reserve';

/** A console method a script can call. */
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * Receives each console call of a script as its level and formatted line. Its return value is
 * ignored and anything it throws or rejects with is swallowed.
 *
 * It is not called for a console call a script makes with the stack nearly full (less than
 * HOST_STACK_RESERVE_BYTES left, see ./stack-reserve): that line is dropped. A handler that
 * started there would be cut off wherever the stack ends, which for one that writes to
 * `process.stdout` leaves the stream unusable for the rest of the process.
 */
export type ConsoleHandler = (level: ConsoleLevel, message: string) => void;

export interface ConsoleLimits {
  maxConsoleCalls: number;
  maxConsoleOutputBytes: number;
}

const CONSOLE_LEVELS: ReadonlySet<unknown> = new Set<ConsoleLevel>(['log', 'info', 'warn', 'error', 'debug']);

const ignoreRejection = (): undefined => undefined;

/**
 * Host end of the sandbox console for one execution: accepts only a known level and a string,
 * re-applies the limits, and never returns a value or throws.
 */
export function createConsoleSink(
  handler: ConsoleHandler,
  limits: ConsoleLimits,
): (level: unknown, message: unknown) => void {
  let callCount = 0;
  let totalLength = 0;

  return (level: unknown, message: unknown): void => {
    if (!CONSOLE_LEVELS.has(level) || typeof message !== 'string') return;
    callCount++;
    totalLength += message.length;
    if (callCount > limits.maxConsoleCalls || totalLength > limits.maxConsoleOutputBytes) return;
    try {
      if (!hasHostStackReserve()) return;
      Promise.resolve(handler(level as ConsoleLevel, message)).catch(ignoreRejection);
    } catch {
      // The handler's errors never reach the script.
    }
  };
}

/**
 * Evaluated in a sandbox realm, returns `install(write, maxCalls, maxBytes)`, which builds the
 * script's console there: a frozen, null-prototype object whose realm-local methods format their
 * arguments, enforce the limits with realm errors, then call `write(level, line)` and discard its
 * result and errors.
 */
export const CONSOLE_FACTORY_SOURCE = `
(function () {
  'use strict';
  var stringify = JSON.stringify;
  // The realm's own String, even where a sandbox global shadows it.
  var toText = ''.constructor;
  var freeze = Object.freeze;
  var RealmError = Error;
  var apply = Reflect.apply;
  var isArray = Array.isArray;
  var stringValueOf = ''.constructor.prototype.valueOf;
  var numberValueOf = (0).constructor.prototype.valueOf;

  // Whether a value has the internal slot that a built-in's valueOf reads.
  function hasSlot(valueOf, value) {
    try {
      apply(valueOf, value, []);
      return true;
    } catch (e) {
      return false;
    }
  }

  // The JSON text of a value, given up as soon as it would be longer than limit characters. A
  // value referenced many times is written as many times, so the text can be far longer than the
  // value is large. What each member adds is counted as JSON.stringify writes it, and the count
  // is a lower bound of its length (an escape only adds), so a text within the limit is never
  // given up. The members JSON.stringify visits are counted as well, also those it leaves out (a
  // function, undefined): at most as many as the limit has characters.
  var TOO_LARGE = {};
  function stringifyWithin(value, limit) {
    var length = 0;
    var visits = 0;
    var root = true;
    return stringify(value, function (key, member) {
      if (++visits > limit) throw TOO_LARGE;
      // A String or Number object is written as what it converts to; converted here, the way
      // JSON.stringify converts it and once, so the count is of what is written.
      if (member !== null && typeof member === 'object') {
        if (hasSlot(stringValueOf, member)) member = toText(member);
        else if (hasSlot(numberValueOf, member)) member = +member;
      }
      var added;
      var kind = typeof member;
      if (kind === 'string') added = member.length + 2;
      else if (kind === 'number') added = member - member === 0 ? ('' + member).length : 4;
      else if (kind === 'boolean') added = member ? 4 : 5;
      else if (kind === 'object' || kind === 'bigint') added = member === null ? 4 : 2;
      else added = 0;
      if (!root) {
        // An element of an array is written, as null if nothing else; a member of an object
        // that is written has its key in front of it.
        if (isArray(this)) added = added || 4;
        else if (added > 0) added += key.length + 3;
      }
      root = false;
      length += added;
      if (length > limit) throw TOO_LARGE;
      return member;
    });
  }

  // An argument as it is written in the line, in at most room characters for an object: an
  // object is written only when the line has room left, and its text within that room. TOO_LARGE
  // when it does not fit.
  function formatArgument(value, room) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'object') {
      if (room <= 0) throw TOO_LARGE;
      try {
        var json = stringifyWithin(value, room);
        return json === undefined ? '' : json;
      } catch (e) {
        if (e === TOO_LARGE) throw e;
        return toText(value);
      }
    }
    return toText(value);
  }

  return function install(write, maxCalls, maxBytes) {
    var callCount = 0;
    var totalBytes = 0;

    function tooLarge() {
      return new RealmError('Console output size limit exceeded (max: ' + maxBytes + ' bytes). This limit prevents I/O flood attacks.');
    }

    function method(level) {
      return (...args) => {
        callCount++;
        if (callCount > maxCalls) {
          throw new RealmError('Console call limit exceeded (max: ' + maxCalls + '). This limit prevents I/O flood attacks.');
        }
        // The line is measured as it is built: what an argument may add is the room the limit
        // leaves, so the work done on a line that does not fit is in proportion to the limit.
        var line = '';
        for (var i = 0; i < args.length; i++) {
          var separator = i === 0 ? '' : ' ';
          var text;
          try {
            text = formatArgument(args[i], maxBytes - totalBytes - line.length - separator.length);
          } catch (e) {
            if (e !== TOO_LARGE) throw e;
            totalBytes = maxBytes + 1;
            throw tooLarge();
          }
          line += separator + text;
          if (totalBytes + line.length > maxBytes) {
            totalBytes = maxBytes + 1;
            throw tooLarge();
          }
        }
        totalBytes += line.length;
        if (totalBytes > maxBytes) {
          throw tooLarge();
        }
        try {
          write(level, line);
        } catch (e) {}
      };
    }

    return freeze({
      __proto__: null,
      log: method('log'),
      info: method('info'),
      warn: method('warn'),
      error: method('error'),
      debug: method('debug')
    });
  };
})()
`.trim();
