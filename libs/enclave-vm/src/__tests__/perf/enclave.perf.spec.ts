/**
 * Enclave Performance Tests
 *
 * Measures throughput, latency, and memory usage for the main Enclave execution flow.
 */

import { Enclave } from '../../enclave';
import type { ToolHandler, SecurityLevel } from '../../types';
import { benchmark } from './utils/perf-utils';
import { calculateLatencyStats, calculateReport, formatReport, formatBytes } from './utils/statistics';
import { trackMemory, formatMemorySummary } from './utils/memory-utils';
import { recordMetric, recordMetrics } from './utils/benchmark-reporter';

describe('Enclave Performance', () => {
  describe('Cold Start Latency', () => {
    const securityLevels: SecurityLevel[] = ['STRICT', 'SECURE', 'STANDARD', 'PERMISSIVE'];

    it.each(securityLevels)('measures cold start for %s security level', async (level) => {
      const times: number[] = [];

      // Cold start: new Enclave instance + first execution each iteration
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const enclave = new Enclave({ securityLevel: level });
        await enclave.run('return 42');
        times.push(performance.now() - start);
        enclave.dispose();
      }

      const stats = calculateLatencyStats(times);
      console.log(`\nCold Start - ${level}:`);
      console.log(`  min: ${stats.min.toFixed(2)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  max: ${stats.max.toFixed(2)}ms`);

      // Record metrics for JSON output
      const testName = `cold_start_${level.toLowerCase()}`;
      recordMetrics(testName, [
        { name: `${testName}_p50`, value: stats.p50, unit: 'ms', threshold: 100 },
        { name: `${testName}_p95`, value: stats.p95, unit: 'ms', threshold: 500 },
      ]);

      expect(stats.p95).toBeLessThan(500); // Should complete under 500ms
    });
  });

  describe('Warm Start Latency', () => {
    it('measures warm execution p50/p95/p99 latency', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });

      // Warmup
      for (let i = 0; i < 10; i++) {
        await enclave.run('return 42');
      }

      // Measure
      const samples = await benchmark('warm-execution', () => enclave.run('return 42'), {
        warmupIterations: 0,
        measurementIterations: 100,
      });

      enclave.dispose();

      const report = calculateReport('Warm Execution', samples);
      console.log('\n' + formatReport(report));

      // Record metrics for JSON output
      recordMetrics('warm_execution', [
        { name: 'warm_execution_p50', value: report.latency.p50, unit: 'ms', threshold: 10 },
        { name: 'warm_execution_p95', value: report.latency.p95, unit: 'ms', threshold: 50 },
        { name: 'warm_execution_p99', value: report.latency.p99, unit: 'ms', threshold: 100 },
        {
          name: 'warm_execution_throughput',
          value: report.throughput.executionsPerSecond,
          unit: 'exec/sec',
          threshold: 100,
          thresholdType: 'min',
        },
      ]);

      expect(report.throughput.successRate).toBe(1);
      expect(report.latency.p95).toBeLessThan(50); // Should complete under 50ms
    });

    it('compares latency across security levels', async () => {
      const levels: SecurityLevel[] = ['STRICT', 'SECURE', 'STANDARD', 'PERMISSIVE'];
      const results: Record<string, { p50: number; p95: number }> = {};

      for (const level of levels) {
        const enclave = new Enclave({ securityLevel: level });

        // Warmup
        for (let i = 0; i < 5; i++) {
          await enclave.run('return 42');
        }

        // Measure
        const times: number[] = [];
        for (let i = 0; i < 50; i++) {
          const start = performance.now();
          await enclave.run('return 42');
          times.push(performance.now() - start);
        }

        enclave.dispose();

        const stats = calculateLatencyStats(times);
        results[level] = { p50: stats.p50, p95: stats.p95 };
      }

      console.log('\nSecurity Level Comparison (warm):');
      for (const [level, { p50, p95 }] of Object.entries(results)) {
        console.log(`  ${level}: p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms`);
      }

      // PERMISSIVE should generally be faster than STRICT
      expect(results['PERMISSIVE'].p50).toBeLessThanOrEqual(results['STRICT'].p50 * 1.5);
    });
  });

  describe('Throughput', () => {
    it('measures executions per second for simple code', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });

      // Warmup
      for (let i = 0; i < 10; i++) {
        await enclave.run('return 42');
      }

      // Measure throughput
      const start = performance.now();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        await enclave.run('return 42');
      }

      const totalTime = performance.now() - start;
      const throughput = (iterations / totalTime) * 1000;

      enclave.dispose();

      console.log(`\nThroughput (simple code): ${throughput.toFixed(2)} exec/sec`);
      console.log(`  Total time for ${iterations} executions: ${totalTime.toFixed(2)}ms`);

      // Record metrics for JSON output (minimum threshold: 100 exec/sec)
      recordMetric('throughput_simple', 'throughput_simple', throughput, 'exec/sec', 100, 'min');

      expect(throughput).toBeGreaterThan(100); // At least 100 exec/sec
    });

    it('measures executions per second with tool calls', async () => {
      const toolHandler: ToolHandler = async (toolName, args) => {
        return { result: args };
      };

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler,
      });

      const code = `
        const r1 = await callTool('test', { i: 1 });
        const r2 = await callTool('test', { i: 2 });
        return r1.result.i + r2.result.i;
      `;

      // Warmup
      for (let i = 0; i < 5; i++) {
        await enclave.run(code);
      }

      // Measure
      const start = performance.now();
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        await enclave.run(code);
      }

      const totalTime = performance.now() - start;
      const throughput = (iterations / totalTime) * 1000;

      enclave.dispose();

      console.log(`\nThroughput (with tool calls): ${throughput.toFixed(2)} exec/sec`);

      // Record metrics for JSON output (minimum threshold: 50 exec/sec)
      recordMetric('throughput_with_tools', 'throughput_with_tools', throughput, 'exec/sec', 50, 'min');

      expect(throughput).toBeGreaterThan(50); // At least 50 exec/sec with tool calls
    });

    it('measures executions per second with loops', async () => {
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        maxIterations: 10000,
      });

      const code = `
        let sum = 0;
        for (let i = 0; i < 100; i++) {
          sum += i;
        }
        return sum;
      `;

      // Warmup
      for (let i = 0; i < 5; i++) {
        await enclave.run(code);
      }

      // Measure
      const start = performance.now();
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        await enclave.run(code);
      }

      const totalTime = performance.now() - start;
      const throughput = (iterations / totalTime) * 1000;

      enclave.dispose();

      console.log(`\nThroughput (with loops): ${throughput.toFixed(2)} exec/sec`);

      expect(throughput).toBeGreaterThan(5);
    });
  });

  describe('Tool Call Overhead', () => {
    it('measures overhead per tool call', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler,
        maxToolCalls: 100,
      });

      const results: { toolCalls: number; avgTime: number }[] = [];

      for (const toolCallCount of [0, 1, 5, 10, 20]) {
        const toolCalls = Array(toolCallCount)
          .fill(null)
          .map((_, i) => `await callTool('test', { i: ${i} });`)
          .join('\n');

        const code = `
          ${toolCalls}
          return ${toolCallCount};
        `;

        // Warmup
        for (let i = 0; i < 3; i++) {
          await enclave.run(code);
        }

        // Measure
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          await enclave.run(code);
          times.push(performance.now() - start);
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        results.push({ toolCalls: toolCallCount, avgTime });
      }

      enclave.dispose();

      console.log('\nTool Call Overhead:');
      for (const { toolCalls, avgTime } of results) {
        console.log(`  ${toolCalls} calls: ${avgTime.toFixed(2)}ms avg`);
      }

      // Calculate overhead per tool call
      if (results.length >= 2) {
        const baseline = results[0].avgTime;
        const withCalls = results[results.length - 1];
        const overheadPerCall = (withCalls.avgTime - baseline) / withCalls.toolCalls;
        console.log(`  Overhead per call: ~${overheadPerCall.toFixed(2)}ms`);
      }

      expect(results[0].avgTime).toBeLessThan(results[results.length - 1].avgTime);
    });
  });

  describe('Code Complexity Scaling', () => {
    it('measures latency vs code size', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });

      const results: { size: number; avgTime: number }[] = [];

      for (const varCount of [1, 10, 50, 100]) {
        const vars = Array(varCount)
          .fill(null)
          .map((_, i) => `const v${i} = ${i};`)
          .join('\n');
        const sum = Array(varCount)
          .fill(null)
          .map((_, i) => `v${i}`)
          .join(' + ');

        const code = `
          ${vars}
          return ${sum};
        `;

        // Warmup
        for (let i = 0; i < 3; i++) {
          await enclave.run(code);
        }

        // Measure
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          await enclave.run(code);
          times.push(performance.now() - start);
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        results.push({ size: code.length, avgTime });
      }

      enclave.dispose();

      console.log('\nCode Size Scaling:');
      for (const { size, avgTime } of results) {
        console.log(`  ${size} chars: ${avgTime.toFixed(2)}ms avg`);
      }

      // Execution time should scale reasonably with code size
      expect(results[results.length - 1].avgTime).toBeLessThan(200);
    });
  });

  describe('Memory Usage', () => {
    it('measures Enclave instance memory footprint', async () => {
      const memResult = await trackMemory(async () => {
        const enclave = new Enclave({ securityLevel: 'STANDARD' });
        await enclave.run('return 42');
        return enclave;
      });

      console.log('\nEnclave Memory Footprint:');
      console.log(formatMemorySummary(memResult));

      // Cleanup
      memResult.result.dispose();

      // Instance should use less than 10MB
      expect(memResult.peakHeapUsed - memResult.baseline.heapUsed).toBeLessThan(10 * 1024 * 1024);
    });

    it('measures memory with repeated executions', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });

      const memResult = await trackMemory(async () => {
        for (let i = 0; i < 100; i++) {
          await enclave.run(`return ${i}`);
        }
        return null;
      });

      console.log('\n100 Executions Memory:');
      console.log(formatMemorySummary(memResult));

      enclave.dispose();

      // Memory should not grow unboundedly
      expect(memResult.heapDelta).toBeLessThan(100 * 1024 * 1024); // Less than 100MB growth
    });

    it('verifies dispose() releases memory', async () => {
      const baseline = process.memoryUsage().heapUsed;

      // Create and dispose multiple enclaves
      for (let i = 0; i < 10; i++) {
        const enclave = new Enclave({ securityLevel: 'STANDARD' });
        await enclave.run('return 42');
        enclave.dispose();
      }

      // Force GC if available
      if (global.gc) {
        global.gc();
      }

      const after = process.memoryUsage().heapUsed;
      const delta = after - baseline;

      console.log(`\nMemory after 10 create/dispose cycles: ${formatBytes(delta)}`);

      // Should not leak significant memory
      expect(delta).toBeLessThan(20 * 1024 * 1024); // Less than 20MB
    });
  });
});
