import { hasHostStackReserve } from './stack-reserve';

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
        return construct(RealDate, arguments.length === 0 ? [readClock()] : arguments, new.target);
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

interface ReaderScope {
  inHostContext?: <R>(fn: () => R) => R;
  /** Whether the run has returned or was aborted: from then on nothing reads the host's clock */
  isOver: () => boolean;
}

/** The host's `clock` or `random` as the sandbox reads it: the value when the check passes, otherwise `undefined` */
function checkedReader(
  read: () => number,
  isValid: (value: number) => boolean,
  { inHostContext = (fn) => fn(), isOver }: ReaderScope,
): () => number | undefined {
  return () => {
    if (isOver() || !hasHostStackReserve()) return undefined;
    try {
      const value: unknown = inHostContext(read);
      if (typeof value === 'number') return isValid(value) ? value : undefined;
      if (typeof (value as PromiseLike<unknown> | null)?.then === 'function') {
        Promise.resolve(value).then(undefined, () => undefined);
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
}

/** The `clock` and `random` of an execution context, from the options of the enclave */
export function hostClockReaders(
  options: { clock?: () => number; random?: () => number },
  scope: ReaderScope,
): { clock?: () => number | undefined; random?: () => number | undefined } {
  return {
    clock: options.clock && checkedReader(options.clock, Number.isFinite, scope),
    random: options.random && checkedReader(options.random, (value) => value >= 0 && value < 1, scope),
  };
}

export const CLOCK_FAILED = 'The host clock failed';
export const RANDOM_FAILED = 'The host random source failed';
