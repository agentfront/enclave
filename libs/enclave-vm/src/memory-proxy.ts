/**
 * Memory-Tracking Proxies
 *
 * Provides proxied constructors that track memory allocations.
 * Used in conjunction with MemoryTracker to enforce memory limits.
 *
 * @packageDocumentation
 */

import { MemoryTracker, estimateStringSize } from './memory-tracker';

/**
 * Create a memory-tracking String constructor proxy
 *
 * Wraps the String constructor to track string allocations.
 * Tracks both `String()` calls and `new String()` constructions.
 *
 * @param tracker MemoryTracker instance for allocation tracking
 * @returns Proxied String constructor
 */
export function createTrackedString(tracker: MemoryTracker): typeof String {
  return new Proxy(String, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args) as string;
      tracker.trackString(result);
      return result;
    },
    construct(target, args) {
      const result = new target(...(args as [unknown]));
      tracker.trackString(result.valueOf());
      return result;
    },
  });
}

/**
 * Create a memory-tracking Array constructor proxy
 *
 * Wraps the Array constructor and array methods that can grow arrays.
 * Tracks initial allocation and subsequent growth operations.
 *
 * @param tracker MemoryTracker instance for allocation tracking
 * @returns Proxied Array constructor
 */
export function createTrackedArray(tracker: MemoryTracker): typeof Array {
  const TrackedArray = new Proxy(Array, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args) as unknown[];
      if (Array.isArray(result)) {
        tracker.trackArray(result.length);
      }
      return result;
    },
    construct(target, args) {
      const result = new target(...(args as unknown[]));
      tracker.trackArray(result.length);
      return result;
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Wrap static methods that create arrays
      if (prop === 'from') {
        return function (...args: Parameters<typeof Array.from>) {
          const result = Array.from(...args);
          tracker.trackArray(result.length);
          return result;
        };
      }

      if (prop === 'of') {
        return function (...items: unknown[]) {
          const result = Array.of(...items);
          tracker.trackArray(result.length);
          return result;
        };
      }

      return value;
    },
  });

  return TrackedArray;
}

/**
 * Create tracked array prototype methods
 *
 * Returns an object with wrapped array methods that track allocations.
 * These should be applied to the sandbox's Array.prototype.
 *
 * @param tracker MemoryTracker instance for allocation tracking
 * @returns Object with tracked array methods
 */
export function createTrackedArrayMethods(tracker: MemoryTracker): Record<string, unknown> {
  const originalConcat = Array.prototype.concat;
  const originalSlice = Array.prototype.slice;
  const originalSplice = Array.prototype.splice;
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  const originalFlatMap = Array.prototype.flatMap;
  const originalFlat = Array.prototype.flat;

  return {
    // Methods that create new arrays
    concat: function (this: unknown[], ...items: unknown[]) {
      const result = originalConcat.apply(this, items);
      tracker.trackArray(result.length);
      return result;
    },

    slice: function (this: unknown[], start?: number, end?: number) {
      const result = originalSlice.call(this, start, end);
      tracker.trackArray(result.length);
      return result;
    },

    splice: function (this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
      const result = originalSplice.call(this, start, deleteCount ?? 0, ...items);
      // Track both the removed items array and the growth
      tracker.trackArray(result.length);
      if (items.length > (deleteCount ?? 0)) {
        tracker.trackArray(items.length - (deleteCount ?? 0));
      }
      return result;
    },

    map: function <T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U) {
      const result = originalMap.call(this, callback);
      tracker.trackArray(result.length);
      return result;
    },

    filter: function <T>(this: T[], callback: (value: T, index: number, array: T[]) => boolean) {
      const result = originalFilter.call(this, callback);
      tracker.trackArray(result.length);
      return result;
    },

    flatMap: function <T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U | U[]) {
      const result = originalFlatMap.call(this, callback);
      tracker.trackArray(result.length);
      return result;
    },

    flat: function (this: unknown[], depth?: number) {
      const result = originalFlat.call(this, depth);
      tracker.trackArray(result.length);
      return result;
    },
  };
}

/**
 * Create a tracked string concat/repeat implementation
 *
 * The most common memory attack is string doubling via concatenation.
 * This wraps string operations that create new strings.
 *
 * @param tracker MemoryTracker instance for allocation tracking
 * @returns Object with tracked string methods
 */
export function createTrackedStringMethods(tracker: MemoryTracker): Record<string, unknown> {
  const originalConcat = String.prototype.concat;
  const originalRepeat = String.prototype.repeat;
  const originalPadStart = String.prototype.padStart;
  const originalPadEnd = String.prototype.padEnd;

  return {
    concat: function (this: string, ...strings: string[]) {
      const result = originalConcat.apply(this, strings);
      tracker.trackString(result);
      return result;
    },

    repeat: function (this: string, count: number) {
      // Pre-check to avoid allocating before tracking
      const estimatedSize = estimateStringSize(this) * count;
      if (tracker.getLimit() > 0 && estimatedSize > tracker.getLimit()) {
        tracker.track(estimatedSize); // This will throw
      }
      const result = originalRepeat.call(this, count);
      tracker.trackString(result);
      return result;
    },

    padStart: function (this: string, targetLength: number, padString?: string) {
      const result = originalPadStart.call(this, targetLength, padString);
      if (result.length > this.length) {
        tracker.trackString(result);
      }
      return result;
    },

    padEnd: function (this: string, targetLength: number, padString?: string) {
      const result = originalPadEnd.call(this, targetLength, padString);
      if (result.length > this.length) {
        tracker.trackString(result);
      }
      return result;
    },
  };
}

/**
 * Wrap the binary string concatenation operator
 *
 * This is tricky because we can't directly intercept the + operator.
 * Instead, we track string results in the safe runtime by checking
 * types after operations.
 *
 * @param tracker MemoryTracker instance
 * @returns A function that should be called after any operation that might produce a string
 */
export function createStringConcatTracker(
  tracker: MemoryTracker,
): (result: unknown, originalLength?: number) => unknown {
  return (result: unknown, originalLength = 0) => {
    if (typeof result === 'string' && result.length > originalLength) {
      // Only track the growth, not the entire string
      const growth = result.length - originalLength;
      if (growth > 0) {
        tracker.track(growth * 2); // UTF-16: 2 bytes per char
      }
    }
    return result;
  };
}

/**
 * Create all tracked globals for injection into sandbox
 *
 * Returns an object containing all memory-tracked constructors and methods.
 *
 * @param tracker MemoryTracker instance
 * @returns Object with all tracked globals
 */
export function createTrackedGlobals(tracker: MemoryTracker): Record<string, unknown> {
  return {
    String: createTrackedString(tracker),
    Array: createTrackedArray(tracker),
    // Note: We can't easily replace prototype methods without affecting security
    // The tracked array/string methods are available for manual integration
  };
}
