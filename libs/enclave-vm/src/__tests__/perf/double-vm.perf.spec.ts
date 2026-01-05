/**
 * Double-VM Performance Tests
 *
 * Measures overhead of the nested VM security layer compared to single VM execution.
 */

import { Enclave } from '../../enclave';
import type { ToolHandler, SecurityLevel } from '../../types';
import { benchmark } from './utils/perf-utils';
import { calculateLatencyStats, calculateReport, formatReport, formatBytes } from './utils/statistics';
import { trackMemory, formatMemorySummary } from './utils/memory-utils';
import { recordMetric, recordMetrics } from './utils/benchmark-reporter';

describe('Double-VM Performance', () => {
  describe('Double-VM vs Single-VM Overhead', () => {
    it('compares execution time: double VM enabled vs disabled', async () => {
      const code = `
        const arr = [1, 2, 3, 4, 5];
        const sum = arr.reduce((a, b) => a + b, 0);
        return sum;
      `;

      // Test with double VM enabled (default)
      const enclaveDouble = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: true },
      });

      // Warmup double VM
      for (let i = 0; i < 5; i++) {
        await enclaveDouble.run(code);
      }

      const doubleVmTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await enclaveDouble.run(code);
        doubleVmTimes.push(performance.now() - start);
      }
      enclaveDouble.dispose();

      // Test with double VM disabled
      const enclaveSingle = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: false },
      });

      // Warmup single VM
      for (let i = 0; i < 5; i++) {
        await enclaveSingle.run(code);
      }

      const singleVmTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await enclaveSingle.run(code);
        singleVmTimes.push(performance.now() - start);
      }
      enclaveSingle.dispose();

      const doubleStats = calculateLatencyStats(doubleVmTimes);
      const singleStats = calculateLatencyStats(singleVmTimes);

      const overheadPercent =
        singleStats.mean > 0 ? ((doubleStats.mean - singleStats.mean) / singleStats.mean) * 100 : 0;

      console.log('\nDouble-VM vs Single-VM Comparison:');
      console.log(`  Single VM - p50: ${singleStats.p50.toFixed(2)}ms, p95: ${singleStats.p95.toFixed(2)}ms`);
      console.log(`  Double VM - p50: ${doubleStats.p50.toFixed(2)}ms, p95: ${doubleStats.p95.toFixed(2)}ms`);
      console.log(`  Overhead: ${overheadPercent.toFixed(1)}%`);

      // Record metrics for JSON output
      recordMetrics('double_vm_overhead', [
        { name: 'single_vm_p50', value: singleStats.p50, unit: 'ms' },
        { name: 'single_vm_p95', value: singleStats.p95, unit: 'ms' },
        { name: 'double_vm_p50', value: doubleStats.p50, unit: 'ms' },
        { name: 'double_vm_p95', value: doubleStats.p95, unit: 'ms' },
        { name: 'double_vm_overhead_percent', value: overheadPercent, unit: '%' },
      ]);

      // Double VM should be slower (that's expected for the security benefit)
      expect(doubleStats.mean).toBeGreaterThanOrEqual(singleStats.mean * 0.5); // At least 50% of single
      // But not excessively slower
      expect(doubleStats.p95).toBeLessThan(singleStats.p95 * 10); // Less than 10x slower
    });

    it('measures overhead across security levels', async () => {
      const levels: SecurityLevel[] = ['STRICT', 'SECURE', 'STANDARD', 'PERMISSIVE'];
      const code = 'return 42';

      const results: Record<string, { double: number; single: number; overhead: number }> = {};

      for (const level of levels) {
        // Double VM
        const enclaveDouble = new Enclave({ securityLevel: level, doubleVm: { enabled: true } });
        for (let i = 0; i < 3; i++) await enclaveDouble.run(code);

        const doubleTimes: number[] = [];
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          await enclaveDouble.run(code);
          doubleTimes.push(performance.now() - start);
        }
        enclaveDouble.dispose();

        // Single VM
        const enclaveSingle = new Enclave({ securityLevel: level, doubleVm: { enabled: false } });
        for (let i = 0; i < 3; i++) await enclaveSingle.run(code);

        const singleTimes: number[] = [];
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          await enclaveSingle.run(code);
          singleTimes.push(performance.now() - start);
        }
        enclaveSingle.dispose();

        const doubleAvg = doubleTimes.reduce((a, b) => a + b, 0) / doubleTimes.length;
        const singleAvg = singleTimes.reduce((a, b) => a + b, 0) / singleTimes.length;

        results[level] = {
          double: doubleAvg,
          single: singleAvg,
          overhead: singleAvg > 0 ? ((doubleAvg - singleAvg) / singleAvg) * 100 : 0,
        };
      }

      console.log('\nDouble-VM Overhead by Security Level:');
      for (const [level, { double, single, overhead }] of Object.entries(results)) {
        console.log(
          `  ${level}: single=${single.toFixed(2)}ms, double=${double.toFixed(2)}ms, overhead=${overhead.toFixed(1)}%`,
        );
      }

      // All should complete reasonably
      for (const [, { double }] of Object.entries(results)) {
        expect(double).toBeLessThan(100); // Under 100ms
      }
    });
  });

  describe('Context Creation', () => {
    it('measures parent context creation overhead', async () => {
      // Cold start measures include context creation
      const coldTimes: number[] = [];

      for (let i = 0; i < 20; i++) {
        const enclave = new Enclave({
          securityLevel: 'STANDARD',
          doubleVm: { enabled: true },
        });

        const start = performance.now();
        await enclave.run('return 1');
        coldTimes.push(performance.now() - start);

        enclave.dispose();
      }

      const coldStats = calculateLatencyStats(coldTimes);

      // Now measure warm (context reused)
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: true },
      });

      // Warmup
      for (let i = 0; i < 5; i++) {
        await enclave.run('return 1');
      }

      const warmTimes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await enclave.run('return 1');
        warmTimes.push(performance.now() - start);
      }
      enclave.dispose();

      const warmStats = calculateLatencyStats(warmTimes);

      const contextOverhead = coldStats.mean - warmStats.mean;

      console.log('\nContext Creation Overhead:');
      console.log(`  Cold start (incl context creation): ${coldStats.mean.toFixed(2)}ms avg`);
      console.log(`  Warm execution (context reused): ${warmStats.mean.toFixed(2)}ms avg`);
      console.log(`  Context creation overhead: ~${contextOverhead.toFixed(2)}ms`);

      // Cold should generally be slower, but allow small variance
      expect(coldStats.mean).toBeGreaterThanOrEqual(warmStats.mean * 0.8);
    });
  });

  describe('Tool Call Proxy', () => {
    it('measures tool call proxy overhead in double VM', async () => {
      const toolHandler: ToolHandler = async (toolName, args) => {
        return { tool: toolName, args };
      };

      // Double VM with tool calls
      const enclaveDouble = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: true },
        toolHandler,
        maxToolCalls: 50,
      });

      // Single VM with tool calls
      const enclaveSingle = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: false },
        toolHandler,
        maxToolCalls: 50,
      });

      const code = `
        const r1 = await callTool('test', { x: 1 });
        const r2 = await callTool('test', { x: 2 });
        const r3 = await callTool('test', { x: 3 });
        return r1.args.x + r2.args.x + r3.args.x;
      `;

      // Warmup
      for (let i = 0; i < 3; i++) {
        await enclaveDouble.run(code);
        await enclaveSingle.run(code);
      }

      // Measure double VM
      const doubleTimes: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        await enclaveDouble.run(code);
        doubleTimes.push(performance.now() - start);
      }

      // Measure single VM
      const singleTimes: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        await enclaveSingle.run(code);
        singleTimes.push(performance.now() - start);
      }

      enclaveDouble.dispose();
      enclaveSingle.dispose();

      const doubleStats = calculateLatencyStats(doubleTimes);
      const singleStats = calculateLatencyStats(singleTimes);

      const proxyOverhead = doubleStats.mean - singleStats.mean;
      const overheadPerCall = proxyOverhead / 3; // 3 tool calls

      console.log('\nTool Call Proxy Overhead:');
      console.log(`  Single VM (3 calls): ${singleStats.mean.toFixed(2)}ms avg`);
      console.log(`  Double VM (3 calls): ${doubleStats.mean.toFixed(2)}ms avg`);
      console.log(`  Total proxy overhead: ${proxyOverhead.toFixed(2)}ms`);
      console.log(`  Overhead per call: ~${overheadPerCall.toFixed(2)}ms`);

      expect(doubleStats.mean).toBeLessThan(200); // Should complete in under 200ms
    });

    it('scales tool call overhead linearly', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: true },
        toolHandler,
        maxToolCalls: 100,
      });

      const results: { calls: number; avgTime: number }[] = [];

      for (const callCount of [1, 5, 10, 20]) {
        const toolCalls = Array(callCount)
          .fill(null)
          .map((_, i) => `await callTool('t', { i: ${i} });`)
          .join('\n');

        const code = `${toolCalls}\nreturn ${callCount};`;

        // Warmup
        for (let i = 0; i < 3; i++) {
          await enclave.run(code);
        }

        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          await enclave.run(code);
          times.push(performance.now() - start);
        }

        results.push({
          calls: callCount,
          avgTime: times.reduce((a, b) => a + b, 0) / times.length,
        });
      }

      enclave.dispose();

      console.log('\nTool Call Scaling (Double VM):');
      for (const { calls, avgTime } of results) {
        const perCall = avgTime / calls;
        console.log(`  ${calls} calls: ${avgTime.toFixed(2)}ms avg (${perCall.toFixed(2)}ms/call)`);
      }

      // Should scale roughly linearly
      const oneCall = results.find((r) => r.calls === 1)!;
      const twentyCalls = results.find((r) => r.calls === 20)!;
      const ratio = twentyCalls.avgTime / oneCall.avgTime;

      // 20 calls should be less than 40x the time of 1 call (accounting for overhead)
      expect(ratio).toBeLessThan(40);
    });
  });

  describe('Validation Overhead', () => {
    it('measures suspicious pattern detection impact', async () => {
      const toolHandler: ToolHandler = async (toolName) => {
        // Simulate operations that might trigger pattern detection
        return { operation: toolName };
      };

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        doubleVm: { enabled: true },
        toolHandler,
        maxToolCalls: 50,
      });

      // Code with many sequential tool calls (could trigger rapid enumeration detection)
      const manyCallsCode = `
        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push(await callTool('list_items', { page: i }));
        }
        return results.length;
      `;

      // Simple code without pattern triggers
      const simpleCode = `
        const x = 1 + 2;
        return x;
      `;

      // Warmup
      for (let i = 0; i < 3; i++) {
        await enclave.run(manyCallsCode);
        await enclave.run(simpleCode);
      }

      // Measure complex code
      const complexTimes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await enclave.run(manyCallsCode);
        complexTimes.push(performance.now() - start);
      }

      // Measure simple code
      const simpleTimes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await enclave.run(simpleCode);
        simpleTimes.push(performance.now() - start);
      }

      enclave.dispose();

      const complexStats = calculateLatencyStats(complexTimes);
      const simpleStats = calculateLatencyStats(simpleTimes);

      console.log('\nValidation Overhead:');
      console.log(`  Simple code: ${simpleStats.mean.toFixed(2)}ms avg`);
      console.log(`  Code with pattern triggers: ${complexStats.mean.toFixed(2)}ms avg`);

      expect(complexStats.mean).toBeLessThan(500); // Should still be fast
    });
  });

  describe('Memory', () => {
    it('measures double VM memory overhead', async () => {
      // Single VM memory
      const singleResult = await trackMemory(async () => {
        const enclave = new Enclave({
          securityLevel: 'STANDARD',
          doubleVm: { enabled: false },
        });
        await enclave.run('return 42');
        return enclave;
      });

      singleResult.result.dispose();

      // Double VM memory
      const doubleResult = await trackMemory(async () => {
        const enclave = new Enclave({
          securityLevel: 'STANDARD',
          doubleVm: { enabled: true },
        });
        await enclave.run('return 42');
        return enclave;
      });

      doubleResult.result.dispose();

      const singleHeap = singleResult.peakHeapUsed - singleResult.baseline.heapUsed;
      const doubleHeap = doubleResult.peakHeapUsed - doubleResult.baseline.heapUsed;

      console.log('\nDouble VM Memory Overhead:');
      console.log(`  Single VM: ${formatBytes(singleHeap)}`);
      console.log(`  Double VM: ${formatBytes(doubleHeap)}`);
      console.log(`  Overhead: ${formatBytes(doubleHeap - singleHeap)}`);

      // Double VM should use more memory, but not excessively
      expect(doubleHeap).toBeLessThan(20 * 1024 * 1024); // Under 20MB
    });
  });
});
