/**
 * Safe Error Utilities
 *
 * SECURITY: Any Error object created in the host realm and exposed to sandbox code
 * must not allow reaching the host Function constructor via prototype-chain walks.
 *
 * Threat model:
 * - Sandbox code can intentionally trigger host-side failures (e.g. tool calls, proxy traps)
 * - If a host Error crosses the boundary, attackers can climb:
 *   hostError -> Error.prototype -> Error -> Function -> new Function('...')()
 *   and execute arbitrary host code (e.g. `process.env`, command execution).
 */

/** Every error {@link createSafeError} made. Membership cannot be forged from sandbox code. */
const safeErrors = new WeakSet<object>();

/**
 * Whether `value` is an error made by {@link createSafeError}: frozen, without a prototype chain
 * or a stack, carrying only strings. Such an error is inert and may be handed to sandbox code as
 * it is.
 */
export function isSafeError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && safeErrors.has(value);
}

/**
 * Create an Error instance whose prototype chain is severed (actual [[Prototype]]),
 * preventing prototype-chain escape to host constructors.
 *
 * @param message Error message
 * @param name Error name
 * @param code Optional error code (a read-only own property)
 */
export function createSafeError(message: string, name = 'Error', code?: string): Error {
  const error = new Error(message);
  safeErrors.add(error);
  error.name = name;

  if (typeof code === 'string') {
    Object.defineProperty(error, 'code', {
      value: code,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  // Null-prototype "constructor" object to break `err.constructor.constructor` chains.
  const SafeConstructor = Object.create(null);
  Object.defineProperties(SafeConstructor, {
    constructor: {
      value: SafeConstructor,
      writable: false,
      enumerable: false,
      configurable: false,
    },
    prototype: {
      value: null,
      writable: false,
      enumerable: false,
      configurable: false,
    },
    name: {
      value: 'SafeError',
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });
  Object.freeze(SafeConstructor);

  // CRITICAL: sever the *actual* prototype chain (native getters / Object.getPrototypeOf).
  // A shadowing `__proto__` data property is not sufficient.
  Object.setPrototypeOf(error, null);

  // Provide safe shadow properties for common escape paths / ergonomics.
  Object.defineProperty(error, 'constructor', {
    value: SafeConstructor,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(error, '__proto__', {
    value: null,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // Do not leak stack traces from host internals.
  Object.defineProperty(error, 'stack', {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.freeze(error);
  return error;
}

export function createSafeTypeError(message: string): Error {
  return createSafeError(message, 'TypeError');
}
