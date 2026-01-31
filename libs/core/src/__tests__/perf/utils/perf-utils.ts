/**
 * Performance measurement utilities for benchmarking
 */

export interface TimingResult {
  durationMs: number;
  startTime: number;
  endTime: number;
}

export interface BenchmarkSample {
  iteration: number;
  timing: TimingResult;
  memoryBefore?: NodeJS.MemoryUsage;
  memoryAfter?: NodeJS.MemoryUsage;
  success: boolean;
  error?: Error;
}

export interface BenchmarkOptions {
  /** Number of warmup iterations (not included in measurements). Default: 5 */
  warmupIterations: number;
  /** Number of measurement iterations. Default: 100 */
  measurementIterations: number;
  /** Cooldown time between iterations in ms. Default: 0 */
  cooldownMs: number;
  /** Whether to force GC between iterations (requires --expose-gc). Default: false */
  gcBetweenIterations: boolean;
  /** Whether to capture memory usage. Default: false */
  captureMemory: boolean;
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  warmupIterations: 5,
  measurementIterations: 100,
  cooldownMs: 0,
  gcBetweenIterations: false,
  captureMemory: false,
};

/**
 * Measure the execution time of an async function
 */
export async function measureAsync<T>(fn: () => Promise<T>): Promise<{ result: T; timing: TimingResult }> {
  const startTime = performance.now();
  const result = await fn();
  const endTime = performance.now();

  return {
    result,
    timing: {
      durationMs: endTime - startTime,
      startTime,
      endTime,
    },
  };
}

/**
 * Measure the execution time of a sync function
 */
export function measureSync<T>(fn: () => T): { result: T; timing: TimingResult } {
  const startTime = performance.now();
  const result = fn();
  const endTime = performance.now();

  return {
    result,
    timing: {
      durationMs: endTime - startTime,
      startTime,
      endTime,
    },
  };
}

/**
 * Force garbage collection if available (requires --expose-gc flag)
 */
export function forceGC(): void {
  if (global.gc) {
    global.gc();
  }
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a benchmark with warmup and measurement iterations
 */
export async function benchmark(
  name: string,
  fn: () => Promise<unknown>,
  options?: Partial<BenchmarkOptions>,
): Promise<BenchmarkSample[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const samples: BenchmarkSample[] = [];

  // Warmup phase
  for (let i = 0; i < opts.warmupIterations; i++) {
    try {
      await fn();
    } catch {
      // Ignore warmup errors
    }
    if (opts.cooldownMs > 0) {
      await sleep(opts.cooldownMs);
    }
  }

  // Force GC before measurements
  if (opts.gcBetweenIterations) {
    forceGC();
  }

  // Measurement phase
  for (let i = 0; i < opts.measurementIterations; i++) {
    const memoryBefore = opts.captureMemory ? process.memoryUsage() : undefined;

    let success = true;
    let error: Error | undefined;
    let timing: TimingResult;

    try {
      const result = await measureAsync(fn);
      timing = result.timing;
    } catch (e) {
      success = false;
      error = e instanceof Error ? e : new Error(String(e));
      timing = { durationMs: 0, startTime: 0, endTime: 0 };
    }

    const memoryAfter = opts.captureMemory ? process.memoryUsage() : undefined;

    samples.push({
      iteration: i,
      timing,
      memoryBefore,
      memoryAfter,
      success,
      error,
    });

    if (opts.gcBetweenIterations) {
      forceGC();
    }

    if (opts.cooldownMs > 0) {
      await sleep(opts.cooldownMs);
    }
  }

  return samples;
}

/**
 * Run a sync benchmark with warmup and measurement iterations
 */
export function benchmarkSync(name: string, fn: () => unknown, options?: Partial<BenchmarkOptions>): BenchmarkSample[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const samples: BenchmarkSample[] = [];

  // Warmup phase
  for (let i = 0; i < opts.warmupIterations; i++) {
    try {
      fn();
    } catch {
      // Ignore warmup errors
    }
  }

  // Force GC before measurements
  if (opts.gcBetweenIterations) {
    forceGC();
  }

  // Measurement phase
  for (let i = 0; i < opts.measurementIterations; i++) {
    const memoryBefore = opts.captureMemory ? process.memoryUsage() : undefined;

    let success = true;
    let error: Error | undefined;
    let timing: TimingResult;

    try {
      const result = measureSync(fn);
      timing = result.timing;
    } catch (e) {
      success = false;
      error = e instanceof Error ? e : new Error(String(e));
      timing = { durationMs: 0, startTime: 0, endTime: 0 };
    }

    const memoryAfter = opts.captureMemory ? process.memoryUsage() : undefined;

    samples.push({
      iteration: i,
      timing,
      memoryBefore,
      memoryAfter,
      success,
      error,
    });

    if (opts.gcBetweenIterations) {
      forceGC();
    }
  }

  return samples;
}
