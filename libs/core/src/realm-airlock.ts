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

import { createSecureProxy, isSecureProxy, unwrapSecureProxy } from './secure-proxy';
import { isMutatingBuiltinMethod } from './global-function-gate';
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
}

// Captured at load: these run while scripts do.
const ReflectGet = Reflect.get;
const ReflectHas = Reflect.has;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectApply = Reflect.apply;
const ArrayIsArray = Array.isArray;
const HostObjectPrototype: object = Object.prototype;
const ObjectGetPrototypeOf = Object.getPrototypeOf;

function isReference(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Whether an object that is not a secure proxy belongs to the host: its prototype chain reaches
 * the host's `Object.prototype`, or it has no prototype at all (the host builds such objects for
 * its results; nothing of the sandbox realm comes out of a secure proxy without a prototype).
 */
function isRawHostObject(value: object): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 32; depth++) {
    try {
      current = ObjectGetPrototypeOf(current as object);
    } catch {
      return true;
    }
    if (current === null) {
      return depth === 0;
    }
    if (current === HostObjectPrototype) {
      return true;
    }
  }
  return true;
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
      hostProxy = createSecureProxy(value, { exposeToSandbox: toRealm });
    } else {
      // A value of the sandbox realm: what the call gate re-created there, a promise of the realm
      return value;
    }

    const callable = typeof hostProxy === 'function';
    const kind = callable ? 'function' : ArrayIsArray(hostProxy) ? 'array' : 'object';

    const handler = {
      get(_shell: object, key: string | symbol): unknown {
        const value: unknown = ReflectGet(hostProxy, key, hostProxy);
        if (typeof value === 'function' && isMutatingBuiltinMethod(unwrapSecureProxy(value))) {
          return refusedMethod;
        }
        return toRealm(value);
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
          value: toRealm(ReflectGet(hostProxy, key, hostProxy)),
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
        const hostArgs: unknown[] = [];
        for (let i = 0; i < args.length; i++) {
          hostArgs[i] = toHost(args[i]);
        }
        return toRealm(ReflectApply(hostProxy as (...a: unknown[]) => unknown, toHost(thisArg), hostArgs));
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

  return { toRealm, toHost };
}
