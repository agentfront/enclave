/**
 * Accounting for arrays that grow, inside a sandbox realm
 *
 * `memoryLimit` is an estimate over the operations that make data grow. For strings those are
 * concatenation and the amplifying methods (`repeat`, `padStart`, `padEnd`, `join`); `fill` was
 * the one array operation. An array could otherwise grow without the limit seeing it, and a few
 * dozen doublings are enough to exhaust the host's heap.
 *
 * The source below is evaluated in the script's realm, next to the string patches, while the
 * realm is still being set up. Two rules, the same as for strings:
 *
 * 1. No single array is larger than the limit holds (8 bytes per element). Where the size of
 *    the result is known before the built-in runs, it is refused before; a built-in that turns
 *    a length into that many elements (`Array.from({ length })`, the copying methods on an array
 *    with holes) is among those.
 * 2. What an operation ADDS is charged to the execution's total: the elements pushed, spliced
 *    or unshifted in, the elements `concat`, `flat`, `flatMap` and a spread literal add to the
 *    largest array they started from, the elements `Array.from` makes out of something that is
 *    not an array. A plain copy adds nothing.
 *
 * What it does not cover: a copy is free, so a script can still hold many arrays that are each
 * within the limit; object literals, Maps and Sets are not counted. The limit is an estimate,
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
  var RangeErrorCtor = RangeError;
  var arrayProto = Array.prototype;
  var ArrayCtor = Array;
  var limited = memoryLimit > 0 && typeof track === 'function';
  var BYTES = ${ARRAY_ELEMENT_BYTES};
  // Charged to the tracker in batches: a call into the host for every pushed element is not
  // affordable, and what is pending is at most this much.
  var BATCH = 4096;
  var pending = 0;

  // A refusal goes through the tracker, which answers an amount over the limit with the
  // execution's memory-limit error; the RangeError is for a tracker that did not.
  function refuse(label, bytes) {
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

  function patch(holder, name, make) {
    var original = holder[name];
    if (typeof original !== 'function') return;
    var replacement = make(original);
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
    patch(arrayProto, 'unshift', function (original) {
      return function unshift() {
        charge(arguments.length);
        return apply(original, this, arguments);
      };
    });
    // splice: the arguments after the first two are inserted
    patch(arrayProto, 'splice', function (original) {
      return function splice() {
        if (arguments.length > 2) charge(arguments.length - 2);
        return apply(original, this, arguments);
      };
    });
    // concat: the result has the receiver's elements plus, per argument, its elements or itself
    patch(arrayProto, 'concat', function (original) {
      return function concat() {
        var own = lengthOf(this);
        var total = own;
        for (var i = 0; i < arguments.length; i++) {
          total += isArray(arguments[i]) ? arguments[i].length : 1;
        }
        checkLength(total, 'Array.concat');
        var result = apply(original, this, arguments);
        charge(lengthOf(result) - own);
        return result;
      };
    });
    // flat: counted before it runs, down to the depth asked for, stopping at the limit
    patch(arrayProto, 'flat', function (original) {
      function count(array, depth, budget) {
        var length = array.length;
        for (var i = 0; i < length; i++) {
          var item = array[i];
          if (depth >= 1 && isArray(item)) {
            count(item, depth - 1, budget);
          } else {
            budget.elements++;
          }
          if (budget.elements * BYTES > memoryLimit) refuse('Array.flat', budget.elements * BYTES);
        }
      }
      return function flat(depth) {
        if (isArray(this)) {
          var levels = depth === undefined ? 1 : +depth;
          if (!(levels >= 0)) levels = 0;
          if (levels > 64) levels = 64;
          count(this, levels, { elements: 0 });
        }
        var result = apply(original, this, arguments);
        charge(lengthOf(result) - lengthOf(this));
        return result;
      };
    });
    // flatMap: what the callback hands back is counted as it comes
    patch(arrayProto, 'flatMap', function (original) {
      return function flatMap(callback, thisArg) {
        if (typeof callback !== 'function') return apply(original, this, arguments);
        var produced = 0;
        var result = apply(original, this, [function (value, index, array) {
          var item = apply(callback, this, [value, index, array]);
          produced += isArray(item) ? item.length : 1;
          checkLength(produced, 'Array.flatMap');
          return item;
        }, thisArg]);
        charge(lengthOf(result) - lengthOf(this));
        return result;
      };
    });
    // The copying methods turn every hole of the receiver into an element
    var copying = ['toSorted', 'toReversed', 'toSpliced', 'with'];
    for (var c = 0; c < copying.length; c++) {
      (function (name) {
        patch(arrayProto, name, function (original) {
          return function () {
            checkLength(lengthOf(this) + (name === 'toSpliced' && arguments.length > 2 ? arguments.length - 2 : 0), 'Array.' + name);
            return apply(original, this, arguments);
          };
        });
      })(copying[c]);
    }
    // Array.from: a length is that many elements, whatever is behind it
    patch(ArrayCtor, 'from', function (original) {
      return function from(items) {
        if (items !== null && items !== undefined) {
          checkLength(items.length, 'Array.from');
        }
        var result = apply(original, this, arguments);
        checkLength(lengthOf(result), 'Array.from');
        if (!isArray(items)) charge(lengthOf(result));
        return result;
      };
    });
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
    if (isArray(source)) {
      var length = source.length;
      checkLength(length, 'Array spread');
      var frame = frames.length > 0 ? frames[frames.length - 1] : null;
      if (frame) {
        frame.total += length;
        if (length > frame.largest) frame.largest = length;
        checkLength(frame.total, 'Array spread');
      }
    }
    return source;
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
  )}, arrayFinish]];
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
