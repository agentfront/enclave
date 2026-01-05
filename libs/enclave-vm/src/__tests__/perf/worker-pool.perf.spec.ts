/**
 * Worker Pool Performance Tests
 *
 * Measures worker thread pool efficiency, scalability, and concurrent load handling.
 */

import { Enclave } from '../../enclave';
import type { ToolHandler } from '../../types';
import { benchmark } from './utils/perf-utils';
import { calculateLatencyStats, calculateReport, formatReport, formatBytes, mean } from './utils/statistics';
import { trackMemory, formatMemorySummary } from './utils/memory-utils';
import { recordMetric, recordMetrics } from './utils/benchmark-reporter';

// Longer timeout for worker tests due to spawn overhead
jest.setTimeout(60000);

/**
 * Helper to create Enclave with WorkerPoolAdapter
 */
function createWorkerEnclave(
  options: {
    minWorkers?: number;
    maxWorkers?: number;
    toolHandler?: ToolHandler;
    timeout?: number;
    maxToolCalls?: number;
    maxQueueSize?: number;
    warmOnInit?: boolean;
  } = {},
) {
  return new Enclave({
    adapter: 'worker_threads',
    securityLevel: 'STANDARD',
    timeout: options.timeout ?? 5000,
    maxToolCalls: options.maxToolCalls ?? 50,
    toolHandler: options.toolHandler,
    // Disable VM-level memory tracking (set to 0)
    memoryLimit: 0,
    workerPoolConfig: {
      minWorkers: options.minWorkers ?? 2,
      maxWorkers: options.maxWorkers ?? 4,
      warmOnInit: options.warmOnInit ?? true,
      maxQueueSize: options.maxQueueSize ?? 100,
      // Disable per-worker memory limit (blocked by Node.js 24+ security model)
      memoryLimitPerWorker: 0,
    },
    // Disable double VM to test worker adapter directly
    doubleVm: { enabled: false },
  });
}

