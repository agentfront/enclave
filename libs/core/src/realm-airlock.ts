/**
 * Realm Airlock (single-VM adapter)
 *
 * What the single VM hands a script from the host (a value from `globals`, a host function
 * behind the call gate) is a secure proxy: a HOST Proxy whose handler is host code. Three things
 * are wrong with a script holding one of those directly:
 *
 * - the engine attributes a Proxy to the realm of its target, so a callable one counts as a host
 *   function wherever the engine creates something on a callable's behalf;
 * - its traps are host functions, entered straight from the script: a stack overflow at the
 *   entry of a trap is a host `RangeError` in the script's catch block, raised before any host
 *   code could launder it;
 * - its `set` trap writes through to the host object.
 *
 * The airlock puts a second proxy in front, made INSIDE the sandbox realm (see
 * INNER_REALM_GUARD_SOURCE in ./double-vm/parent-vm-bootstrap): its target is a fresh object of
 * that realm, its traps are functions of that realm, and what those call is the handler built
 * here, which forwards to the secure proxy. The secure proxy keeps deciding what may be read and
 * called; this layer decides nothing except that host values are read-only.
 *
 * @packageDocumentation
 */

import { createSecureProxy, isRawHostObject, isSecureProxy, unwrapSecureProxy } from './secure-proxy';
import { HOST_REGEXP_MESSAGE, isMutatingBuiltinMethod, isRegExpMatchMethod } from './global-function-gate';
import { createSafeError, isSafeError } from './safe-error';

/** The sandbox realm's half of the membrane: what INNER_REALM_GUARD_SOURCE evaluates to */
export interface RealmMembrane {
  /** A proxy of the realm on `target`, whose traps call `handler`'s inside a try block */
  makeProxy(target: object, handler: object): object;
  /** A function of the realm that calls `fn` inside a try block */
  wrap<A extends unknown[], R>(fn: (...args: A) => R, needsReserve: boolean): (...args: A) => R;
  /** What a script may be handed in place of a thrown value or a rejection reason */
  own(value: unknown): unknown;
  /** A fresh object of the realm to put a proxy on */
  shell(kind: 'function' | 'array' | 'object'): object;
}

/** Both directions of the airlock */
export interface RealmAirlock {
  /** What the script gets for a value that came out of a secure proxy (or is one) */
  toRealm(value: unknown): unknown;
  /** The secure proxy behind an airlock proxy; any other value as it is */
  toHost<T>(value: T): T;
  /**
   * Whether an object was made in the sandbox realm: its prototype chain reaches that realm's
   * `Object.prototype`. Says no to everything else, and to an object that cannot be asked.
   */
  isRealmValue(value: object): boolean;
  /** Whether a value is an airlock proxy: the form in which the script holds a value of the host */
  isAirlockProxy(value: object): boolean;
}

// Captured at load: these run while scripts do.
const HostFunctionCall = Function.prototype.call;
const HostFunctionApply = Function.prototype.apply;
const HostFunctionBind = Function.prototype.bind;
const ReflectGet = Reflect.get;
const ReflectHas = Reflect.has;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectApply = Reflect.apply;
const ArrayIsArray = Array.isArray;
const ObjectGetPrototypeOf = Object.getPrototypeOf;

