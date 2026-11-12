/**
 * Accounting for arrays that grow, inside a sandbox realm
 *
 * `memoryLimit` is an estimate over the operations that make data grow. For strings those are
 * concatenation and the amplifying methods (`repeat`, `padStart`, `padEnd`, `join`); `fill` was
 * the one array operation. An array could otherwise grow without the limit seeing it, and a few
 * dozen doublings are enough to exhaust the host's heap.
 *
 * The source below is evaluated in the script's realm, after the string patches, while the
 * realm is still being set up. Three rules:
 *
 * 1. No single array is larger than the limit holds (8 bytes per element). Where the size of
 *    the result is known before the built-in runs, it is refused before; a built-in that turns
 *    a length into that many elements (`Array.from({ length })`, the copying methods on an array
 *    with holes, `fill`) is among those. Where it is not known (an iterable given to
 *    `Array.from`, a nesting given to `flat`), the built-in is stopped at the limit.
 * 2. What an operation ADDS is charged to the execution's total: the elements pushed, spliced
 *    or unshifted in, the elements `concat`, `flat`, `flatMap` and a spread literal add to the
 *    largest array they started from, the elements `Array.from` makes out of something that is
 *    not an array, the elements `fill` writes. A plain copy adds nothing.
 * 3. What is checked is what the built-in works on. A built-in converts the length of its
 *    receiver and its arguments by the language's rules, after anything in front of it has
 *    looked at them: a length that is a text, a position beyond 32 bits, an object that answers
 *    differently the second time it is asked. So every length and every argument a decision
 *    rests on is converted here, once, the way the built-in converts it, and the built-in is
 *    given the converted value. This holds for the text methods as well (`join`,
 *    `toLocaleString`, `repeat`, `padStart`, `padEnd`), which are wrapped here for that reason.
 *    It holds for what a receiver holds as well. An object that is not an array can answer
 *    for its length and for each slot through an accessor, differently every time: where a
 *    decision rests on it, it is read here, once (its length, then each slot, with the object
 *    itself as the receiver of the read), and the built-in works on the plain copy. `flat`
 *    reads the elements of arrays too, and `concat` asks every value whether it is spread,
 *    which code of the script can answer, for an array as for anything else; so the result of
 *    these two is built in the pass that counts it, and the built-in does not run (for
 *    `concat`: ATK-MEMACC-31). Otherwise an array is handed on as it is: its length is its
 *    own, and nothing here reads its elements before the built-in does. An array behind a
 *    proxy is not its own answer. Where a realm leaves a script the Proxy constructor, the
 *    script gets a stand-in for it that remembers the proxies it makes, and such a proxy is
 *    read like any object that states a length (ATK-MEMACC-21).
 * 4. No array has more slots than the limit holds, and no built-in works through more. The
 *    slots between the elements of an array hold nothing and cost nothing to make, but every
 *    built-in that goes by the length works through them, and one call into a built-in is
 *    finished by the engine: the deadline is not looked at inside it. So the length is what
 *    is bounded. A write that would give an array more slots than the limit holds is refused,
 *    and the slots a write adds are charged, the empty ones included: an element beyond the
 *    end and an assignment to `length` (the transform hands every such write to `__safe_set`
 *    and `__safe_slot`, see guardArrayWrites in @enclave-vm/ast), `Array(n)` under any name
 *    (the global is a guarded stand-in), `Object.assign`, the property definitions. And a
 *    built-in that works through its receiver is not given an object that states a longer
 *    length: of an object the length is read once, a built-in that reads works on a plain
 *    copy, and one that moves the slots of its receiver works on the object itself only when
 *    its length is a number it holds.
 *
 * What it does not cover: a copy is free, so a script can still hold many arrays that are each
 * within the limit; object literals, Maps and Sets are not counted. With no limit (0) none of
 * the rules applies, the fourth included. The limit is an estimate,
 * not the engine's: where the host must survive whatever a script allocates, the script belongs
 * in a worker or a process of its own.
 *
 * @packageDocumentation
 */

import { numericLiteral } from './enclave-options';

/** Bytes an array element is counted as. */
export const ARRAY_ELEMENT_BYTES = 8;

/** Name of the realm function that opens the accounting of an array literal with spreads. */
export const ARRAY_START_FN = '__safe_arrayStart';

/** Name of the realm function a spread source of an array literal passes through. */
export const ARRAY_SPREAD_FN = '__safe_spread';

/** Name of the realm function that closes the accounting of an array literal with spreads. */
export const ARRAY_FINISH_FN = '__safe_array';

/** Name of the realm function a write `X[K] = V` goes through (see ARRAY_WRITE_SET_FN in @enclave-vm/ast). */
export const ARRAY_SET_FN = '__safe_set';

/** Name of the realm function that stands in for the target of every other write through a member. */
export const ARRAY_SLOT_FN = '__safe_slot';

/**
 * Source of a statement that patches the realm's array built-ins and defines the three helpers
 * the transformed code calls around an array literal with spreads.
 *
 * Evaluate it in the sandbox realm before any script code and before the realm's prototypes are
 * frozen, where `__host_memory_track__` is the realm-side function that charges the execution's
 * memory tracker. With `memoryLimit` 0 the helpers are defined and count nothing.
 *
 * @param memoryLimit The execution's memory limit in bytes, 0 for none
 */