describe('Worker Pool Performance', () => {
  describe('Worker Startup', () => {
    it('measures cold pool startup time', async () => {
      const startupTimes: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = performance.now();

        const enclave = createWorkerEnclave({
          minWorkers: 2,
          maxWorkers: 4,
          warmOnInit: true,
        });

        // First execution ensures workers are ready
        await enclave.run('return 1');
        startupTimes.push(performance.now() - start);

        enclave.dispose();
      }

      const stats = calculateLatencyStats(startupTimes);

      console.log('\nWorker Pool Cold Startup:');
      console.log(`  min: ${stats.min.toFixed(2)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  max: ${stats.max.toFixed(2)}ms`);

      // Pool startup should complete within reasonable time
      expect(stats.p95).toBeLessThan(5000); // Under 5 seconds
    });

    it('measures warm pool first execution time', async () => {
      const enclave = createWorkerEnclave({
        minWorkers: 2,
        maxWorkers: 4,
        warmOnInit: true,
      });

      // Pool is warmed, measure first actual execution
      const firstExecTimes: number[] = [];

      for (let i = 0; i < 20; i++) {
        // Dispose and recreate to test first execution each time
        enclave.dispose();

        const newEnclave = createWorkerEnclave({
          minWorkers: 2,
          maxWorkers: 4,
          warmOnInit: true,
        });

        const start = performance.now();
        await newEnclave.run('return 42');
        firstExecTimes.push(performance.now() - start);

        newEnclave.dispose();
      }

      const stats = calculateLatencyStats(firstExecTimes);

      console.log('\nFirst Execution (warm pool):');
      console.log(`  min: ${stats.min.toFixed(2)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);

      expect(stats.p95).toBeLessThan(3000); // Under 3 seconds for first execution
    });
  });

  describe('Execution Latency', () => {
    it('measures single execution latency', async () => {
      const enclave = createWorkerEnclave();

      // Warmup
      for (let i = 0; i < 5; i++) {
        await enclave.run('return 42');
      }

      const samples = await benchmark('worker-execution', () => enclave.run('return 42'), {
        warmupIterations: 0,
        measurementIterations: 50,
      });

      enclave.dispose();

      const report = calculateReport('Worker Execution', samples);
      console.log('\n' + formatReport(report));

      expect(report.throughput.successRate).toBe(1);
      expect(report.latency.p95).toBeLessThan(200); // Under 200ms p95
    });

    it('measures latency with tool calls', async () => {
      const toolHandler: ToolHandler = async (toolName, args) => {
        return { tool: toolName, received: args };
      };

      const enclave = createWorkerEnclave({ toolHandler });

      const code = `
        const r1 = await callTool('test', { i: 1 });
        const r2 = await callTool('test', { i: 2 });
        return r1.received.i + r2.received.i;
      `;

      // Warmup
      for (let i = 0; i < 5; i++) {
        await enclave.run(code);
      }

      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        await enclave.run(code);
        times.push(performance.now() - start);
      }

      enclave.dispose();

      const stats = calculateLatencyStats(times);

      console.log('\nWorker Execution with Tool Calls:');
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  p99: ${stats.p99.toFixed(2)}ms`);

      expect(stats.p95).toBeLessThan(500); // Under 500ms with tool calls
    });

    it('compares worker pool latency to VM adapter', async () => {
      const code = 'return 42';

      // Worker pool adapter
      const workerEnclave = createWorkerEnclave();

      // VM adapter (single VM, no workers)
      const vmEnclave = new Enclave({
        adapter: 'vm',
        securityLevel: 'STANDARD',
        doubleVm: { enabled: false },
      });

      // Warmup both
      for (let i = 0; i < 5; i++) {
        await workerEnclave.run(code);
        await vmEnclave.run(code);
      }

      // Measure worker
      const workerTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await workerEnclave.run(code);
        workerTimes.push(performance.now() - start);
      }

      // Measure VM
      const vmTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await vmEnclave.run(code);
        vmTimes.push(performance.now() - start);
      }

      workerEnclave.dispose();
      vmEnclave.dispose();

      const workerStats = calculateLatencyStats(workerTimes);
      const vmStats = calculateLatencyStats(vmTimes);

      console.log('\nWorker Pool vs VM Adapter:');
      console.log(`  VM Adapter - p50: ${vmStats.p50.toFixed(2)}ms, p95: ${vmStats.p95.toFixed(2)}ms`);
      console.log(`  Worker Pool - p50: ${workerStats.p50.toFixed(2)}ms, p95: ${workerStats.p95.toFixed(2)}ms`);
      console.log(`  Worker overhead: ${((workerStats.mean / vmStats.mean - 1) * 100).toFixed(1)}%`);

      // Workers have overhead but should still be usable
      expect(workerStats.p95).toBeLessThan(300);
    });
  });

  describe('Concurrent Load', () => {
    it('measures throughput with 10 concurrent executions', async () => {
      const enclave = createWorkerEnclave({
        minWorkers: 4,
        maxWorkers: 8,
      });

      // Warmup
      await enclave.run('return 1');

      const concurrency = 10;
      const totalRequests = 50;

      const samples: number[] = [];
      const inFlight = new Set<Promise<void>>();

      const start = performance.now();

      for (let i = 0; i < totalRequests; i++) {
        const promise = (async () => {
          const reqStart = performance.now();
          await enclave.run('return 42');
          samples.push(performance.now() - reqStart);
        })();

        inFlight.add(promise);
        promise.finally(() => inFlight.delete(promise));

        // Maintain concurrency level
        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
      }

      await Promise.all(inFlight);
      const totalTime = performance.now() - start;

      enclave.dispose();

      const stats = calculateLatencyStats(samples);
      const throughput = (totalRequests / totalTime) * 1000;

      console.log(`\nConcurrent Load (${concurrency} concurrent):`);
      console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(2)} exec/sec`);
      console.log(`  Latency p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  Latency p95: ${stats.p95.toFixed(2)}ms`);

      // Record metrics for JSON output
      recordMetrics('worker_pool_concurrent_10', [
        { name: 'worker_pool_throughput_10_concurrent', value: throughput, unit: 'exec/sec' },
        { name: 'worker_pool_latency_p50_10_concurrent', value: stats.p50, unit: 'ms' },
        { name: 'worker_pool_latency_p95_10_concurrent', value: stats.p95, unit: 'ms' },
      ]);

      expect(throughput).toBeGreaterThan(5); // At least 5 exec/sec
    });

    it('measures latency distribution under sustained load', async () => {
      const enclave = createWorkerEnclave({
        minWorkers: 4,
        maxWorkers: 8,
      });

      // Warmup
      await enclave.run('return 1');

      const concurrency = 20;
      const totalRequests = 100;

      const samples: number[] = [];
      const inFlight = new Set<Promise<void>>();

      for (let i = 0; i < totalRequests; i++) {
        const promise = (async () => {
          const start = performance.now();
          await enclave.run('return 42');
          samples.push(performance.now() - start);
        })();

        inFlight.add(promise);
        promise.finally(() => inFlight.delete(promise));

        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
      }

      await Promise.all(inFlight);
      enclave.dispose();

      const stats = calculateLatencyStats(samples);

      console.log(`\nSustained Load (${concurrency} concurrent, ${totalRequests} total):`);
      console.log(`  min: ${stats.min.toFixed(2)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p75: ${stats.p75.toFixed(2)}ms`);
      console.log(`  p90: ${stats.p90.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  p99: ${stats.p99.toFixed(2)}ms`);
      console.log(`  max: ${stats.max.toFixed(2)}ms`);

      // Should handle load without extreme latency spikes
      expect(stats.p99).toBeLessThan(stats.p50 * 30); // p99 should be less than 30x p50
    });

    it('measures queue wait time when pool is exhausted', async () => {
      // Small pool to force queueing
      const enclave = createWorkerEnclave({
        minWorkers: 1,
        maxWorkers: 2,
        maxQueueSize: 50,
      });

      // Warmup
      await enclave.run('return 1');

      const concurrency = 10; // More than max workers
      const totalRequests = 30;

      const samples: number[] = [];
      const inFlight = new Set<Promise<void>>();

      for (let i = 0; i < totalRequests; i++) {
        const promise = (async () => {
          const start = performance.now();
          await enclave.run('return 42');
          samples.push(performance.now() - start);
        })();

        inFlight.add(promise);
        promise.finally(() => inFlight.delete(promise));

        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
      }

      await Promise.all(inFlight);
      enclave.dispose();

      const stats = calculateLatencyStats(samples);

      console.log('\nQueue Wait Time (exhausted pool):');
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  max: ${stats.max.toFixed(2)}ms`);

      // Some requests will wait in queue, so max will be higher
      expect(stats.max).toBeGreaterThan(stats.min);
    });
  });

  describe('Throughput Scaling', () => {
    it('measures throughput with different pool sizes', async () => {
      const poolSizes = [1, 2, 4];
      const results: { poolSize: number; throughput: number }[] = [];

      for (const poolSize of poolSizes) {
        const enclave = createWorkerEnclave({
          minWorkers: poolSize,
          maxWorkers: poolSize,
        });

        // Warmup
        await enclave.run('return 1');

        const totalRequests = 30;
        const concurrency = poolSize * 2;

        const inFlight = new Set<Promise<void>>();
        const start = performance.now();

        for (let i = 0; i < totalRequests; i++) {
          const promise = (async () => {
            await enclave.run('return 42');
          })();

          inFlight.add(promise);
          promise.finally(() => inFlight.delete(promise));

          if (inFlight.size >= concurrency) {
            await Promise.race(inFlight);
          }
        }

        await Promise.all(inFlight);
        const totalTime = performance.now() - start;

        enclave.dispose();

        results.push({
          poolSize,
          throughput: (totalRequests / totalTime) * 1000,
        });
      }

      console.log('\nThroughput vs Pool Size:');
      for (const { poolSize, throughput } of results) {
        console.log(`  ${poolSize} workers: ${throughput.toFixed(2)} exec/sec`);
      }

      // More workers should generally improve throughput
      if (results.length >= 2) {
        const smallPool = results[0].throughput;
        const largePool = results[results.length - 1].throughput;
        console.log(`  Scaling factor: ${(largePool / smallPool).toFixed(2)}x`);
      }
    });
  });

  describe('Memory', () => {
    it('measures worker pool memory footprint', async () => {
      const memResult = await trackMemory(async () => {
        const enclave = createWorkerEnclave({
          minWorkers: 2,
          maxWorkers: 4,
        });

        // Run a few executions
        for (let i = 0; i < 5; i++) {
          await enclave.run('return 42');
        }

        return enclave;
      });

      console.log('\nWorker Pool Memory Footprint:');
      console.log(formatMemorySummary(memResult));

      // Cleanup
      memResult.result.dispose();

      // Worker pool uses more memory than VM but should be bounded
      expect(memResult.peakHeapUsed - memResult.baseline.heapUsed).toBeLessThan(100 * 1024 * 1024); // Under 100MB
    });

    it('measures memory stability under load', async () => {
      const enclave = createWorkerEnclave({
        minWorkers: 2,
        maxWorkers: 4,
      });

      // Warmup
      await enclave.run('return 1');

      const memResult = await trackMemory(
        async () => {
          // Run many executions
          for (let i = 0; i < 50; i++) {
            await enclave.run(`return ${i}`);
          }
          return null;
        },
        { sampleIntervalMs: 50 },
      );

      console.log('\nMemory Under Load (50 executions):');
      console.log(formatMemorySummary(memResult));

      enclave.dispose();

      // Memory should not grow unboundedly
      expect(memResult.heapDelta).toBeLessThan(100 * 1024 * 1024); // Less than 100MB growth
    });

    it('verifies dispose releases worker memory', async () => {
      const baseline = process.memoryUsage().heapUsed;

      // Create and dispose multiple worker pools
      for (let i = 0; i < 5; i++) {
        const enclave = createWorkerEnclave({
          minWorkers: 2,
          maxWorkers: 4,
        });
        await enclave.run('return 42');
        enclave.dispose();

        // Give time for cleanup
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Force GC if available
      if (global.gc) {
        global.gc();
      }

      const after = process.memoryUsage().heapUsed;
      const delta = after - baseline;

      console.log(`\nMemory after 5 create/dispose cycles: ${formatBytes(delta)}`);

      // Should not leak significant memory
      expect(delta).toBeLessThan(50 * 1024 * 1024); // Less than 50MB
    });
  });

  describe('Long Running Stability', () => {
    it('measures stability over 100 executions', async () => {
      const enclave = createWorkerEnclave({
        minWorkers: 2,
        maxWorkers: 4,
      });

      // Warmup
      await enclave.run('return 1');

      const batches: { batch: number; avgTime: number }[] = [];
      const batchSize = 20;
      const numBatches = 5;

      for (let batch = 0; batch < numBatches; batch++) {
        const times: number[] = [];

        for (let i = 0; i < batchSize; i++) {
          const start = performance.now();
          await enclave.run('return 42');
          times.push(performance.now() - start);
        }

        batches.push({
          batch,
          avgTime: times.reduce((a, b) => a + b, 0) / times.length,
        });
      }

      enclave.dispose();

      console.log('\nStability Over Time:');
      for (const { batch, avgTime } of batches) {
        console.log(`  Batch ${batch + 1}: ${avgTime.toFixed(2)}ms avg`);
      }

      // Latency should not degrade significantly over time
      const firstBatch = batches[0].avgTime;
      const lastBatch = batches[batches.length - 1].avgTime;
      const degradation = ((lastBatch - firstBatch) / firstBatch) * 100;

      console.log(`  Degradation: ${degradation.toFixed(1)}%`);

      // Less than 50% degradation
      expect(lastBatch).toBeLessThan(firstBatch * 1.5);
    });
  });
});
