/**
 * Babel Transform Performance Tests
 *
 * Measures transform throughput, latency, and performance characteristics
 * across different complexity levels.
 *
 * @packageDocumentation
 */

import { createRestrictedBabel, resetBabelContext, BabelWrapperConfig } from '../../babel';
import {
  BABEL_EXAMPLES,
  COMPLEXITY_LEVELS,
  getExamplesByLevel,
  getLevelStats,
  ComplexityLevel,
} from '../babel-examples';
import { benchmark, benchmarkSync } from './utils/perf-utils';
import { calculateLatencyStats, calculateReport, formatReport } from './utils/statistics';
import { recordMetric, recordMetrics } from './utils/benchmark-reporter';

describe('Babel Transform Performance', () => {
  const defaultConfig: BabelWrapperConfig = {
    maxInputSize: 1024 * 1024,
    maxOutputSize: 5 * 1024 * 1024,
    allowedPresets: ['typescript', 'react'],
    transformTimeout: 15000,
  };

  let babel: ReturnType<typeof createRestrictedBabel>;

  beforeAll(() => {
    babel = createRestrictedBabel(defaultConfig);
    // Warm up Babel context
    babel.transform('const x = <div>warmup</div>;', { presets: ['react'] });
  });

  afterAll(() => {
    resetBabelContext();
  });

  describe('Transform Latency by Complexity Level', () => {
    it.each(COMPLEXITY_LEVELS)('measures %s complexity latency', (level: ComplexityLevel) => {
      const examples = getExamplesByLevel(level);
      const allTimes: number[] = [];

      // Warmup
      for (let i = 0; i < 3; i++) {
        for (const example of examples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
        }
      }

      // Measure each example multiple times
      const iterations = 10;
      for (let i = 0; i < iterations; i++) {
        for (const example of examples) {
          const start = performance.now();
          babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });
          allTimes.push(performance.now() - start);
        }
      }

      const stats = calculateLatencyStats(allTimes);
      const levelStats = getLevelStats()[level];

      console.log(`\n${level} Transform Latency:`);
      console.log(`  Samples: ${allTimes.length} (${examples.length} examples x ${iterations} iterations)`);
      console.log(`  Avg code size: ${Math.round(levelStats.avgSize)} chars`);
      console.log(`  min: ${stats.min.toFixed(3)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(3)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(3)}ms`);
      console.log(`  p99: ${stats.p99.toFixed(3)}ms`);
      console.log(`  max: ${stats.max.toFixed(3)}ms`);

      // Record metrics
      const levelKey = level.toLowerCase();
      recordMetrics(`babel_${levelKey}`, [
        { name: `babel_${levelKey}_p50`, value: stats.p50, unit: 'ms', threshold: getLatencyThreshold(level, 'p50') },
        { name: `babel_${levelKey}_p95`, value: stats.p95, unit: 'ms', threshold: getLatencyThreshold(level, 'p95') },
      ]);

      // Performance assertions based on complexity
      expect(stats.p50).toBeLessThan(getLatencyThreshold(level, 'p50'));
      expect(stats.p95).toBeLessThan(getLatencyThreshold(level, 'p95'));
    });
  });

  describe('Transform Throughput', () => {
    it('measures transforms per second for L2 (simple) components', () => {
      const examples = getExamplesByLevel('L2_SIMPLE');
      const iterations = 100;
      let completedTransforms = 0;

      // Warmup
      for (let i = 0; i < 10; i++) {
        for (const example of examples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
        }
      }

      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const example of examples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
          completedTransforms++;
        }
      }

      const totalTime = performance.now() - start;
      const throughput = (completedTransforms / totalTime) * 1000;

      console.log(`\nThroughput (L2_SIMPLE mix):`);
      console.log(`  Total transforms: ${completedTransforms}`);
      console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(2)} transforms/sec`);

      recordMetric('babel_throughput_l2', 'babel_throughput_l2', throughput, 'transforms/sec', 100, 'min');

      // Should achieve at least 100 transforms/sec for simple components
      expect(throughput).toBeGreaterThan(100);
    });

    it('measures transforms per second for mixed complexity', () => {
      const allExamples = BABEL_EXAMPLES;
      const iterations = 20;
      let completedTransforms = 0;

      // Warmup
      for (let i = 0; i < 3; i++) {
        for (const example of allExamples.slice(0, 10)) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
        }
      }

      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const example of allExamples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
          completedTransforms++;
        }
      }

      const totalTime = performance.now() - start;
      const throughput = (completedTransforms / totalTime) * 1000;

      console.log(`\nThroughput (mixed complexity):`);
      console.log(`  Total transforms: ${completedTransforms}`);
      console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(2)} transforms/sec`);

      recordMetric('babel_throughput_mixed', 'babel_throughput_mixed', throughput, 'transforms/sec', 50, 'min');

      // Should achieve at least 50 transforms/sec for mixed complexity
      expect(throughput).toBeGreaterThan(50);
    });
  });

  describe('Input Size Scaling', () => {
    it('measures latency vs input size', () => {
      const results: { size: number; avgTime: number }[] = [];

      // Generate increasingly large components
      const sizes = [100, 500, 1000, 2000, 5000, 10000];

      for (const targetSize of sizes) {
        // Generate a component of approximately the target size
        const code = generateComponentOfSize(targetSize);
        const actualSize = code.length;

        // Warmup
        for (let i = 0; i < 3; i++) {
          babel.transform(code, { presets: ['typescript', 'react'] });
        }

        // Measure
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          babel.transform(code, { presets: ['typescript', 'react'] });
          times.push(performance.now() - start);
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        results.push({ size: actualSize, avgTime });
      }

      console.log('\nInput Size Scaling:');
      for (const { size, avgTime } of results) {
        const msPerKB = (avgTime / size) * 1000;
        console.log(`  ${size} chars: ${avgTime.toFixed(2)}ms (${msPerKB.toFixed(2)}ms/KB)`);
      }

      // Calculate scaling factor
      if (results.length >= 2) {
        const first = results[0];
        const last = results[results.length - 1];
        const sizeRatio = last.size / first.size;
        const timeRatio = last.avgTime / first.avgTime;
        const scalingFactor = timeRatio / sizeRatio;
        console.log(`  Scaling factor: ${scalingFactor.toFixed(2)}x (linear = 1.0)`);

        // Scaling should be roughly linear (within 3x)
        expect(scalingFactor).toBeLessThan(3);
      }

      // Record metrics for largest size
      const largest = results[results.length - 1];
      recordMetric(
        'babel_size_scaling',
        'babel_large_input',
        largest.avgTime,
        'ms',
        100, // Large inputs should still complete under 100ms
      );
    });
  });

  describe('Cold vs Warm Transform', () => {
    it('compares first transform vs subsequent transforms', () => {
      // Reset to get cold start
      resetBabelContext();

      const testCode = `
        interface Props { name: string; items: string[]; }
        const TestComponent = ({ name, items }: Props) => (
          <div className="test">
            <h1>{name}</h1>
            <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
          </div>
        );
      `;

      // Cold transform (first transform after reset)
      const coldStart = performance.now();
      const freshBabel = createRestrictedBabel(defaultConfig);
      freshBabel.transform(testCode, { presets: ['typescript', 'react'] });
      const coldTime = performance.now() - coldStart;

      // Warm transforms
      const warmTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        freshBabel.transform(testCode, { presets: ['typescript', 'react'] });
        warmTimes.push(performance.now() - start);
      }

      const warmStats = calculateLatencyStats(warmTimes);

      console.log('\nCold vs Warm Transform:');
      console.log(`  Cold (first transform): ${coldTime.toFixed(2)}ms`);
      console.log(`  Warm p50: ${warmStats.p50.toFixed(2)}ms`);
      console.log(`  Warm p95: ${warmStats.p95.toFixed(2)}ms`);
      console.log(`  Cold/Warm ratio: ${(coldTime / warmStats.p50).toFixed(1)}x`);

      recordMetrics('babel_cold_warm', [
        { name: 'babel_cold_start', value: coldTime, unit: 'ms', threshold: 100 },
        { name: 'babel_warm_p50', value: warmStats.p50, unit: 'ms', threshold: 10 },
      ]);

      // Cold start should be under 100ms
      expect(coldTime).toBeLessThan(100);

      // Warm transforms should be significantly faster
      expect(warmStats.p50).toBeLessThan(coldTime);

      // Restore babel for other tests
      babel = createRestrictedBabel(defaultConfig);
    });
  });

  describe('Preset Combination Performance', () => {
    const testCode = `
      interface Props { value: string; }
      const Component = ({ value }: Props) => <div>{value}</div>;
    `;

    it('compares TypeScript-only vs React-only vs combined', () => {
      const configs: [string, string[]][] = [
        ['TypeScript only', ['typescript']],
        ['React only (no TS)', ['react']],
        ['TypeScript + React', ['typescript', 'react']],
      ];

      const results: { preset: string; avgTime: number }[] = [];

      for (const [presetName, presets] of configs) {
        // Use appropriate code for the preset
        const code = presets.includes('typescript') ? testCode : 'const Component = ({ value }) => <div>{value}</div>;';

        // Warmup
        for (let i = 0; i < 5; i++) {
          babel.transform(code, { presets });
        }

        // Measure
        const times: number[] = [];
        for (let i = 0; i < 50; i++) {
          const start = performance.now();
          babel.transform(code, { presets });
          times.push(performance.now() - start);
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        results.push({ preset: presetName, avgTime });
      }

      console.log('\nPreset Combination Performance:');
      for (const { preset, avgTime } of results) {
        console.log(`  ${preset}: ${avgTime.toFixed(2)}ms`);
      }

      // Combined should not be more than 2x slower than individual
      const tsOnly = results.find((r) => r.preset === 'TypeScript only')!;
      const combined = results.find((r) => r.preset === 'TypeScript + React')!;
      expect(combined.avgTime).toBeLessThan(tsOnly.avgTime * 3);
    });
  });

  describe('Concurrent Transform Performance', () => {
    it('measures performance with sequential vs parallel-like transforms', async () => {
      const examples = getExamplesByLevel('L2_SIMPLE').slice(0, 5);
      const iterations = 20;

      // Sequential execution
      const sequentialStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        for (const example of examples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
        }
      }
      const sequentialTime = performance.now() - sequentialStart;

      // Note: Babel transform is synchronous, so we can't truly parallelize
      // This test documents the baseline for comparison with future async implementations

      console.log('\nSequential Transform Performance:');
      console.log(`  ${examples.length * iterations} transforms: ${sequentialTime.toFixed(2)}ms`);
      console.log(`  Avg per transform: ${(sequentialTime / (examples.length * iterations)).toFixed(2)}ms`);

      // Should complete 100 transforms in reasonable time
      expect(sequentialTime).toBeLessThan(5000);
    });
  });

  describe('Memory Efficiency', () => {
    it('measures memory usage during repeated transforms', () => {
      const examples = BABEL_EXAMPLES.slice(0, 10);
      const iterations = 50;

      // Capture memory before
      const memBefore = process.memoryUsage();

      // Perform many transforms
      for (let i = 0; i < iterations; i++) {
        for (const example of examples) {
          babel.transform(example.code, { presets: ['typescript', 'react'] });
        }
      }

      // Capture memory after
      const memAfter = process.memoryUsage();

      const heapDelta = memAfter.heapUsed - memBefore.heapUsed;
      const totalTransforms = examples.length * iterations;

      console.log('\nMemory Usage:');
      console.log(`  Total transforms: ${totalTransforms}`);
      console.log(`  Heap before: ${formatBytes(memBefore.heapUsed)}`);
      console.log(`  Heap after: ${formatBytes(memAfter.heapUsed)}`);
      console.log(`  Heap delta: ${formatBytes(heapDelta)}`);
      console.log(`  Per transform: ${formatBytes(heapDelta / totalTransforms)}`);

      // Memory growth should be reasonable (less than 50MB for 500 transforms)
      expect(heapDelta).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('Error Case Performance', () => {
    it('measures error handling performance', () => {
      const invalidCodes = ['const x = <div', 'const x = {', 'interface X {', 'function (', '<>unclosed'];

      const times: number[] = [];

      for (let i = 0; i < 20; i++) {
        for (const code of invalidCodes) {
          const start = performance.now();
          try {
            babel.transform(code, { presets: ['typescript', 'react'] });
          } catch {
            // Expected
          }
          times.push(performance.now() - start);
        }
      }

      const stats = calculateLatencyStats(times);

      console.log('\nError Handling Performance:');
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  max: ${stats.max.toFixed(2)}ms`);

      // Error cases should still be fast (fail fast)
      expect(stats.p95).toBeLessThan(50);
    });
  });

  describe('Benchmark Summary', () => {
    it('generates comprehensive performance summary', () => {
      const summary: Record<string, { p50: number; p95: number; throughput: number }> = {};

      for (const level of COMPLEXITY_LEVELS) {
        const examples = getExamplesByLevel(level);
        const times: number[] = [];

        // Measure
        const start = performance.now();
        for (let i = 0; i < 10; i++) {
          for (const example of examples) {
            const transformStart = performance.now();
            babel.transform(example.code, { presets: ['typescript', 'react'] });
            times.push(performance.now() - transformStart);
          }
        }
        const totalTime = performance.now() - start;

        const stats = calculateLatencyStats(times);
        summary[level] = {
          p50: stats.p50,
          p95: stats.p95,
          throughput: (times.length / totalTime) * 1000,
        };
      }

      console.log('\n=== Babel Transform Performance Summary ===\n');
      console.log('| Level        | p50 (ms) | p95 (ms) | Throughput |');
      console.log('|--------------|----------|----------|------------|');
      for (const [level, data] of Object.entries(summary)) {
        console.log(
          `| ${level.padEnd(12)} | ${data.p50.toFixed(2).padStart(8)} | ${data.p95.toFixed(2).padStart(8)} | ${data.throughput.toFixed(0).padStart(7)}/s |`,
        );
      }
      console.log('');

      // All levels should meet their targets
      expect(summary['L1_MINIMAL'].p50).toBeLessThan(5);
      expect(summary['L5_COMPLEX'].p50).toBeLessThan(50);
    });
  });
});

/**
 * Get latency threshold for a complexity level
 */
function getLatencyThreshold(level: ComplexityLevel, percentile: 'p50' | 'p95'): number {
  const thresholds: Record<ComplexityLevel, { p50: number; p95: number }> = {
    L1_MINIMAL: { p50: 5, p95: 15 },
    L2_SIMPLE: { p50: 10, p95: 30 },
    L3_STYLED: { p50: 15, p95: 40 },
    L4_COMPOSITE: { p50: 25, p95: 60 },
    L5_COMPLEX: { p50: 50, p95: 100 },
  };
  return thresholds[level][percentile];
}

/**
 * Generate a component of approximately the target size
 */
function generateComponentOfSize(targetSize: number): string {
  const base = `
interface Props {
  items: Array<{ id: string; label: string; value: number }>;
  onItemClick: (id: string) => void;
}

const GeneratedComponent = ({ items, onItemClick }: Props) => (
  <div className="generated-component">
    <header className="header">
      <h1>Generated Component</h1>
    </header>
    <main className="main">
      <ul className="item-list">
        {items.map(item => (
          <li key={item.id} className="item" onClick={() => onItemClick(item.id)}>
            <span className="label">{item.label}</span>
            <span className="value">{item.value}</span>
          </li>
        ))}
      </ul>
    </main>
  </div>
);
`;

  if (base.length >= targetSize) {
    return base;
  }

  // Add more content to reach target size
  const additionalElements: string[] = [];
  let currentSize = base.length;

  while (currentSize < targetSize) {
    const element = `
      <div className="filler-${additionalElements.length}">
        <span>Filler content ${additionalElements.length}</span>
        <p>Additional text to increase component size</p>
      </div>`;
    additionalElements.push(element);
    currentSize += element.length;
  }

  // Insert additional elements before closing main
  const insertPoint = base.lastIndexOf('</main>');
  return base.slice(0, insertPoint) + additionalElements.join('\n') + base.slice(insertPoint);
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const absBytes = Math.abs(bytes);

  if (absBytes < 1024) return `${sign}${absBytes} B`;
  if (absBytes < 1024 * 1024) return `${sign}${(absBytes / 1024).toFixed(2)} KB`;
  return `${sign}${(absBytes / (1024 * 1024)).toFixed(2)} MB`;
}
