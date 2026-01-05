/**
 * Statistical utilities for benchmark analysis
 */

import type { BenchmarkSample } from './perf-utils';

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
}

export interface ThroughputStats {
  totalExecutions: number;
  totalDurationMs: number;
  executionsPerSecond: number;
  successRate: number;
  successCount: number;
  errorCount: number;
}

export interface MemoryStats {
  heapUsedMin: number;
  heapUsedMax: number;
  heapUsedMean: number;
  heapUsedDelta: number;
  rssMin: number;
  rssMax: number;
  rssMean: number;
  rssDelta: number;
}

export interface BenchmarkReport {
  name: string;
  latency: LatencyStats;
  throughput: ThroughputStats;
  memory?: MemoryStats;
  samples: number;
  warmupSamples: number;
}

/**
 * Calculate a specific percentile from a sorted array
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];

  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calculate mean of an array
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Calculate standard deviation
 */
export function stdDev(values: number[], valueMean?: number): number {
  if (values.length === 0) return 0;
  const avg = valueMean ?? mean(values);
  const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

/**
 * Calculate latency statistics from duration values
 */
export function calculateLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      stdDev: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      p999: 0,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const avg = mean(sorted);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: avg,
    median: percentile(sorted, 0.5),
    stdDev: stdDev(sorted, avg),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
  };
}

/**
 * Calculate throughput statistics from samples
 */
export function calculateThroughputStats(samples: BenchmarkSample[]): ThroughputStats {
  const successCount = samples.filter((s) => s.success).length;
  const errorCount = samples.length - successCount;
  const totalDurationMs = samples.reduce((sum, s) => sum + s.timing.durationMs, 0);

  return {
    totalExecutions: samples.length,
    totalDurationMs,
    executionsPerSecond: totalDurationMs > 0 ? (samples.length / totalDurationMs) * 1000 : 0,
    successRate: samples.length > 0 ? successCount / samples.length : 0,
    successCount,
    errorCount,
  };
}

/**
 * Calculate memory statistics from samples
 */
export function calculateMemoryStats(samples: BenchmarkSample[]): MemoryStats | undefined {
  const samplesWithMemory = samples.filter((s) => s.memoryBefore && s.memoryAfter);
  if (samplesWithMemory.length === 0) return undefined;

  const heapUsedBefore = samplesWithMemory.map((s) => s.memoryBefore!.heapUsed);
  const heapUsedAfter = samplesWithMemory.map((s) => s.memoryAfter!.heapUsed);
  const rssBefore = samplesWithMemory.map((s) => s.memoryBefore!.rss);
  const rssAfter = samplesWithMemory.map((s) => s.memoryAfter!.rss);

  const heapDeltas = samplesWithMemory.map((s) => s.memoryAfter!.heapUsed - s.memoryBefore!.heapUsed);
  const rssDeltas = samplesWithMemory.map((s) => s.memoryAfter!.rss - s.memoryBefore!.rss);

  return {
    heapUsedMin: Math.min(...heapUsedBefore, ...heapUsedAfter),
    heapUsedMax: Math.max(...heapUsedBefore, ...heapUsedAfter),
    heapUsedMean: mean([...heapUsedBefore, ...heapUsedAfter]),
    heapUsedDelta: mean(heapDeltas),
    rssMin: Math.min(...rssBefore, ...rssAfter),
    rssMax: Math.max(...rssBefore, ...rssAfter),
    rssMean: mean([...rssBefore, ...rssAfter]),
    rssDelta: mean(rssDeltas),
  };
}

/**
 * Generate a full benchmark report from samples
 */
export function calculateReport(name: string, samples: BenchmarkSample[], warmupSamples = 0): BenchmarkReport {
  const durations = samples.filter((s) => s.success).map((s) => s.timing.durationMs);

  return {
    name,
    latency: calculateLatencyStats(durations),
    throughput: calculateThroughputStats(samples),
    memory: calculateMemoryStats(samples),
    samples: samples.length,
    warmupSamples,
  };
}

/**
 * Format a benchmark report as a human-readable string
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [
    `=== ${report.name} ===`,
    '',
    'Latency (ms):',
    `  min: ${report.latency.min.toFixed(3)}`,
    `  max: ${report.latency.max.toFixed(3)}`,
    `  mean: ${report.latency.mean.toFixed(3)}`,
    `  stdDev: ${report.latency.stdDev.toFixed(3)}`,
    `  p50: ${report.latency.p50.toFixed(3)}`,
    `  p95: ${report.latency.p95.toFixed(3)}`,
    `  p99: ${report.latency.p99.toFixed(3)}`,
    '',
    'Throughput:',
    `  executions/sec: ${report.throughput.executionsPerSecond.toFixed(2)}`,
    `  success rate: ${(report.throughput.successRate * 100).toFixed(1)}%`,
    `  total samples: ${report.samples}`,
  ];

  if (report.memory) {
    lines.push(
      '',
      'Memory:',
      `  heap used (mean): ${formatBytes(report.memory.heapUsedMean)}`,
      `  heap delta: ${formatBytes(report.memory.heapUsedDelta)}`,
      `  rss (mean): ${formatBytes(report.memory.rssMean)}`,
      `  rss delta: ${formatBytes(report.memory.rssDelta)}`,
    );
  }

  return lines.join('\n');
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
 * Compare two benchmark reports
 */
export function compareReports(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
): {
  latencyChange: number;
  throughputChange: number;
  isRegression: boolean;
} {
  const latencyChange =
    baseline.latency.p95 > 0 ? ((current.latency.p95 - baseline.latency.p95) / baseline.latency.p95) * 100 : 0;

  const throughputChange =
    baseline.throughput.executionsPerSecond > 0
      ? ((current.throughput.executionsPerSecond - baseline.throughput.executionsPerSecond) /
          baseline.throughput.executionsPerSecond) *
        100
      : 0;

  // Consider it a regression if p95 latency increased by >10% or throughput decreased by >10%
  const isRegression = latencyChange > 10 || throughputChange < -10;

  return {
    latencyChange,
    throughputChange,
    isRegression,
  };
}
