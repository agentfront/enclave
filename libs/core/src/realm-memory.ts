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
  var objectCreate = Object.create;
  var RangeErrorCtor = RangeError;
  var TypeErrorCtor = TypeError;
  var StringCtor = String;
  var arrayProto = Array.prototype;
  var stringProto = String.prototype;
  var ArrayCtor = Array;
  var iteratorSymbol = Symbol.iterator;
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

  /**
   * The receiver of an array built-in, with its length read and converted once.
   *
   * An array is itself. Any other object is stood in for by an object that inherits from it and
   * answers the length that was read here: the built-in reads the length again. Null for a
   * receiver whose length a script cannot make up (a primitive), or that the built-in refuses.
   */
  function arrayLike(value) {
    if (isArray(value)) return { target: value, length: value.length };
    if (!isObject(value)) return null;
    var length = toLength(value.length);
    return {
      target: objectCreate(value, { length: { value: length, writable: true, enumerable: false, configurable: true } }),
      length: length
    };
  }

  /** Rule 1, for a text: that many characters are not made. */
  function checkText(characters, label) {
    if (limited && characters * 2 > memoryLimit) refuse(label, characters * 2);
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

    // flat: counted before it runs, to the depth the built-in flattens. The count walks the
    // nesting with a list of its own, so the depth of the nesting is not the depth of a call
    // stack, and it stops at the limit: by the elements counted so far, and by the arrays
    // entered (an array of empty arrays has nothing to count and everything to visit).
    function countFlat(root, rootLength, levels) {
      var budget = memoryLimit / BYTES;
      var elements = rootLength;
      var entered = 0;
      if (elements > budget) refuse('Array.flat', elements * BYTES);
      var arrays = [root];
      var lengths = [rootLength];
      var depths = [levels];
      var next = [0];
      var top = 0;
      while (top >= 0) {
        var index = next[top];
        if (index >= lengths[top] || !(depths[top] >= 1)) {
          top--;
          continue;
        }
        next[top] = index + 1;
        var item = arrays[top][index];
        if (!isArray(item)) continue;
        // The slot gives way to what the array holds
        var length = item.length;
        elements += length - 1;
        entered++;
        if (elements > budget || entered > budget) {
          refuse('Array.flat', (elements > entered ? elements : entered) * BYTES);
        }
        top++;
        arrays[top] = item;
        lengths[top] = length;
        depths[top] = depths[top - 1] - 1;
        next[top] = 0;
      }
    }
    patch(arrayProto, 'flat', function (original) {
      return function flat(depth) {
        var levels = depth === undefined ? 1 : toInteger(depth);
        if (levels < 0) levels = 0;
        var like = arrayLike(this);
        if (like === null) return apply(original, this, [levels]);
        countFlat(like.target, like.length, levels);
        var result = apply(original, like.target, [levels]);
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
    // The copying methods turn every slot of the receiver into an element, holes included
    var copying = ['toSorted', 'toReversed', 'toSpliced', 'with'];
    for (var c = 0; c < copying.length; c++) {
      (function (name) {
        patch(arrayProto, name, function (original) {
          return function () {
            var like = arrayLike(this);
            if (like === null) return apply(original, this, arguments);
            checkLength(like.length + (name === 'toSpliced' && arguments.length > 2 ? arguments.length - 2 : 0), 'Array.' + name);
            return apply(original, like.target, arguments);
          };
        });
      })(copying[c]);
    }
    // Array.from. Of something with a length: that many elements, whatever is behind it. Of
    // something that is iterated: as many as it yields, so the built-in is stopped at the
    // limit by the mapping function it calls for each element. Which of the two it is, is
    // decided here, once: the built-in is given a source that can only be read that way.
    patch(ArrayCtor, 'from', function (original) {
      return function from(items, mapFn, thisArg) {
        // What the built-in refuses by itself, it refuses before it makes anything
        if (items === null || items === undefined) return apply(original, this, arguments);
        if (mapFn !== undefined && typeof mapFn !== 'function') return apply(original, this, arguments);

        var source = items;
        if (isArray(items)) {
          checkLength(items.length, 'Array.from');
        } else {
          var iterate = items[iteratorSymbol];
          if (iterate === undefined || iterate === null) {
            var like = arrayLike(items);
            if (like !== null) {
              checkLength(like.length, 'Array.from');
              source = like.target;
            }
          } else if (typeof iterate === 'function' && isObject(items)) {
            var held = {};
            held[iteratorSymbol] = { value: function () { return apply(iterate, items, []); } };
            source = objectCreate(null, held);
          }
        }

        var produced = 0;
        var mapped = mapFn !== undefined;
        var result = apply(original, this, [source, function (value, index) {
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
        var array = isArray(this);
        var length = array ? this.length : toLength(this.length);
        var from = relativeIndex(start, length, 0);
        var to = relativeIndex(end, length, length);
        var count = to > from ? to - from : 0;
        checkLength(count, 'Array.fill');
        charge(count);
        if (array) {
          return apply(original, this, [value, from, to]);
        }
        for (var i = from; i < to; i++) {
          this[i] = value;
        }
        return this;
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