function isReference(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Create the airlock of one execution.
 *
 * @param realm The sandbox realm's half of the membrane
 */
export function createRealmAirlock(realm: RealmMembrane): RealmAirlock {
  const outward = new WeakMap<object, object>();
  const inward = new WeakMap<object, object>();

  const refuseWrite = (): never => {
    throw createSafeError('Values provided by the host are read-only in the sandbox', 'TypeError');
  };
  // What a script gets for push, sort, Map.prototype.set, ... read off a host object: called on
  // host data they would write to it without ever reaching the set trap.
  const refusedMethod = realm.wrap(refuseWrite, false);

  // The realm's own Object.prototype, read off an object the realm makes
  const realmObjectPrototype: unknown = ObjectGetPrototypeOf(realm.shell('object'));

  // A script never holds the host's `call`, `apply` or `bind`. They invoke their receiver, and
  // the only call into a host function this membrane prepares is one that goes through the
  // apply trap below. For `call` and `apply` read off a host function the script gets its own
  // realm's, read here off a function the realm makes, before any script runs: used on a host
  // function they end in that trap like any other call, and used on a function of the script
  // they are the script's own business. A host function is not bound for a script, as before
  // (a bound host function could never be handed over).
  const realmFunction = realm.shell('function');
  const realmCounterparts = new Map<unknown, unknown>([
    [HostFunctionCall, ReflectGet(realmFunction, 'call')],
    [HostFunctionApply, ReflectGet(realmFunction, 'apply')],
    [
      HostFunctionBind,
      realm.wrap((): never => {
        throw createSafeError(
          'A host function cannot be bound in the sandbox. Call it from a function of your own.',
          'TypeError',
        );
      }, false),
    ],
  ]);

  function isAirlockProxy(value: object): boolean {
    return inward.has(value);
  }

  function isRealmValue(value: object): boolean {
    if (!isReference(realmObjectPrototype) || inward.has(value)) {
      return false;
    }
    let current: unknown = value;
    for (let depth = 0; depth < 32; depth++) {
      try {
        current = ObjectGetPrototypeOf(current as object);
      } catch {
        return false;
      }
      if (current === realmObjectPrototype) {
        return true;
      }
      if (!isReference(current)) {
        return false;
      }
    }
    return false;
  }
  // What a script gets for test, exec and the methods a string calls on a regular expression of
  // the host: the pattern is not run for the script, at any security level.
  const refusedMatch = realm.wrap((): never => {
    throw createSafeError(HOST_REGEXP_MESSAGE, 'TypeError');
  }, false);

  function toHost<T>(value: T): T {
    return isReference(value) ? ((inward.get(value) as T | undefined) ?? value) : value;
  }

  function toRealm(value: unknown): unknown {
    if (!isReference(value)) {
      return value;
    }
    const known = outward.get(value);
    if (known) {
      return known;
    }
    if (inward.has(value)) {
      // Already an airlock proxy
      return value;
    }

    let hostProxy: object;
    if (isSecureProxy(value)) {
      hostProxy = value;
    } else if (isSafeError(value)) {
      // The host's inert errors: no prototype, frozen, nothing to climb
      return value;
    } else if (isRawHostObject(value)) {
      // Should not happen (a secure proxy hands out nothing unwrapped); wrapped rather than trusted
      hostProxy = createSecureProxy(value, {
        exposeToSandbox: toRealm,
        ownedBySandbox: isRealmValue,
        heldBySandbox: isAirlockProxy,
      });
    } else {
      // A value of the sandbox realm: what the call gate re-created there, a promise of the realm
      return value;
    }

    const callable = typeof hostProxy === 'function';
    if (callable) {
      const counterpart = realmCounterparts.get(unwrapSecureProxy(hostProxy));
      if (counterpart !== undefined) {
        outward.set(hostProxy, counterpart as object);
        return counterpart;
      }
    }
    const kind = callable ? 'function' : ArrayIsArray(hostProxy) ? 'array' : 'object';

    // What a script reads for a key. The refusals apply on every read path: a method the get
    // trap withholds must not be had from a property descriptor instead.
    const readValue = (key: string | symbol): unknown => {
      const value: unknown = ReflectGet(hostProxy, key, hostProxy);
      if (typeof value === 'function') {
        const method = unwrapSecureProxy(value);
        if (isMutatingBuiltinMethod(method)) {
          return refusedMethod;
        }
        if (isRegExpMatchMethod(method)) {
          return refusedMatch;
        }
      }
      return toRealm(value);
    };

    const handler = {
      get(_shell: object, key: string | symbol): unknown {
        return readValue(key);
      },
      has(_shell: object, key: string | symbol): boolean {
        return ReflectHas(hostProxy, key);
      },
      ownKeys(): (string | symbol)[] {
        return ReflectOwnKeys(hostProxy);
      },
      getOwnPropertyDescriptor(_shell: object, key: string | symbol): PropertyDescriptor | undefined {
        const descriptor = ReflectGetOwnPropertyDescriptor(hostProxy, key);
        if (!descriptor) {
          return undefined;
        }
        if (kind === 'array' && key === 'length') {
          // The one own property an array shell has itself: it must be reported non-configurable
          return { value: descriptor.value, writable: true, enumerable: false, configurable: false };
        }
        // Every other property exists on the host object only, so it is reported configurable
        // (a proxy may not report a property its target lacks as non-configurable), and as plain
        // read-only data: the value the get trap would return.
        return {
          value: readValue(key),
          writable: false,
          enumerable: descriptor.enumerable === true,
          configurable: true,
        };
      },
      getPrototypeOf(): null {
        return null;
      },
      isExtensible(): boolean {
        return true;
      },
      set: refuseWrite,
      defineProperty: refuseWrite,
      deleteProperty: refuseWrite,
      setPrototypeOf: refuseWrite,
      preventExtensions: refuseWrite,
      apply(_shell: object, thisArg: unknown, args: ArrayLike<unknown>): unknown {
        // `args` is the array the engine built for the trap: read by index, never through its
        // methods (they are the sandbox realm's, and a script can replace those).
        //
        // The arguments go on as the script holds them: an airlock proxy stays one. Whatever the
        // callee does with an argument (a built-in hands it to a callback as its receiver, or
        // keeps it in the array it returns), what comes back to the script is the value it
        // passed, never the secure proxy behind it. Host code reads through the airlock proxy
        // like through any object; the gate for host functions copies what it stands for.
        const passed: unknown[] = [];
        for (let i = 0; i < args.length; i++) {
          passed[i] = args[i];
        }
        // The receiver is the one value the secure proxy needs as its own: it runs a method on
        // the host object behind it, and passes no other receiver on to host code.
        return toRealm(ReflectApply(hostProxy as (...a: unknown[]) => unknown, toHost(thisArg), passed));
      },
      construct(): never {
        throw createSafeError('Host functions cannot be called with new', 'TypeError');
      },
    };

    const proxy = realm.makeProxy(realm.shell(kind), handler);
    outward.set(hostProxy, proxy);
    if (hostProxy !== value) {
      outward.set(value, proxy);
    }
    inward.set(proxy, hostProxy);
    return proxy;
  }

  return { toRealm, toHost, isRealmValue, isAirlockProxy };
}
