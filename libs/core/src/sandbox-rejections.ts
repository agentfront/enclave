/**
 * Sandbox Promise Rejections
 *
 * Node.js ends the process when a promise is rejected and nothing handles it (the default,
 * `--unhandled-rejections=throw`). The rule is the isolate's, so it covers the promises of a `vm`
 * context too: a script that calls an async function which throws and does not await it, or
 * leaves a failing tool call unawaited, would end the HOST process, after its own execution had
 * returned successfully.
 *
 * Nothing in a script can be made to handle its own promises, and the engine offers no way to
 * exempt a context. Node.js decides what to do with an unhandled rejection by emitting
 * `unhandledRejection` on `process` and looking at the answer, so that is where this module
 * stands: `process.emit` is wrapped, and
 *
 * - for a promise that is NOT of the host realm (a script's, or the sandbox runtime's), the two
 *   events `unhandledRejection` and `rejectionHandled` are answered here, with "handled", and go
 *   no further. The process goes on; no listener of the application sees the script's promise or
 *   its reason; Node.js prints no warning when the script handles the rejection late;
 * - everything else, the application's own rejections included, goes to the `emit` that was
 *   there before, untouched. What Node.js or the application does with those is what it did
 *   without this module, in every `--unhandled-rejections` mode.
 *
 * A reason is never read, formatted or passed on here. Formatting one with `util.inspect`, as a
 * log line or Node's printer for an uncaught error would, calls a method the value can supply
 * (`nodejs.util.inspect.custom`) with the host's own `inspect` function as an argument. (The
 * sandbox realms also refuse `Symbol.for` keys of that namespace: a second layer for every other
 * path on which host code might format a value of a script.)
 *
 * The wrapper is installed the first time a sandbox is used and stays: a script's promise can
 * be rejected long after its execution has ended (a tool call nobody awaited fails later).
 *
 * What it cannot do, and what a host should know:
 *
 * - under `--unhandled-rejections=strict` Node.js raises the exception before it emits anything,
 *   and under `=warn` it prints its warning before it emits;
 * - promises of any other realm are covered too, including those of `vm` contexts the
 *   application created itself: nobody is told about their unhandled rejections;
 * - a host that wants none of this calls {@link disableSandboxRejectionGuard}.
 *
 * @packageDocumentation
 */

// Captured at load: the wrapper runs long after scripts have run, and must not depend on
// anything that could have been replaced in the meantime.
const HostPromisePrototype: object = Promise.prototype;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;

/** How far up a prototype chain a promise is followed before it is taken for a foreign one */
const MAX_PROTOTYPE_CHAIN = 32;

/** How often the wrapper is put back before this module gives up on a process that removes it */
const MAX_INSTALLS = 8;

/**
 * Whether a promise is one of the host realm: made by the host's `Promise` or a subclass of it.
 *
 * The test is for the host, not for the sandbox, on purpose. A script can give its promise any
 * prototype it can reach (or none); what it cannot reach is the host's `Promise.prototype`, so it
 * cannot make its promise look like the application's.
 */
export function isHostPromise(promise: unknown): boolean {
  let current: unknown = promise;
  for (let depth = 0; depth < MAX_PROTOTYPE_CHAIN; depth++) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return false;
    }
    try {
      current = ObjectGetPrototypeOf(current);
    } catch {
      // A prototype behind a proxy whose trap throws: not the host's
      return false;
    }
    if (current === HostPromisePrototype) {
      return true;
    }
  }
  return false;
}

type Emit = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

/** Emitted by guardSandboxRejections to find out whether the wrapper is still part of `emit` */
const PROBE_EVENT = `enclave-vm:rejection-guard:${Math.random().toString(36).slice(2)}`;

let active = false;
let optedOut = false;
let installs = 0;
let probeAnswered = false;

/**
 * `process.emit` with the two rejection events answered for promises that are not the host's.
 *
 * @param previous The `emit` that was installed before this one: everything else goes to it
 */
function wrapEmit(previous: Emit): Emit {
  return function emit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === PROBE_EVENT) {
      probeAnswered = true;
      return false;
    }
    if (active) {
      // unhandledRejection(reason, promise); rejectionHandled(promise)
      if (event === 'unhandledRejection' && !isHostPromise(args[1])) {
        return true;
      }
      if (event === 'rejectionHandled' && !isHostPromise(args[0])) {
        return true;
      }
    }
    return ReflectApply(previous, this, [event, ...args]) as boolean;
  };
}

/**
 * Called by the sandbox adapters before a script runs: makes sure the wrapper is part of
 * `process.emit`, unless the host has opted out with {@link disableSandboxRejectionGuard}.
 *
 * Other code wraps `process.emit` as well, and some of it restores an older `emit` when it is
 * done, which would take this wrapper out again. So every call checks, with an event of its own
 * that only the wrapper answers, and puts the wrapper back if it is gone.
 */
export function guardSandboxRejections(): void {
  if (optedOut || typeof process === 'undefined' || typeof process.emit !== 'function') {
    return;
  }
  active = true;

  probeAnswered = false;
  try {
    (process.emit as unknown as Emit).call(process, PROBE_EVENT);
  } catch {
    // Another wrapper that does not like the event: treated as "not answered"
  }
  if (probeAnswered || installs >= MAX_INSTALLS) {
    return;
  }
  installs++;
  (process as unknown as { emit: Emit }).emit = wrapEmit(process.emit as unknown as Emit);
}

/**
 * For a host that wants to deal with every rejection itself: the wrapper lets everything through
 * and the adapters leave it at that (or, with `false`, undo this). Such a host has to ignore, in
 * its own `unhandledRejection` listener, the promises for which {@link isHostPromise} is false,
 * without touching their reason: it is a value of the script.
 *
 * @param disabled True to leave every rejection to Node.js and the host
 */
export function disableSandboxRejectionGuard(disabled = true): void {
  optedOut = disabled;
  if (disabled) {
    active = false;
  }
}
