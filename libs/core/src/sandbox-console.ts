/**
 * Sandbox Console
 *
 * Builds the script's `console` INSIDE the sandbox realm on the single-VM and worker_threads paths, the way
 * `toolNamespaces` objects are built: a frozen, null-prototype object whose methods are realm-local functions. Each
 * method passes its arguments to the host's console writer, held in a closure, and turns an error the writer reports
 * into a realm error with the same name and message. Formatting, limits and output stay the host's.
 *
 * @packageDocumentation
 */

/** The host's console methods behind a sandbox console, by level. */
export type HostConsoleMethods = Readonly<Record<string, (...args: unknown[]) => void>>;

/** The host end of a sandbox console: `undefined`, or `name\nmessage` of the error the host method threw. */
export type HostConsoleWriter = (level: string, ...args: unknown[]) => string | undefined;

/** `install(write, levels)`, evaluated in the sandbox realm by {@link SANDBOX_CONSOLE_FACTORY_SOURCE}. */
export type InstallSandboxConsole = (write: HostConsoleWriter, levels: readonly string[]) => object;

/**
 * Source of an expression that, evaluated in a sandbox realm, captures that realm's own `Object` and `Error` (from
 * literals, so globals the realm shadows don't matter) and returns `install(write, levels)`.
 */
export const SANDBOX_CONSOLE_FACTORY_SOURCE = `
(function () {
  'use strict';
  var RealmObject = ({}).constructor;
  var getPrototypeOf = RealmObject.getPrototypeOf;
  var freeze = RealmObject.freeze;
  var RealmError = (function () {
    try {
      null.f;
    } catch (e) {
      return getPrototypeOf(getPrototypeOf(e)).constructor;
    }
  })();

  function method(write, level) {
    return (...args) => {
      var failure = write(level, ...args);
      if (typeof failure === 'string') {
        var separator = failure.indexOf('\\n');
        var error = new RealmError(failure.slice(separator + 1));
        error.name = failure.slice(0, separator);
        throw error;
      }
    };
  }

  return function install(write, levels) {
    var methods = { __proto__: null };
    for (var i = 0; i < levels.length; i++) {
      methods[levels[i]] = method(write, levels[i]);
    }
    return freeze(methods);
  };
})()
`.trim();

/**
 * The host end of a sandbox console over `methods`: runs the method for a level and reports an error the host throws
 * as `name\nmessage`. A value the script threw while its arguments were formatted is rethrown as it is.
 */
export function createHostConsoleWriter(methods: HostConsoleMethods): HostConsoleWriter {
  return (level, ...args) => {
    try {
      methods[level](...args);
      return undefined;
    } catch (error) {
      if (error instanceof Error) return `${error.name}\n${error.message}`;
      throw error;
    }
  };
}
