/**
 * Memory measurement utilities for benchmarking
 */

export interface MemorySnapshot {
  timestamp: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryTrackingResult<T> {
  result: T;
  baseline: MemorySnapshot;
  peak: MemorySnapshot;
  final: MemorySnapshot;
  samples: MemorySnapshot[];
  peakHeapUsed: number;
  peakRss: number;
  heapDelta: number;
  rssDelta: number;
}

/**
 * Capture a memory snapshot
 */
export function captureMemory(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    timestamp: performance.now(),
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

/**
 * Force garbage collection if available
 */
export function forceGC(): boolean {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Track memory usage during an async operation
 */
export async function trackMemory<T>(
  fn: () => Promise<T>,
  options?: {
    sampleIntervalMs?: number;
    forceGCBefore?: boolean;
    forceGCAfter?: boolean;
  },
): Promise<MemoryTrackingResult<T>> {
  const opts = {
    sampleIntervalMs: 10,
    forceGCBefore: true,
    forceGCAfter: true,
    ...options,
  };

  // Force GC before measurement
  if (opts.forceGCBefore) {
    forceGC();
  }

  const samples: MemorySnapshot[] = [];
  const baseline = captureMemory();
  samples.push(baseline);

  let peak = baseline;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  // Start sampling
  if (opts.sampleIntervalMs > 0) {
    intervalId = setInterval(() => {
      const snapshot = captureMemory();
      samples.push(snapshot);
      if (snapshot.heapUsed > peak.heapUsed) {
        peak = snapshot;
      }
    }, opts.sampleIntervalMs);
  }

  try {
    const result = await fn();

    // Stop sampling
    if (intervalId) {
      clearInterval(intervalId);
    }

    // Capture final state
    const finalSnapshot = captureMemory();
    samples.push(finalSnapshot);

    if (finalSnapshot.heapUsed > peak.heapUsed) {
      peak = finalSnapshot;
    }

    // Force GC after and capture cleaned state
    if (opts.forceGCAfter) {
      forceGC();
    }
    const cleanedSnapshot = captureMemory();

    return {
      result,
      baseline,
      peak,
      final: cleanedSnapshot,
      samples,
      peakHeapUsed: peak.heapUsed,
      peakRss: Math.max(...samples.map((s) => s.rss)),
      heapDelta: cleanedSnapshot.heapUsed - baseline.heapUsed,
      rssDelta: cleanedSnapshot.rss - baseline.rss,
    };
  } catch (error) {
    if (intervalId) {
      clearInterval(intervalId);
    }
    throw error;
  }
}

/**
 * Track memory usage during a sync operation
 */
export function trackMemorySync<T>(
  fn: () => T,
  options?: {
    forceGCBefore?: boolean;
    forceGCAfter?: boolean;
  },
): Omit<MemoryTrackingResult<T>, 'samples'> & { samples: MemorySnapshot[] } {
  const opts = {
    forceGCBefore: true,
    forceGCAfter: true,
    ...options,
  };

  if (opts.forceGCBefore) {
    forceGC();
  }

  const baseline = captureMemory();
  const result = fn();
  const afterExec = captureMemory();

  if (opts.forceGCAfter) {
    forceGC();
  }
  const final = captureMemory();

  const peak = afterExec.heapUsed > baseline.heapUsed ? afterExec : baseline;

  return {
    result,
    baseline,
    peak,
    final,
    samples: [baseline, afterExec, final],
    peakHeapUsed: peak.heapUsed,
    peakRss: Math.max(baseline.rss, afterExec.rss, final.rss),
    heapDelta: final.heapUsed - baseline.heapUsed,
    rssDelta: final.rss - baseline.rss,
  };
}

/**
 * Format bytes as a human-readable string
 */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const absBytes = Math.abs(bytes);

  if (absBytes < 1024) return `${sign}${absBytes} B`;
  if (absBytes < 1024 * 1024) return `${sign}${(absBytes / 1024).toFixed(2)} KB`;
  if (absBytes < 1024 * 1024 * 1024) return `${sign}${(absBytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${sign}${(absBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Create a memory usage summary string
 */
export function formatMemorySummary(result: MemoryTrackingResult<unknown>): string {
  return [
    `Memory Summary:`,
    `  Baseline heap: ${formatBytes(result.baseline.heapUsed)}`,
    `  Peak heap: ${formatBytes(result.peakHeapUsed)}`,
    `  Final heap: ${formatBytes(result.final.heapUsed)}`,
    `  Heap delta: ${formatBytes(result.heapDelta)}`,
    `  Peak RSS: ${formatBytes(result.peakRss)}`,
    `  RSS delta: ${formatBytes(result.rssDelta)}`,
  ].join('\n');
}

/**
 * Measure memory footprint of creating an object
 */
export async function measureObjectFootprint<T>(
  factory: () => T | Promise<T>,
  options?: {
    iterations?: number;
    forceGC?: boolean;
  },
): Promise<{
  averageFootprint: number;
  minFootprint: number;
  maxFootprint: number;
}> {
  const opts = {
    iterations: 10,
    forceGC: true,
    ...options,
  };

  const footprints: number[] = [];

  for (let i = 0; i < opts.iterations; i++) {
    if (opts.forceGC) {
      forceGC();
    }

    const before = captureMemory();
    const obj = await factory();
    const after = captureMemory();

    // Keep reference to prevent GC
    footprints.push(after.heapUsed - before.heapUsed);

    // Clear reference
    void obj;
  }

  return {
    averageFootprint: footprints.reduce((a, b) => a + b, 0) / footprints.length,
    minFootprint: Math.min(...footprints),
    maxFootprint: Math.max(...footprints),
  };
}
