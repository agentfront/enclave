/**
 * Routes a script's console calls to a host `consoleHandler` instead of the host console.
 *
 * @packageDocumentation
 */

/** A console method a script can call. */
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * Receives each console call of a script as its level and formatted line. Its return value is
 * ignored and anything it throws or rejects with is swallowed.
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

  function formatArgument(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'object') {
      try {
        var json = stringify(value);
        return json === undefined ? '' : json;
      } catch (e) {
        return toText(value);
      }
    }
    return toText(value);
  }

  return function install(write, maxCalls, maxBytes) {
    var callCount = 0;
    var totalBytes = 0;

    function method(level) {
      return (...args) => {
        callCount++;
        if (callCount > maxCalls) {
          throw new RealmError('Console call limit exceeded (max: ' + maxCalls + '). This limit prevents I/O flood attacks.');
        }
        var line = '';
        for (var i = 0; i < args.length; i++) {
          line += (i === 0 ? '' : ' ') + formatArgument(args[i]);
        }
        totalBytes += line.length;
        if (totalBytes > maxBytes) {
          throw new RealmError('Console output size limit exceeded (max: ' + maxBytes + ' bytes). This limit prevents I/O flood attacks.');
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
