/** Evaluated in a sandbox realm after its deadline check is installed: replaces its Date and Math.random with the host's */
export const REALM_CLOCK_SOURCE = `
(function () {
  'use strict';
  var RealDate = Date;
  var construct = Reflect.construct;
  var defineProperty = Object.defineProperty;
  var realm = globalThis;
  function hidden(target, key, value) {
    defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }
  return function installClock(readClock, readRandom) {
    if (readClock) {
      var ClockDate = function Date() {
        if (new.target === undefined) return String(new RealDate(readClock()));
        if (arguments.length === 0) return new RealDate(readClock());
        return construct(RealDate, arguments);
      };
      defineProperty(ClockDate, 'prototype', { value: RealDate.prototype, writable: false });
      hidden(ClockDate, 'now', function now() {
        return readClock();
      });
      hidden(ClockDate, 'parse', RealDate.parse);
      hidden(ClockDate, 'UTC', RealDate.UTC);
      hidden(RealDate.prototype, 'constructor', ClockDate);
      hidden(realm, 'Date', ClockDate);
    }
    if (readRandom) {
      hidden(Math, 'random', function random() {
        return readRandom();
      });
    }
  };
})()
`.trim();

/** The host's `clock` or `random` as the sandbox reads it: the value when the check passes, otherwise `undefined` */
function checkedReader(
  read: () => number,
  isValid: (value: number) => boolean,
  inHostContext: <R>(fn: () => R) => R,
): () => number | undefined {
  return () => {
    try {
      const value = inHostContext(read);
      return typeof value === 'number' && isValid(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The `clock` and `random` of an execution context, from the options of the enclave */
export function hostClockReaders(
  options: { clock?: () => number; random?: () => number },
  inHostContext: <R>(fn: () => R) => R = (fn) => fn(),
): { clock?: () => number | undefined; random?: () => number | undefined } {
  return {
    clock: options.clock && checkedReader(options.clock, Number.isFinite, inHostContext),
    random: options.random && checkedReader(options.random, (value) => value >= 0 && value < 1, inHostContext),
  };
}

export const CLOCK_FAILED = 'The host clock failed';
export const RANDOM_FAILED = 'The host random source failed';
