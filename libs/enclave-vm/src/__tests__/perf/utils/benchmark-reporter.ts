/**
 * Jest Custom Reporter for Performance Benchmarks
 *
 * Outputs structured JSON results for CI/CD workflow integration.
 *
 * Usage:
 *   npx nx run enclave-vm:test-perf
 *   # Results written to perf-results.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Reporter, AggregatedResult } from '@jest/reporters';

export interface BenchmarkMetric {
  name: string;
  value: number;
  unit: string;
  threshold?: number;
  passed?: boolean;
}

export interface BenchmarkTestResult {
  testName: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  metrics: BenchmarkMetric[];
}

export interface BenchmarkReport {
  timestamp: string;
  duration: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    memory: string;
  };
  metrics: Record<string, BenchmarkMetric[]>;
  results: BenchmarkTestResult[];
}

// Temp file for storing metrics during test runs
const METRICS_FILE = path.join(os.tmpdir(), 'enclave-perf-metrics.json');

/**
 * Record a benchmark metric (call from within tests)
 */
export function recordMetric(testName: string, name: string, value: number, unit: string, threshold?: number): void {
  const metrics = loadMetricsFromFile();
  if (!metrics[testName]) {
    metrics[testName] = [];
  }
  metrics[testName].push({
    name,
    value,
    unit,
    threshold,
    passed: threshold === undefined ? undefined : value <= threshold,
  });
  saveMetricsToFile(metrics);
}

/**
 * Record multiple metrics at once
 */
export function recordMetrics(
  testName: string,
  metricsArray: Array<{ name: string; value: number; unit: string; threshold?: number }>,
): void {
  const metrics = loadMetricsFromFile();
  if (!metrics[testName]) {
    metrics[testName] = [];
  }
  for (const m of metricsArray) {
    metrics[testName].push({
      name: m.name,
      value: m.value,
      unit: m.unit,
      threshold: m.threshold,
      passed: m.threshold === undefined ? undefined : m.value <= m.threshold,
    });
  }
  saveMetricsToFile(metrics);
}

/**
 * Clear all recorded metrics
 */
export function clearMetrics(): void {
  try {
    fs.unlinkSync(METRICS_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Load metrics from temp file
 */
function loadMetricsFromFile(): Record<string, BenchmarkMetric[]> {
  try {
    const content = fs.readFileSync(METRICS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Save metrics to temp file
 */
function saveMetricsToFile(metrics: Record<string, BenchmarkMetric[]>): void {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
}

/**
 * Get all recorded metrics
 */
export function getAllMetrics(): Record<string, BenchmarkMetric[]> {
  return loadMetricsFromFile();
}

class BenchmarkReporter implements Reporter {
  private outputFile: string;

  constructor(_globalConfig: unknown, options?: { outputFile?: string }) {
    this.outputFile = options?.outputFile || 'perf-results.json';
  }

  onRunComplete(_contexts: Set<unknown>, results: AggregatedResult): void {
    const report = this.buildReport(results);

    // Write to file
    const outputPath = path.resolve(process.cwd(), this.outputFile);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

    console.log(`\n📊 Benchmark results written to: ${outputPath}`);

    // Also print summary to console
    this.printSummary(report);

    // Clean up temp file
    clearMetrics();
  }

  private buildReport(results: AggregatedResult): BenchmarkReport {
    const testResults: BenchmarkTestResult[] = [];
    const allMetrics = getAllMetrics();

    for (const suiteResult of results.testResults) {
      for (const test of suiteResult.testResults) {
        const suiteName = test.ancestorTitles?.join(' > ') || 'Unknown Suite';

        testResults.push({
          testName: test.title,
          suite: suiteName,
          status: test.status as 'passed' | 'failed' | 'skipped',
          duration: test.duration || 0,
          metrics: [],
        });
      }
    }

    return {
      timestamp: new Date().toISOString(),
      duration: results.testResults.reduce((sum, r) => sum + (r.perfStats?.end || 0) - (r.perfStats?.start || 0), 0),
      summary: {
        total: results.numTotalTests,
        passed: results.numPassedTests,
        failed: results.numFailedTests,
        skipped: results.numPendingTests,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        memory: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
      },
      metrics: allMetrics,
      results: testResults,
    };
  }

  private printSummary(report: BenchmarkReport): void {
    console.log('\n' + '='.repeat(60));
    console.log('📈 PERFORMANCE BENCHMARK SUMMARY');
    console.log('='.repeat(60));
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`Environment: Node ${report.environment.node} on ${report.environment.platform}`);
    console.log(`Tests: ${report.summary.passed}/${report.summary.total} passed`);
    console.log('='.repeat(60));

    // Print metrics summary
    const allMetrics: BenchmarkMetric[] = [];
    for (const metrics of Object.values(report.metrics)) {
      allMetrics.push(...metrics);
    }

    if (allMetrics.length > 0) {
      console.log('\nKey Metrics:');
      for (const metric of allMetrics.slice(0, 20)) {
        const status = metric.passed === false ? '❌' : metric.passed === true ? '✅' : '  ';
        console.log(`  ${status} ${metric.name}: ${metric.value.toFixed(2)} ${metric.unit}`);
      }
      if (allMetrics.length > 20) {
        console.log(`  ... and ${allMetrics.length - 20} more metrics`);
      }
    }
  }
}

export default BenchmarkReporter;