export function realmArrayAccountingSource(memoryLimit: number): string {
  return `
(function (memoryLimit, track) {
  'use strict';
  // Everything the patched functions use is taken now: none of it is looked up again on an
  // object a script can write to.
  var apply = Reflect.apply;
  var isArray = Array.isArray;
  var defineProperty = Object.defineProperty;
  var objectCreate = Object.create;
  var ObjectCtor = Object;
  var construct = Reflect.construct;
  var ownKeys = Reflect.ownKeys;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var ProxyCtor = typeof Proxy === 'function' ? Proxy : undefined;
  var RangeErrorCtor = RangeError;
  var TypeErrorCtor = TypeError;
  var StringCtor = String;
  var arrayProto = Array.prototype;
  var stringProto = String.prototype;
  var ArrayCtor = Array;
  var iteratorSymbol = Symbol.iterator;
  var speciesSymbol = Symbol.species;
  var spreadableSymbol = Symbol.isConcatSpreadable;
  var asyncIteratorSymbol = Symbol.asyncIterator;
  var MAX_SAFE_INTEGER = 9007199254740991;
  var limited = memoryLimit > 0 && typeof track === 'function';
  var BYTES = ${ARRAY_ELEMENT_BYTES};
  // Charged to the tracker in batches: a call into the host for every pushed element is not
  // affordable, and what is pending is at most this much.
  var BATCH = 4096;
  var pending = 0;

  // A refusal goes through the tracker, which answers an amount over the limit with the
  // execution's memory-limit error; the RangeError is for a tracker that did not.
  function refuse(label, bytes) {
    // A finite amount: a length a script made up can be anything
    if (!(bytes <= MAX_SAFE_INTEGER)) bytes = MAX_SAFE_INTEGER;
    track(bytes > memoryLimit ? bytes : memoryLimit + 1);
    throw new RangeErrorCtor(label + ' would exceed memory limit');
  }

  /** Rule 1: an array of that many elements is not made. */
  function checkLength(length, label) {
    if (limited && typeof length === 'number' && length * BYTES > memoryLimit) refuse(label, length * BYTES);
  }

  /** Rule 2: that many elements were added. */
  function charge(elements) {
    if (!limited || !(elements > 0)) return;
    pending += elements * BYTES;
    if (pending >= BATCH) {
      var bytes = pending;
      pending = 0;
      track(bytes);
    }
  }

  function lengthOf(value) {
    return isArray(value) ? value.length : 0;
  }

  // Rule 3: the conversions of the language, done once. Each throws where the built-in would
  // (a Symbol, a BigInt), and may run code of the script (valueOf, toString): once.

  /** ToIntegerOrInfinity */
  function toInteger(value) {
    var number = +value;
    if (number !== number) return 0;
    if (number === Infinity || number === -Infinity) return number;
    return number < 0 ? -((-number) - ((-number) % 1)) : number - (number % 1);
  }

  /** ToLength */
  function toLength(value) {
    var integer = toInteger(value);
    if (integer <= 0) return 0;
    return integer > MAX_SAFE_INTEGER ? MAX_SAFE_INTEGER : integer;
  }

  /** A start or end argument relative to a length, as fill, slice and the like read it. */
  function relativeIndex(value, length, whenUndefined) {
    if (value === undefined) return whenUndefined;
    var relative = toInteger(value);
    if (relative < 0) {
      var fromEnd = length + relative;
      return fromEnd > 0 ? fromEnd : 0;
    }
    return relative < length ? relative : length;
  }

  /** ToString, for a value that is not null or undefined */
  function toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'symbol') throw new TypeErrorCtor('Cannot convert a Symbol value to a string');
    return StringCtor(value);
  }

  function isObject(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  /** ToObject: what a built-in works on. Null for a receiver the built-in refuses. */
  function toObject(value) {
    if (value === null || value === undefined) return null;
    return isObject(value) ? value : ObjectCtor(value);
  }

  /**
   * A plain array of what a source answers for its first slots. Each slot is asked once, with
   * the source itself as the receiver of the read; with \`holes\`, a slot the source does not
   * have stays empty. The caller has checked the length: this makes an array of it.
   */
  function snapshot(source, length, holes) {
    var copy = [];
    for (var i = 0; i < length; i++) {
      if (!holes || i in source) copy[i] = source[i];
    }
    if (copy.length !== length) copy.length = length;
    return copy;
  }

  /**
   * The same as an object that has a length and slots and nothing else: no prototype, so
   * nothing to iterate it by. \`Array.from\` reads such a source by its length.
   */
  function slotsOf(source, length) {
    var holder = objectCreate(null);
    for (var i = 0; i < length; i++) holder[i] = source[i];
    holder.length = length;
    return holder;
  }

  /**
   * The empty array a built-in would make for a result of the receiver's kind
   * (ArraySpeciesCreate): null for a plain array, which the caller makes itself.
   */
  function emptyOfKind(receiver) {
    if (!isArray(receiver)) return null;
    var kind = receiver.constructor;
    if (kind === ArrayCtor) return null;
    if (isObject(kind)) {
      kind = kind[speciesSymbol];
      if (kind === null) kind = undefined;
    }
    if (kind === undefined || kind === ArrayCtor) return null;
    return construct(kind, [0]);
  }

  // A proxy a script makes answers for its length and its slots as its handler likes, and
  // \`Array.isArray\` says yes to a proxy of an array. Where a realm leaves a script the Proxy
  // constructor (the double VM at STANDARD and PERMISSIVE), the script gets a stand-in for it
  // that makes the same proxy and remembers it. A remembered proxy is not handed to a built-in
  // as an array: it is read once, like any object that states a length.
  var scriptProxies = null;
  var proxyMade = false;
  if (limited && ProxyCtor !== undefined && typeof WeakSet === 'function') {
    var remember = WeakSet.prototype.add;
    var remembered = WeakSet.prototype.has;
    var makeRevocable = ProxyCtor.revocable;
    scriptProxies = new WeakSet();
    var ProxyStandIn = function Proxy(target, handler) {
      if (new.target === undefined) throw new TypeErrorCtor("Constructor Proxy requires 'new'");
      var made = new ProxyCtor(target, handler);
      apply(remember, scriptProxies, [made]);
      proxyMade = true;
      return made;
    };
    // Like the built-in, it has no prototype of its own to give
    ProxyStandIn.prototype = undefined;
    defineProperty(ProxyStandIn, 'revocable', {
      value: function revocable(target, handler) {
        var pair = apply(makeRevocable, ProxyCtor, [target, handler]);
        apply(remember, scriptProxies, [pair.proxy]);
        proxyMade = true;
        return pair;
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
    try {
      defineProperty(globalThis, 'Proxy', { value: ProxyStandIn, writable: true, enumerable: false, configurable: true });
    } catch (e) {
      scriptProxies = null;
    }
  }

  function isScriptProxy(value) {
    return proxyMade && isObject(value) && apply(remembered, scriptProxies, [value]);
  }

  /** An array that answers for itself: not one behind a proxy a script made. */
  function ownArray(value) {
    return isArray(value) && !isScriptProxy(value);
  }

  // Rule 4: no array has more slots than the limit holds, and no built-in walks more.

  /** The index a property key is on an array, or -1. */
  function arrayIndex(key) {
    if (typeof key === 'number') return (key >>> 0) === key && key !== 4294967295 ? key : -1;
    if (typeof key !== 'string') return -1;
    var number = +key;
    return (number >>> 0) === number && number !== 4294967295 && StringCtor(number) === key ? number : -1;
  }

  /** ToPropertyKey, done once: what a member access makes of the key. */
  function propertyKey(key) {
    var type = typeof key;
    return type === 'string' || type === 'symbol' || type === 'number' ? key : StringCtor(key);
  }

  /**
   * A write to an array through its length or through an index beyond its end: refused when it
   * would give the array more slots than the limit holds, and charged for the slots it adds
   * (the slots between the old end and the new one are part of what a built-in walks).
   * Returns the value to write: for the length, the number it was converted to, once.
   */
  function growing(target, key, value) {
    // The bound is checked whatever the array says its length is now: behind a proxy that is
    // not the array's own answer
    if (key === 'length') {
      var wanted = +value;
      checkLength(wanted, 'Array length');
      var before = target.length;
      if (wanted > before) charge(wanted - before);
      return wanted;
    }
    var index = arrayIndex(key);
    if (index >= 0) {
      checkLength(index + 1, 'Array index');
      var length = target.length;
      if (index >= length) charge(index + 1 - length);
    }
    return value;
  }

  /** \`target[key] = value\`, with the key converted once and an array kept within the limit. */
  function guardedSet(target, key, value) {
    // The common write: a number that is inside the array. Nothing grows, nothing to convert.
    // (Not for an array behind a proxy a script made: the length it states is not the array's.)
    if (typeof key === 'number' && key >= 0 && isArray(target) && !(proxyMade && isScriptProxy(target)) && key < target.length) {
      target[key] = value;
      return value;
    }
    var k = propertyKey(key);
    if (limited && isArray(target)) {
      target[k] = growing(target, k, value);
    } else {
      target[k] = value;
    }
    return value;
  }

  /**
   * What stands in for \`X[K]\` where it is written in another way than \`X[K] = V\` (a compound
   * assignment, \`++\`, a target in a destructuring pattern or in the head of a loop): an object
   * whose one member \`v\` reads and writes that slot, so the write is the guarded one.
   */
  function Slot(target, key) {
    this.t = target;
    this.k = propertyKey(key);
  }
  Slot.prototype = ObjectCtor.freeze(objectCreate(null, {
    v: {
      get: function () { return this.t[this.k]; },
      set: function (value) { guardedSet(this.t, this.k, value); },
      enumerable: false,
      configurable: false
    }
  }));
  function slot(target, key) {
    return new Slot(target, key);
  }

  /**
   * The receiver of a built-in that reads its receiver by its length. An array is itself: its
   * length is its own, and it has no more slots than a script could give it. Anything else is
   * read here, once, into a plain array of the length it states, which is checked first. Null
   * for a receiver the built-in refuses by itself.
   */
  function walked(self, label) {
    if (isArray(self) && !(proxyMade && isScriptProxy(self))) return self;
    var receiver = toObject(self);
    if (receiver === null) return null;
    var length = toLength(receiver.length);
    checkLength(length, label);
    return snapshot(receiver, length, true);
  }

  /**
   * Whether a built-in that moves the slots of its receiver can be given the receiver itself:
   * an array, or an object whose length is a number it holds (checked here) or that has none.
   * The built-in reads the length again, and such a length answers the same.
   */
  function movable(self, label) {
    if (!isObject(self) || ownArray(self)) return true;
    if (isScriptProxy(self)) return false;
    var held = getOwnPropertyDescriptor(self, 'length');
    if (held === undefined) return !('length' in self);
    if (!('value' in held) || typeof held.value !== 'number') return false;
    checkLength(toLength(held.value), label);
    return true;
  }

  /**
   * A built-in that moves the slots of its receiver, applied to a receiver whose length is
   * computed (an accessor, an inherited length, a proxy a script made): the receiver is read
   * once into a plain array, the built-in works on that, and the result is written back.
   */
  function moveThroughCopy(original, self, given, label) {
    var length = toLength(self.length);
    checkLength(length, label);
    var copy = snapshot(self, length, true);
    var result = apply(original, copy, given);
    var after = copy.length;
    for (var i = 0; i < after; i++) {
      if (i in copy) guardedSet(self, i, copy[i]);
      else delete self[i];
    }
    for (var gone = after; gone < length; gone++) delete self[gone];
    guardedSet(self, 'length', after);
    return result === copy ? self : result;
  }

  /** Rule 1, for a text: that many characters are not made. */
  function checkText(characters, label) {
    if (limited && characters * 2 > memoryLimit) refuse(label, characters * 2);
  }

  function patch(holder, name, make) {
    var original = holder[name];
    if (typeof original !== 'function') return;
    var replacement = make(original);
    // The replacement answers for its name and its number of parameters like the built-in
    try {
      defineProperty(replacement, 'name', { value: name, writable: false, enumerable: false, configurable: true });
      defineProperty(replacement, 'length', { value: original.length, writable: false, enumerable: false, configurable: true });
    } catch (e) { /* left as it is */ }
    try {
      defineProperty(holder, name, { value: replacement, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* frozen already: left as it is */ }
  }

  if (limited) {
    // push, unshift: every argument is a new element
    patch(arrayProto, 'push', function (original) {
      return function push() {
        charge(arguments.length);
        return apply(original, this, arguments);
      };
    });
    // The global Array, once it is the guarded one (see the end of this block)
    var guardedArray = null;
    patch(arrayProto, 'unshift', function (original) {
      return function unshift() {
        charge(arguments.length);
        if (!movable(this, 'Array.unshift')) return moveThroughCopy(original, this, arguments, 'Array.unshift');
        return apply(original, this, arguments);
      };
    });
    // splice: the arguments after the first two are inserted
    patch(arrayProto, 'splice', function (original) {
      return function splice() {
        if (arguments.length > 2) charge(arguments.length - 2);
        if (!movable(this, 'Array.splice')) return moveThroughCopy(original, this, arguments, 'Array.splice');
        return apply(original, this, arguments);
      };
    });
    // concat: the result has, for the receiver and each argument, its elements or itself. It
    // is built here, in the pass that counts it and in the order the built-in works: each value
    // is asked once whether it is spread (the language's symbol for it, otherwise whether it
    // is an array), a value that is spread is asked once for its length and once for each
    // slot, and the count is checked before the slots are copied. The built-in does not run.
    // It would ask every value again, and what answers can be code of the script (an accessor
    // on an array, the constructor of the receiver's kind): an array that was counted could
    // hold more by the time the built-in copies it, as often as it is named.
    function copySlots(target, at, source, length) {
      // A slot that is not there stays empty in the result
      for (var k = 0; k < length; k++) {
        if (k in source) target[at + k] = source[k];
      }
    }
    patch(arrayProto, 'concat', function (original) {
      return function concat() {
        var receiver = toObject(this);
        if (receiver === null) return apply(original, this, arguments);
        // The result is of the receiver's kind, and is made first, as in the built-in
        var ofKind = emptyOfKind(receiver);
        var plain = ofKind === null;
        var target = plain ? [] : ofKind;
        if (plain) {
          // A first size for the result, so that it is not made in steps: what the arrays
          // among the values hold now. It decides nothing. Every value is asked and counted
          // below, and the result ends with the length that was counted.
          var expected = 0;
          for (var e = -1; e < arguments.length; e++) {
            var one = e < 0 ? receiver : arguments[e];
            expected += ownArray(one) ? one.length : 1;
          }
          if (expected * BYTES <= memoryLimit) target.length = expected;
        }
        var count = 0;
        var own = 0;
        for (var i = -1; i < arguments.length; i++) {
          var item = i < 0 ? receiver : arguments[i];
          var spread = false;
          if (isObject(item)) {
            var flag = item[spreadableSymbol];
            spread = flag === undefined ? isArray(item) : !!flag;
          }
          if (!spread) {
            checkLength(count + 1, 'Array.concat');
            if (plain) {
              target[count] = item;
            } else {
              defineProperty(target, count, { value: item, writable: true, enumerable: true, configurable: true });
            }
            count++;
            continue;
          }
          var length = toLength(item.length);
          checkLength(count + length, 'Array.concat');
          if (i < 0 && ownArray(item)) own = length;
          if (plain) {
            copySlots(target, count, item, length);
          } else {
            for (var k = 0; k < length; k++) {
              if (!(k in item)) continue;
              defineProperty(target, count + k, { value: item[k], writable: true, enumerable: true, configurable: true });
            }
          }
          count += length;
        }
        target.length = count;
        charge(count - own);
        return target;
      };
    });

    // flat: the result is built here, in the pass that counts it, to the depth the built-in
    // flattens. Each slot is asked once (is it there, what is it) and each nested array for its
    // length once, so what is counted is what the result is made of. The pass walks the nesting
    // with a list of its own, so the depth of the nesting is not the depth of a call stack, and
    // it stops at the limit: by the slots counted so far, and by the arrays entered (an array
    // of empty arrays has nothing to count and everything to visit).
    function flatten(root, rootLength, levels, target, plain) {
      var budget = memoryLimit / BYTES;
      var slots = rootLength;
      var entered = 0;
      if (slots > budget) refuse('Array.flat', slots * BYTES);
      var sources = [root];
      var lengths = [rootLength];
      var depths = [levels];
      var next = [0];
      var top = 0;
      var count = 0;
      while (top >= 0) {
        var index = next[top];
        if (index >= lengths[top]) {
          top--;
          continue;
        }
        next[top] = index + 1;
        var source = sources[top];
        // A slot that is not there is left out, as in the built-in
        if (!(index in source)) continue;
        var item = source[index];
        if (depths[top] >= 1 && isArray(item)) {
          // The slot gives way to what the array holds
          var length = toLength(item.length);
          slots += length - 1;
          entered++;
          if (slots > budget || entered > budget) {
            refuse('Array.flat', (slots > entered ? slots : entered) * BYTES);
          }
          top++;
          sources[top] = item;
          lengths[top] = length;
          depths[top] = depths[top - 1] - 1;
          next[top] = 0;
          continue;
        }
        if (plain) {
          target[count] = item;
        } else {
          defineProperty(target, count, { value: item, writable: true, enumerable: true, configurable: true });
        }
        count++;
      }
      return count;
    }
    patch(arrayProto, 'flat', function (original) {
      return function flat(depth) {
        var receiver = toObject(this);
        if (receiver === null) return apply(original, this, arguments);
        var length = toLength(receiver.length);
        var levels = depth === undefined ? 1 : toInteger(depth);
        if (levels < 0) levels = 0;
        var ofKind = emptyOfKind(receiver);
        var target = ofKind === null ? [] : ofKind;
        var count = flatten(receiver, length, levels, target, ofKind === null);
        charge(count - (isArray(receiver) ? length : 0));
        return target;
      };
    });
    // flatMap: what the callback hands back is counted as it comes
    patch(arrayProto, 'flatMap', function (original) {
      return function flatMap(callback, thisArg) {
        if (typeof callback !== 'function') return apply(original, this, arguments);
        var receiver = walked(this, 'Array.flatMap');
        if (receiver === null) return apply(original, this, arguments);
        var produced = 0;
        var result = apply(original, receiver, [function (value, index, array) {
          var item = apply(callback, this, [value, index, array]);
          if (isScriptProxy(item) && isArray(item)) {
            // An array behind a proxy a script made: the built-in gets what was counted
            var length = toLength(item.length);
            produced += length;
            checkLength(produced, 'Array.flatMap');
            return snapshot(item, length, true);
          }
          produced += isArray(item) ? item.length : 1;
          checkLength(produced, 'Array.flatMap');
          return item;
        }, thisArg]);
        charge(lengthOf(result) - lengthOf(this));
        return result;
      };
    });
    // The copying methods turn every slot of the receiver into an element, holes included.
    // Of something that is not an array they get a plain copy, of the length that was checked.
    var copying = ['toSorted', 'toReversed', 'toSpliced', 'with'];
    for (var c = 0; c < copying.length; c++) {
      (function (name) {
        patch(arrayProto, name, function (original) {
          return function () {
            var receiver = toObject(this);
            if (receiver === null) return apply(original, this, arguments);
            var length = toLength(receiver.length);
            var array = ownArray(receiver);
            // The copy that is made of something that is not an array has its length
            if (!array) checkLength(length, 'Array.' + name);
            var given = arguments;
            if (name === 'toSpliced') {
              // The result has the receiver's slots, less the ones skipped, plus the ones
              // inserted: worked out here by the built-in's rules, and the built-in gets the
              // two numbers
              var start = relativeIndex(arguments[0], length, 0);
              var skip = arguments.length === 0 ? 0 : arguments.length === 1 ? length - start : toInteger(arguments[1]);
              if (skip < 0) skip = 0;
              if (skip > length - start) skip = length - start;
              var inserted = arguments.length > 2 ? arguments.length - 2 : 0;
              checkLength(length + inserted - skip, 'Array.toSpliced');
              given = [start, skip];
              for (var g = 2; g < arguments.length; g++) given[g] = arguments[g];
            } else {
              checkLength(length, 'Array.' + name);
            }
            return apply(original, array ? receiver : snapshot(receiver, length, false), given);
          };
        });
      })(copying[c]);
    }
    // Array.from. Of something with a length: that many elements, whatever is behind it. Of
    // something that is iterated: as many as it yields, so the built-in is stopped at the
    // limit by the mapping function it calls for each element. Which of the two it is, is
    // decided here, once, for an array as for anything else: the built-in is given a source
    // that can only be read that way.
    patch(ArrayCtor, 'from', function (original) {
      return function from(items, mapFn, thisArg) {
        // What the built-in refuses by itself, it refuses before it makes anything
        if (items === null || items === undefined) return apply(original, this, arguments);
        if (mapFn !== undefined && typeof mapFn !== 'function') return apply(original, this, arguments);

        var source = items;
        var iterate = items[iteratorSymbol];
        if (iterate === undefined || iterate === null) {
          var receiver = toObject(items);
          var length = toLength(receiver.length);
          checkLength(length, 'Array.from');
          source = slotsOf(receiver, length);
        } else if (typeof iterate !== 'function') {
          // What the built-in answers for an iterator that cannot be called: answered here, so
          // that it is not asked a second time
          throw new TypeErrorCtor('Array.from: the iterator of the source is not a function');
        } else if (isObject(items)) {
          var held = {};
          held[iteratorSymbol] = { value: function () { return apply(iterate, items, []); } };
          source = objectCreate(null, held);
        }

        var produced = 0;
        var mapped = mapFn !== undefined;
        // The guarded Array stands for the built-in one: what is made here is counted here
        var result = apply(original, this === guardedArray ? ArrayCtor : this, [source, function (value, index) {
          produced++;
          if (produced * BYTES > memoryLimit) refuse('Array.from', produced * BYTES);
          return mapped ? apply(mapFn, this, [value, index]) : value;
        }, thisArg]);
        checkLength(lengthOf(result), 'Array.from');
        if (!isArray(items)) charge(lengthOf(result));
        return result;
      };
    });

    // fill: the range is worked out here, by the built-in's rules, checked and charged, and
    // the built-in gets the range as two numbers. Something that is not an array is filled
    // here: the built-in would read its length again.
    patch(arrayProto, 'fill', function (original) {
      return function fill(value, start, end) {
        if (!isObject(this)) return apply(original, this, arguments);
        var array = ownArray(this);
        var length = array ? this.length : toLength(this.length);
        var from = relativeIndex(start, length, 0);
        var to = relativeIndex(end, length, length);
        var count = to > from ? to - from : 0;
        checkLength(count, 'Array.fill');
        if (array) {
          // The slots of an array were charged when it got them
          return apply(original, this, [value, from, to]);
        }
        charge(count);
        for (var i = from; i < to; i++) {
          this[i] = value;
        }
        return this;
      };
    });

    // Every other built-in that works through its receiver by its length. One call into such a
    // built-in is finished by the engine, however long the length says the receiver is: the
    // deadline is not looked at inside it. So none of them is given a length above what an
    // array may have, whether the receiver is an array with that many slots (most of them
    // empty) or an object that states the length.
    var reading = [
      'indexOf', 'lastIndexOf', 'includes', 'forEach', 'map', 'filter', 'some', 'every', 'reduce',
      'reduceRight', 'find', 'findIndex', 'findLast', 'findLastIndex', 'slice', 'keys', 'values', 'entries'
    ];
    for (var r = 0; r < reading.length; r++) {
      (function (name) {
        var label = 'Array.' + name;
        patch(arrayProto, name, function (original) {
          return function () {
            var receiver = walked(this, label);
            return apply(original, receiver === null ? this : receiver, arguments);
          };
        });
      })(reading[r]);
    }
    var moving = ['reverse', 'sort', 'copyWithin', 'shift'];
    for (var m = 0; m < moving.length; m++) {
      (function (name) {
        var label = 'Array.' + name;
        patch(arrayProto, name, function (original) {
          return function () {
            if (!movable(this, label)) return moveThroughCopy(original, this, arguments, label);
            return apply(original, this, arguments);
          };
        });
      })(moving[m]);
    }

    // The other ways to write to an array. Each is the guarded write, or checked like it.
    patch(ObjectCtor, 'assign', function (original) {
      return function assign(target) {
        if (!isArray(target)) return apply(original, this, arguments);
        for (var s = 1; s < arguments.length; s++) {
          var source = arguments[s];
          if (source === null || source === undefined) continue;
          var from = ObjectCtor(source);
          var keys = ownKeys(from);
          for (var i = 0; i < keys.length; i++) {
            var held = getOwnPropertyDescriptor(from, keys[i]);
            if (held !== undefined && held.enumerable) guardedSet(target, keys[i], from[keys[i]]);
          }
        }
        return target;
      };
    });
    // A descriptor, read once: the built-in reads its members again
    var descriptorMembers = ['enumerable', 'configurable', 'value', 'writable', 'get', 'set'];
    function pinned(descriptor) {
      if (!isObject(descriptor)) return descriptor;
      var copy = objectCreate(null);
      for (var d = 0; d < descriptorMembers.length; d++) {
        if (descriptorMembers[d] in descriptor) copy[descriptorMembers[d]] = descriptor[descriptorMembers[d]];
      }
      return copy;
    }
    // The key and the descriptor a definition on an array is made with
    function definition(target, key, descriptor) {
      var k = propertyKey(key);
      var copy = pinned(descriptor);
      if (isObject(copy)) {
        if (k !== 'length') growing(target, k, undefined);
        else if ('value' in copy) copy.value = growing(target, k, copy.value);
      }
      return [target, k, copy];
    }
    var defineOne = ObjectCtor.defineProperty;
    patch(ObjectCtor, 'defineProperty', function (original) {
      return function defineProperty(target, key, descriptor) {
        if (!isArray(target)) return apply(original, this, arguments);
        return apply(original, this, definition(target, key, descriptor));
      };
    });
    patch(ObjectCtor, 'defineProperties', function (original) {
      return function defineProperties(target, properties) {
        if (!isArray(target) || properties === null || properties === undefined) return apply(original, this, arguments);
        var from = ObjectCtor(properties);
        var keys = ownKeys(from);
        for (var i = 0; i < keys.length; i++) {
          var held = getOwnPropertyDescriptor(from, keys[i]);
          if (held !== undefined && held.enumerable) apply(defineOne, ObjectCtor, definition(target, keys[i], from[keys[i]]));
        }
        return target;
      };
    });
    if (typeof Reflect === 'object' && Reflect !== null) {
      patch(Reflect, 'defineProperty', function (original) {
        return function defineProperty(target, key, descriptor) {
          if (!isArray(target)) return apply(original, this, arguments);
          return apply(original, this, definition(target, key, descriptor));
        };
      });
      patch(Reflect, 'set', function (original) {
        return function set(target, key, value, receiver) {
          // The write lands on the receiver, which is the target unless one is given
          var landing = arguments.length > 3 ? receiver : target;
          if (!isArray(landing)) return apply(original, this, arguments);
          var k = propertyKey(key);
          var written = growing(landing, k, value);
          return apply(original, this, arguments.length > 3 ? [target, k, written, receiver] : [target, k, written]);
        };
      });
    }
    var legacy = ['__defineGetter__', '__defineSetter__'];
    for (var l = 0; l < legacy.length; l++) {
      (function (name) {
        patch(ObjectCtor.prototype, name, function (original) {
          return function (key, accessor) {
            if (!isArray(this)) return apply(original, this, arguments);
            var k = propertyKey(key);
            growing(this, k, undefined);
            return apply(original, this, [k, accessor]);
          };
        });
      })(legacy[l]);
    }

    // Array(n) and new Array(n) make n slots: checked and charged like every other way to get
    // them. The global is put behind a proxy for that (made here, while the realm still has
    // the means), so it holds for every way to call it; \`Array.prototype.constructor\` stays the
    // built-in, which the results of the built-ins are made with.
    patch(ArrayCtor, 'of', function (original) {
      return function of() {
        return apply(original, this === guardedArray ? ArrayCtor : this, arguments);
      };
    });
    if (ProxyCtor !== undefined) {
      var slotsFor = function (given) {
        if (given.length === 1 && typeof given[0] === 'number') {
          checkLength(given[0], 'Array');
          charge(given[0]);
        } else {
          checkLength(given.length, 'Array');
        }
      };
      guardedArray = new ProxyCtor(ArrayCtor, {
        apply: function (target, self, given) {
          slotsFor(given);
          return apply(target, self, given);
        },
        construct: function (target, given, newTarget) {
          slotsFor(given);
          return construct(target, given, newTarget);
        }
      });
      try {
        defineProperty(globalThis, 'Array', { value: guardedArray, writable: true, enumerable: false, configurable: true });
      } catch (e) {
        guardedArray = null;
      }
    }

    // Array.fromAsync: like Array.from. How the source is read is decided here, once, and what
    // it yields is counted as it comes. The built-in answers every failure with a promise that
    // is rejected, never with an error at the call. So an iterator that cannot be called is
    // handed on as the value it is, and an error the source raises while it is read here is
    // kept and raised again by the source the built-in is given: the answer is the built-in's
    // own, and the source is not asked a second time. The limit's refusal is not an answer of
    // the built-in: it ends the call.
    patch(ArrayCtor, 'fromAsync', function (original) {
      return function fromAsync(items, mapFn, thisArg) {
        if (items === null || items === undefined) return apply(original, this, arguments);
        if (mapFn !== undefined && typeof mapFn !== 'function') return apply(original, this, arguments);
        var source;
        var receiver;
        var length = -1;
        var failed = false;
        var failure;
        try {
          var iterate = asyncIteratorSymbol === undefined ? undefined : items[asyncIteratorSymbol];
          var symbol = asyncIteratorSymbol;
          if (iterate === undefined || iterate === null) {
            iterate = items[iteratorSymbol];
            symbol = iteratorSymbol;
          }
          if (iterate === undefined || iterate === null) {
            receiver = toObject(items);
            length = toLength(receiver.length);
          } else {
            var held = {};
            held[symbol] = {
              value: typeof iterate === 'function' ? function () { return apply(iterate, items, []); } : iterate
            };
            source = objectCreate(null, held);
          }
        } catch (error) {
          failed = true;
          failure = error;
        }
        if (!failed && length >= 0) {
          checkLength(length, 'Array.fromAsync');
          try {
            source = slotsOf(receiver, length);
          } catch (error) {
            failed = true;
            failure = error;
          }
        }
        if (failed) {
          var raising = {};
          raising[asyncIteratorSymbol === undefined ? iteratorSymbol : asyncIteratorSymbol] = {
            get: function () { throw failure; }
          };
          source = objectCreate(null, raising);
        }
        var produced = 0;
        var mapped = mapFn !== undefined;
        return apply(original, this === guardedArray ? ArrayCtor : this, [source, function (value, index) {
          produced++;
          if (produced * BYTES > memoryLimit) refuse('Array.fromAsync', produced * BYTES);
          charge(1);
          return mapped ? apply(mapFn, this, [value, index]) : value;
        }, thisArg]);
      };
    });

    // join and toLocaleString: each item is converted to its text here, once, the texts are
    // counted as they come, and the built-in joins the texts.
    var joining = [];
    function textsOf(receiver, length, separatorLength, label, convert) {
      // The list of the texts is an array of that length
      checkLength(length, label);
      var texts = [];
      var characters = 0;
      for (var i = 0; i < length; i++) {
        var item = receiver[i];
        var text = (item === undefined || item === null) ? '' : convert(item);
        texts[i] = text;
        characters += text.length + (i > 0 ? separatorLength : 0);
        checkText(characters, label);
      }
      return texts;
    }
    function joined(receiver, label, separator, convert, join) {
      var array = isArray(receiver);
      var length = array ? receiver.length : toLength(receiver.length);
      // An array that contains itself contributes nothing the second time, as in the built-in
      for (var j = 0; j < joining.length; j++) {
        if (joining[j] === receiver) return '';
      }
      joining[joining.length] = receiver;
      var texts;
      try {
        texts = textsOf(receiver, length, separator.length, label, convert);
      } finally {
        joining.length = joining.length - 1;
      }
      return apply(join, texts, [separator]);
    }
    var joinBefore = arrayProto.join;
    patch(arrayProto, 'join', function (previous) {
      return function join(separator) {
        if (!isObject(this)) return apply(previous, this, arguments);
        var between = separator === undefined ? ',' : toText(separator);
        return joined(this, 'Array.join', between, toText, previous);
      };
    });
    patch(arrayProto, 'toLocaleString', function (previous) {
      return function toLocaleString(locales, options) {
        if (!isObject(this) || typeof joinBefore !== 'function') return apply(previous, this, arguments);
        return joined(this, 'Array.toLocaleString', ',', function (item) {
          return toText(item.toLocaleString(locales, options));
        }, joinBefore);
      };
    });

    // repeat, padStart, padEnd: the receiver and the count are converted here, once
    patch(stringProto, 'repeat', function (previous) {
      return function repeat(count) {
        if (this === null || this === undefined) return apply(previous, this, arguments);
        return apply(previous, toText(this), [toInteger(count)]);
      };
    });
    var padding = ['padStart', 'padEnd'];
    for (var p = 0; p < padding.length; p++) {
      (function (name) {
        patch(stringProto, name, function (previous) {
          return function (targetLength, padString) {
            if (this === null || this === undefined) return apply(previous, this, arguments);
            return apply(previous, toText(this), [toLength(targetLength), padString === undefined ? undefined : toText(padString)]);
          };
        });
      })(padding[p]);
    }
  }

  // An array literal with spreads: [a, ...b, ...c] is compiled to
  //   __safe_array(__safe_arrayStart(), [a, ...__safe_spread(b), ...__safe_spread(c)])
  // so that each source is seen before it is spread and the result when it exists.
  var frames = [];
  var nextId = 1;

  function arrayStart() {
    // A literal that threw before it was finished leaves its frame; they are small, and gone
    // with the next literal that finishes below them or once there are too many.
    if (frames.length > 1024) frames.length = 0;
    var frame = { id: nextId++, total: 0, largest: 0 };
    frames[frames.length] = frame;
    return frame.id;
  }

  function spread(source) {
    var frame = frames.length > 0 ? frames[frames.length - 1] : null;
    if (ownArray(source) || typeof source === 'string') {
      // An array, or a text (which yields at most as many items as it has characters): its
      // size is known before it is spread
      var length = source.length;
      checkLength(length, 'Array spread');
      if (frame) {
        frame.total += length;
        if (typeof source !== 'string' && length > frame.largest) frame.largest = length;
        checkLength(frame.total, 'Array spread');
      }
      return source;
    }
    if (!limited || source === null || source === undefined) return source;
    // Anything else that is iterated yields as many items as it likes: it is spread through an
    // iterator that counts them as they come, so the literal is stopped at the limit and not
    // measured when it exists. The iterator is asked for once, and each step is read once.
    var iterate = source[iteratorSymbol];
    if (typeof iterate !== 'function') return source;
    var counted = {};
    counted[iteratorSymbol] = {
      value: function () {
        var iterator = apply(iterate, source, []);
        if (!isObject(iterator)) throw new TypeErrorCtor('Result of the Symbol.iterator method is not an object');
        var next = iterator.next;
        return {
          next: function () {
            var step = apply(next, iterator, []);
            if (!isObject(step)) throw new TypeErrorCtor('Iterator result is not an object');
            if (step.done) return { done: true, value: undefined };
            if (frame) {
              frame.total += 1;
              checkLength(frame.total, 'Array spread');
            }
            return { done: false, value: step.value };
          },
          return: function (value) {
            var close = iterator.return;
            return typeof close === 'function' ? apply(close, iterator, [value]) : { done: true, value: value };
          }
        };
      }
    };
    return objectCreate(null, counted);
  }

  function arrayFinish(id, array) {
    var largest = 0;
    for (var i = frames.length - 1; i >= 0; i--) {
      if (frames[i].id === id) {
        largest = frames[i].largest;
        frames.length = i;
        break;
      }
    }
    if (isArray(array)) {
      checkLength(array.length, 'Array spread');
      charge(array.length - largest);
    }
    return array;
  }

  var helpers = [[${JSON.stringify(ARRAY_START_FN)}, arrayStart], [${JSON.stringify(ARRAY_SPREAD_FN)}, spread], [${JSON.stringify(
    ARRAY_FINISH_FN,
  )}, arrayFinish], [${JSON.stringify(ARRAY_SET_FN)}, guardedSet], [${JSON.stringify(ARRAY_SLOT_FN)}, slot]];
  for (var h = 0; h < helpers.length; h++) {
    defineProperty(globalThis, helpers[h][0], {
      value: helpers[h][1],
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
})(${numericLiteral('memoryLimit', memoryLimit)}, (typeof __host_memory_track__ === 'function') ? __host_memory_track__ : null);
`.trim();
}
