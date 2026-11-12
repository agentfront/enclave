/**
 * Execution Deadline: a script that only waits
 *
 * `timeout` stops a script that keeps the thread: `vm`'s own watchdog covers its synchronous
 * start, the cooperative check (./deadline-guard) everything it runs after its first `await`.
 * Neither stops a script that is simply WAITING. Nothing runs, so nothing looks at the clock:
 *
 * ```js
 * return { then: () => 0 };   // a thenable that never calls back
 * ```
 *
 * was enough to keep `run()` from ever settling, whatever `timeout` said. The adapter awaited the
 * script's promise, and the enclave's timer only set a flag for the script's next operation,
 * which never came. A tool call whose handler never settles did the same.
 *
 * So the host keeps count of what it has in flight for an execution (tool calls, async
 * functions passed in `globals`), and from the deadline on the execution ends, with the timeout
 * error, in one of two ways:
 *
 * - Nothing is in flight. Everything else a script can wait for is its own, and a sandbox has no
 *   timers and no I/O, so nothing can ever wake it. It ends once the script has had a moment
 *   ({@link IDLE_GRACE_MS}) to finish with what was delivered last.
 * - Something is in flight. Cutting it off would mean that a tool ran and the script was told it
 *   timed out, so its result is still delivered, but not for ever: `toolCallGraceMs` after the
 *   deadline the execution ends whatever is still in flight. The default is the length of the
 *   timeout itself, so `run()` takes at most twice `timeout`.
 *
 * The worker pool is left out: seen from the host's thread, a script that waits in a worker and
 * one that keeps its worker busy look the same, and the pool ends both itself.
 *
 * @packageDocumentation
 */

/**
 * How long a script gets, after the deadline, to finish with the result of the last host call
 * that was in flight. Within one thread that takes no time at all (promise jobs); the margin is
 * for an adapter of the application's that runs the script somewhere else.
 */
export const IDLE_GRACE_MS = 250;

/** The longest delay a timer takes; a longer wait is treated as this one */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What the host has in flight for one execution, and when that makes the execution over */
export interface HostActivity {
  /**
   * A host operation the script can wait for has started.
   *
   * @returns To be called once it has settled, either way (calling it again does nothing)
   */
  begin(): () => void;
  /** The deadline has passed: from now on the execution is over as described in the module */
  deadlinePassed(): void;
  /** Resolves, and never rejects, when the execution is over although its script has not settled */
  readonly over: Promise<void>;
  /** How many host operations are in flight right now */
  readonly inFlight: number;
  /** The execution has settled by itself: stop watching */
  close(): void;
  /**
   * Runs a callback of the host (a tool handler, a function from `globals`) in the async context
   * of the caller of `run()`. The script itself runs in another one (see ./async-context); where
   * this is absent the callback is called as it is.
   */
  inHostContext?<R>(fn: () => R): R;
}

/**
 * Create the tracker of one execution.
 *
 * @param inFlightGraceMs How long after the deadline a host call that is still in flight may
 *   take to deliver. 0 ends the execution at the deadline; Infinity waits for it however long.
 */
export function createHostActivity(inFlightGraceMs = Infinity): HostActivity {
  let inFlight = 0;
  let passed = false;
  let closed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let graceStarted = false;
  let announce: () => void = () => undefined;
  const over = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const stopIdle = (): void => {
    if (idle !== undefined) {
      clearTimeout(idle);
      idle = undefined;
    }
  };

  const checkIdle = (): void => {
    if (!passed || closed || inFlight > 0 || idle !== undefined) {
      return;
    }
    idle = setTimeout(() => {
      idle = undefined;
      if (!closed && inFlight === 0) {
        announce();
      }
    }, IDLE_GRACE_MS);
  };

  // What is in flight once the deadline has passed gets this long, counted once
  const startGrace = (): void => {
    if (graceStarted || closed || inFlight === 0 || inFlightGraceMs === Infinity) {
      return;
    }
    graceStarted = true;
    const wait = Number.isFinite(inFlightGraceMs) && inFlightGraceMs > 0 ? Math.min(inFlightGraceMs, MAX_TIMER_MS) : 0;
    grace = setTimeout(() => {
      grace = undefined;
      if (!closed) {
        announce();
      }
    }, wait);
  };

  return {
    begin(): () => void {
      inFlight++;
      // Something is in flight again: no verdict on an idle script yet
      stopIdle();
      if (passed) {
        // Only an adapter that does not refuse calls after the deadline gets here
        startGrace();
      }
      let ended = false;
      return () => {
        if (ended) {
          return;
        }
        ended = true;
        inFlight--;
        checkIdle();
      };
    },
    deadlinePassed(): void {
      if (passed) {
        return;
      }
      passed = true;
      startGrace();
      checkIdle();
    },
    over,
    get inFlight(): number {
      return inFlight;
    },
    close(): void {
      closed = true;
      stopIdle();
      if (grace !== undefined) {
        clearTimeout(grace);
        grace = undefined;
      }
    },
  };
}

/**
 * A tool handler that tells the tracker when a call starts and when it has settled.
 *
 * @param handler The host's tool handler
 * @param activity The tracker of the execution the handler is used for
 */
export function trackToolCalls<A extends unknown[], R>(
  handler: (...args: A) => Promise<R> | R,
  activity: HostActivity,
): (...args: A) => Promise<R> {
  return (...args: A): Promise<R> => {
    const end = activity.begin();
    let outcome: Promise<R> | R;
    try {
      outcome = activity.inHostContext ? activity.inHostContext(() => handler(...args)) : handler(...args);
    } catch (error: unknown) {
      end();
      return Promise.reject(error);
    }
    return Promise.resolve(outcome).then(
      (value) => {
        end();
        return value;
      },
      (error: unknown) => {
        end();
        throw error;
      },
    );
  };
}
