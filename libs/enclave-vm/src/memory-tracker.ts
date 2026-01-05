/**
 * Memory Tracker for VM Execution
 *
 * Provides allocation tracking and memory limit enforcement for the VM adapter.
 * Since Node.js vm module doesn't support native memory limits, this tracker
 * monitors allocations via instrumented code and proxy wrappers.
 *
 * @packageDocumentation
 */

/**
 * Configuration for memory tracking
 */
export interface MemoryTrackerConfig {
  /** Maximum total bytes allowed (0 = unlimited) */
  memoryLimit: number;
  /** Enable string size tracking */
  trackStrings: boolean;
  /** Enable array size tracking */
  trackArrays: boolean;
  /** Enable object property tracking */
  trackObjects: boolean;
}

/**
 * Snapshot of memory usage at a point in time
 */
export interface MemoryUsageSnapshot {
  /** Current tracked bytes (sum of estimated allocation sizes) */
  trackedBytes: number;
  /** Peak tracked bytes during execution */
  peakTrackedBytes: number;
  /** Number of allocation operations tracked */
  allocationCount: number;
}

/**
 * Error thrown when memory limit is exceeded
 */
export class MemoryLimitError extends Error {
  /** Error code for identification */
  public readonly code = 'MEMORY_LIMIT_EXCEEDED';

  constructor(
    message: string,
    /** Bytes used when limit was exceeded */
    public readonly usedBytes: number,
    /** Configured limit in bytes */
    public readonly limitBytes: number,
  ) {
    super(message);
    this.name = 'MemoryLimitError';
    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MemoryLimitError);
    }
  }
}

/**
 * Estimate the memory size of a string in V8
 *
 * V8 uses 2 bytes per character (UTF-16) plus object overhead.
 * For strings > 12 chars, V8 uses heap allocation with ~40 bytes overhead.
 * For short strings, V8 may use inline storage.
 *
 * @param str String to estimate size for
 * @returns Estimated size in bytes
 */
export function estimateStringSize(str: string): number {
  // UTF-16 encoding: 2 bytes per character
  // Object overhead: ~40 bytes for heap strings
  // Short strings (<= 12 chars) may be inline, but we still count them
  return str.length * 2 + 40;
}

/**
 * Estimate the memory size of an array in V8
 *
 * Arrays have object overhead plus pointers to elements.
 * We estimate 8 bytes per element (pointer size on 64-bit).
 *
 * @param length Array length
 * @param elementEstimate Optional per-element size estimate
 * @returns Estimated size in bytes
 */
export function estimateArraySize(length: number, elementEstimate = 8): number {
  // Array object overhead: ~32 bytes
  // Each element: pointer (8 bytes) + element overhead
  return 32 + length * elementEstimate;
}

/**
 * Estimate the memory size of an object in V8
 *
 * Objects have base overhead plus per-property storage.
 *
 * @param propertyCount Number of properties
 * @returns Estimated size in bytes
 */
export function estimateObjectSize(propertyCount: number): number {
  // Object overhead: ~56 bytes (header, hidden class pointer, etc.)
  // Per property: ~32 bytes (key, value, descriptor)
  return 56 + propertyCount * 32;
}

/**
 * Memory tracker for VM execution
 *
 * Tracks allocations via instrumented code and enforces memory limits.
 * Use `start()` before execution and `getSnapshot()` after for stats.
 *
 * @example
 * ```typescript
 * const tracker = new MemoryTracker({ memoryLimit: 10 * 1024 * 1024 }); // 10MB
 * tracker.start();
 *
 * // During execution, track allocations:
 * tracker.track(estimateStringSize(someString));
 *
 * // After execution, get stats:
 * const snapshot = tracker.getSnapshot();
 * console.log(`Peak memory: ${snapshot.peakTrackedBytes} bytes`);
 * ```
 */
export class MemoryTracker {
  private trackedBytes = 0;
  private peakTrackedBytes = 0;
  private allocationCount = 0;
  private readonly config: MemoryTrackerConfig;

  constructor(config: Partial<MemoryTrackerConfig> = {}) {
    this.config = {
      memoryLimit: config.memoryLimit ?? 0,
      trackStrings: config.trackStrings ?? true,
      trackArrays: config.trackArrays ?? true,
      trackObjects: config.trackObjects ?? true,
    };
  }

  /**
   * Start tracking (resets all counters)
   */
  start(): void {
    this.trackedBytes = 0;
    this.peakTrackedBytes = 0;
    this.allocationCount = 0;
  }

  /**
   * Track an allocation
   *
   * @param bytes Number of bytes allocated
   * @throws {MemoryLimitError} If memory limit is exceeded
   */
  track(bytes: number): void {
    if (bytes <= 0) return;

    this.trackedBytes += bytes;
    this.allocationCount++;

    if (this.trackedBytes > this.peakTrackedBytes) {
      this.peakTrackedBytes = this.trackedBytes;
    }

    // Check limit (0 = unlimited)
    if (this.config.memoryLimit > 0 && this.trackedBytes > this.config.memoryLimit) {
      throw new MemoryLimitError(
        `Memory limit exceeded: ${this.formatBytes(this.trackedBytes)} used > ${this.formatBytes(
          this.config.memoryLimit,
        )} limit`,
        this.trackedBytes,
        this.config.memoryLimit,
      );
    }
  }

  /**
   * Track a string allocation
   *
   * @param str String that was allocated
   * @throws {MemoryLimitError} If memory limit is exceeded
   */
  trackString(str: string): void {
    if (!this.config.trackStrings) return;
    this.track(estimateStringSize(str));
  }

  /**
   * Track an array allocation
   *
   * @param length Array length
   * @param elementEstimate Optional per-element size estimate
   * @throws {MemoryLimitError} If memory limit is exceeded
   */
  trackArray(length: number, elementEstimate?: number): void {
    if (!this.config.trackArrays) return;
    this.track(estimateArraySize(length, elementEstimate));
  }

  /**
   * Track an object allocation
   *
   * @param propertyCount Number of properties
   * @throws {MemoryLimitError} If memory limit is exceeded
   */
  trackObject(propertyCount: number): void {
    if (!this.config.trackObjects) return;
    this.track(estimateObjectSize(propertyCount));
  }

  /**
   * Release tracked memory (for GC simulation)
   *
   * @param bytes Number of bytes to release
   */
  release(bytes: number): void {
    this.trackedBytes = Math.max(0, this.trackedBytes - bytes);
  }

  /**
   * Get current memory usage snapshot
   *
   * @returns Snapshot of memory usage
   */
  getSnapshot(): MemoryUsageSnapshot {
    return {
      trackedBytes: this.trackedBytes,
      peakTrackedBytes: this.peakTrackedBytes,
      allocationCount: this.allocationCount,
    };
  }

  /**
   * Get configured memory limit
   *
   * @returns Memory limit in bytes (0 = unlimited)
   */
  getLimit(): number {
    return this.config.memoryLimit;
  }

  /**
   * Check if tracking is enabled
   *
   * @returns True if any tracking is enabled
   */
  isEnabled(): boolean {
    return this.config.trackStrings || this.config.trackArrays || this.config.trackObjects;
  }

  /**
   * Format bytes as human-readable string
   *
   * @param bytes Number of bytes
   * @returns Formatted string (e.g., "10.5MB")
   */
  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)}KB`;
    return `${bytes}B`;
  }
}
