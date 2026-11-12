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
 *    reads the elements of arrays too, so its result is built in the pass that counts it, and
 *    the built-in does not run. Otherwise an array is handed on as it is: its length is its
 *    own, and nothing here reads its elements before the built-in does. That rests on one
 *    property of the realm: a script has no `Proxy` to put in front of an array (ATK-GLOBALS,
 *    ATK-MEMACC-21).
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
  var ObjectCtor = Object;
  var construct = Reflect.construct;
  var RangeErrorCtor = RangeError;
  var TypeErrorCtor = TypeError;
  var StringCtor = String;
  var arrayProto = Array.prototype;
  var stringProto = String.prototype;
  var ArrayCtor = Array;
  var iteratorSymbol = Symbol.iterator;
  var speciesSymbol = Symbol.species;
  var spreadableSymbol = Symbol.isConcatSpreadable;
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
    // concat: the result has, for the receiver and each argument, its elements or itself.
    // Which of the two is asked here, once, the way the built-in asks (the language's symbol
    // for it, otherwise whether it is an array). An array is handed on as it is. An object
    // that is spread is read here; one that is not goes in an array of one, so the built-in
    // has nothing to ask it a second time.
    patch(arrayProto, 'concat', function (original) {
      return function concat() {
        var receiver = toObject(this);
        if (receiver === null) return apply(original, this, arguments);
        var total = 0;
        var own = 0;
        var first = receiver;
        var rest = [];
        for (var i = -1; i < arguments.length; i++) {
          var item = i < 0 ? receiver : arguments[i];
          var handed = item;
          if (isObject(item)) {
            var array = isArray(item);
            var flag = item[spreadableSymbol];
            if (flag === undefined ? array : !!flag) {
              var length = toLength(item.length);
              total += length;
              checkLength(total, 'Array.concat');
              if (!array) handed = snapshot(item, length, true);
              else if (i < 0) own = length;
            } else {
              total += 1;
              // The receiver, when it is an array, stays the receiver: the result is of its kind
              if (!(array && i < 0)) handed = [item];
            }
          } else {
            total += 1;
          }
          if (i >= 0) {
            rest[rest.length] = handed;
          } else if (handed !== item) {
            first = [];
            rest[rest.length] = handed;
          }
        }
        checkLength(total, 'Array.concat');
        var result = apply(original, first, rest);
        charge(lengthOf(result) - own);
        return result;
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
            checkLength(length + (name === 'toSpliced' && arguments.length > 2 ? arguments.length - 2 : 0), 'Array.' + name);
            return apply(original, isArray(receiver) ? receiver : snapshot(receiver, length, false), arguments);
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
        } else if (typeof iterate === 'function' && isObject(items)) {
          var held = {};
          held[iteratorSymbol] = { value: function () { return apply(iterate, items, []); } };
          source = objectCreate(null, held);
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
