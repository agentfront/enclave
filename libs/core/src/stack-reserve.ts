/**
 * Stack Reserve (host side)
 *
 * A script can recurse until the stack is nearly full and call into the host from there: a
 * function passed in `globals`, the console. Host code that starts with almost no stack left
 * does not fail cleanly. It fails wherever the stack happens to end, and that may be in the
 * middle of Node.js's own code: a write to `process.stdout` that is cut off after the stream has
 * marked itself as writing leaves the stream waiting forever, and nothing the host writes to it
 * afterwards comes out. A host function that is cut off after it has acted, while its result is
 * on the way back, has acted although the script is told that the call failed.
 *
 * "Almost no stack" is more than it sounds. V8 refuses to compile a function for its first call
 * when less than about 40 KB of stack is left (measured: 39.9 KB with Node.js 24, 46.4 KB with
 * Node.js 22). In that zone every function that has not run before throws a RangeError at its
 * call site, however little stack it would need itself.
 *
 * So code that the application supplied is not started with less than
 * {@link HOST_STACK_RESERVE_BYTES} left. The caller refuses the call instead, and the script gets
 * the RangeError it would have got a few frames later anyway. (The membrane keeps a reserve of
 * its own for the runtime's code, STACK_RESERVE_ARGUMENTS in ./double-vm/parent-vm-bootstrap;
 * this one is measured where the application's code begins, whatever lies in between.)
 *
 * What it does not cover, and why that is enough: a tool handler needs none (the bridge starts it
 * from a microtask, on an empty stack), and reading a property is not checked, but the validation
 * of `globals` refuses getters and proxies, so no code of the application runs on a read.
 *
 * @packageDocumentation
 */

// Captured at load: this runs while scripts do.
const ReflectApply = Reflect.apply;

/**
 * How much stack must be left before code supplied by the application is started, in bytes: the
 * zone in which the engine refuses to compile, and as much again for the code to run in.
 */
export const HOST_STACK_RESERVE_BYTES = 128 * 1024;

/** What a script is told when a call is refused for lack of stack: the engine's own wording */
export const STACK_EXHAUSTED_MESSAGE = 'Maximum call stack size exceeded';

// One argument takes one stack slot (8 bytes). Filled one by one so that the array stays a plain
// packed one, which the engine pushes without looking at each element.
const SLOTS: number[] = [];
for (let slot = 0; slot < HOST_STACK_RESERVE_BYTES / 8; slot++) {
  SLOTS[slot] = 0;
}

function nothing(): void {
  // The arguments are the measurement
}

/**
 * Whether at least {@link HOST_STACK_RESERVE_BYTES} of stack are left below the caller.
 *
 * The engine has to push every argument of a call before it makes the call, and checks first
 * that they fit: applying a function with that many arguments fails exactly when they do not.
 * JavaScript has no cheaper way to ask; this one takes about 5 microseconds.
 *
 * It can itself throw a RangeError when called with no stack left at all. Callers treat that as
 * "no".
 */
export function hasHostStackReserve(): boolean {
  try {
    ReflectApply(nothing, undefined, SLOTS);
    return true;
  } catch {
    return false;
  }
}
