import { numericLiteral } from './enclave-options';
import { COLLECTION_ENTRY_BYTES } from './memory-tracker';

/** Source that defines the realm's `__safe_` Set, Map and error types; `add` and `set` charge each new entry. */
export function realmSafeGlobalsSource(memoryLimit: number): string {
  return `
(function (memoryLimit, track) {
  'use strict';
  var apply = Reflect.apply;
  var construct = Reflect.construct;
  var defineProperty = Object.defineProperty;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var getPrototypeOf = Object.getPrototypeOf;
  var freeze = Object.freeze;
  var RealmSet = Set;
  var RealmMap = Map;
  var RealmString = String;
  var TypeErrorCtor = TypeError;
  var iteratorSymbol = Symbol.iterator;
  var toStringTagSymbol = Symbol.toStringTag;
  var setHas = RealmSet.prototype.has;
  var setAdd = RealmSet.prototype.add;
  var setValues = RealmSet.prototype.values;
  var mapHas = RealmMap.prototype.has;
  var mapSet = RealmMap.prototype.set;
  var mapEntries = RealmMap.prototype.entries;
  var setIteratorNext = getPrototypeOf(apply(setValues, new RealmSet(), [])).next;
  var mapIteratorNext = getPrototypeOf(apply(mapEntries, new RealmMap(), [])).next;
  var limited = memoryLimit > 0 && typeof track === 'function';
  var BATCH_BYTES = 4096;
  var pendingBytes = 0;

  function chargeEntry() {
    if (!limited) {
      return;
    }
    pendingBytes += ${COLLECTION_ENTRY_BYTES};
    if (pendingBytes >= BATCH_BYTES) {
      var bytes = pendingBytes;
      pendingBytes = 0;
      track(bytes);
    }
  }

  function defineMethod(target, key, value) {
    defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }

  function itemsOf(collection, iterate, next) {
    var items = [];
    var iterator = apply(iterate, collection, []);
    for (var step = apply(next, iterator, []); !step.done; step = apply(next, iterator, [])) {
      items[items.length] = step.value;
    }
    return items;
  }

  function makeCollection(BuiltIn, name, readerNames, grow, toJSON) {
    var builtInPrototype = BuiltIn.prototype;
    var prototype = {};
    var Collection = function (entries) {
      if (new.target === undefined) {
        throw new TypeErrorCtor('Constructor ' + name + " requires 'new'");
      }
      return construct(BuiltIn, entries === undefined || entries === null ? [] : [entries], Collection);
    };
    for (var i = 0; i < readerNames.length; i++) {
      defineMethod(prototype, readerNames[i], builtInPrototype[readerNames[i]]);
    }
    defineMethod(prototype, grow.name, grow);
    defineMethod(prototype, 'toJSON', toJSON);
    defineMethod(prototype, 'constructor', Collection);
    defineMethod(prototype, iteratorSymbol, builtInPrototype[iteratorSymbol]);
    var sizeGetter = getOwnPropertyDescriptor(builtInPrototype, 'size').get;
    defineProperty(prototype, 'size', { get: sizeGetter, configurable: true });
    defineProperty(prototype, toStringTagSymbol, { value: name, configurable: true });
    defineProperty(Collection, 'name', { value: name, configurable: true });
    Collection.prototype = freeze(prototype);
    return freeze(Collection);
  }

  function makeErrorType(BuiltIn, name) {
    var ErrorType = function (message) {
      var error = construct(BuiltIn, []);
      defineProperty(error, 'name', { value: name, enumerable: true });
      defineProperty(error, 'message', { value: message === undefined ? '' : RealmString(message), enumerable: true });
      defineProperty(error, 'stack', { value: undefined });
      return freeze(error);
    };
    defineProperty(ErrorType, 'name', { value: name, configurable: true });
    ErrorType.prototype = BuiltIn.prototype;
    return freeze(ErrorType);
  }

  var add = function add(value) {
    if (!apply(setHas, this, [value])) {
      chargeEntry();
    }
    return apply(setAdd, this, [value]);
  };
  var set = function set(key, value) {
    if (!apply(mapHas, this, [key])) {
      chargeEntry();
    }
    return apply(mapSet, this, [key, value]);
  };
  var setToJSON = function toJSON() {
    return itemsOf(this, setValues, setIteratorNext);
  };
  var mapToJSON = function toJSON() {
    return itemsOf(this, mapEntries, mapIteratorNext);
  };
  var setReaders = ['has', 'delete', 'clear', 'forEach', 'values', 'keys', 'entries'];
  var mapReaders = ['get', 'has', 'delete', 'clear', 'forEach', 'keys', 'values', 'entries'];
  var safeGlobals = [
    ['__safe_Set', makeCollection(RealmSet, 'Set', setReaders, add, setToJSON)],
    ['__safe_Map', makeCollection(RealmMap, 'Map', mapReaders, set, mapToJSON)],
    ['__safe_Error', makeErrorType(Error, 'Error')],
    ['__safe_TypeError', makeErrorType(TypeError, 'TypeError')],
    ['__safe_RangeError', makeErrorType(RangeError, 'RangeError')]
  ];
  for (var g = 0; g < safeGlobals.length; g++) {
    // Configurable: a custom global of the same name is defined after it, under its __safe_ name too
    defineProperty(globalThis, safeGlobals[g][0], { value: safeGlobals[g][1], configurable: true });
  }
})(
  ${numericLiteral('memoryLimit', memoryLimit)},
  (typeof __host_memory_track__ === 'function') ? __host_memory_track__ : null
);
`.trim();
}
