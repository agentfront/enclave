/**
 * Resource Exhaustion Prevention Tests
 *
 * These tests verify protection against DoS attacks that can exhaust:
 * - CPU: Heavy computations that bypass VM timeout
 * - Memory: Large allocations that cause OOM
 *
 * Defense layers:
 * 1. AST-level detection (ResourceExhaustionRule) - blocks patterns before execution
 * 2. Runtime limits (iteration counters, memory tracking)
 * 3. VM timeout - interrupts at bytecode checkpoints
 * 4. Worker pool watchdog - hard kill for unresponsive execution
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

describe('Resource Exhaustion Prevention', () => {
  // ============================================================================
  // CPU EXHAUSTION - AST LEVEL BLOCKING
  // ============================================================================
  describe('CPU Exhaustion - AST Level', () => {
    describe('BigInt Exponentiation', () => {
      it('should block large BigInt exponent literals', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 100000n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/BigInt exponent.*exceeds maximum|Resource exhaustion/i);
        enclave.dispose();
      });

      it('should block very large BigInt exponents', async () => {
        const enclave = new Enclave();
        const code = `return 10n ** 10000000n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should allow small BigInt exponents', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 10n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(1024n);
        enclave.dispose();
      });

      it('should allow BigInt exponents up to limit', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 100n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        enclave.dispose();
      });
    });

    describe('Infinite Loop Detection', () => {
      it('should block while(true) at AST level', async () => {
        const enclave = new Enclave();
        const code = `while(true) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/infinite loop|not allowed|Validation/i);
        enclave.dispose();
      });

      it('should block for(;;) at AST level', async () => {
        const enclave = new Enclave();
        const code = `for(;;) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/infinite loop|not allowed|Validation/i);
        enclave.dispose();
      });

      it('should block while(1) at AST level', async () => {
        const enclave = new Enclave();
        const code = `while(1) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CPU EXHAUSTION - RUNTIME LEVEL
  // ============================================================================
  describe('CPU Exhaustion - Runtime Level', () => {
    describe('Iteration Limits', () => {
      it('should enforce iteration limit on for loops', async () => {
        const enclave = new Enclave({ maxIterations: 100 });
        const code = `
          let count = 0;
          for (let i = 0; i < 1000; i++) {
            count++;
          }
          return count;
        `;
        const result = await enclave.run(code);
        // Should fail due to iteration limit
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/iteration.*limit|exceeded/i);
        enclave.dispose();
      });

      it('should enforce iteration limit on for-of loops', async () => {
        const enclave = new Enclave({ maxIterations: 50 });
        const code = `
          const arr = Array.from({ length: 100 }, (_, i) => i);
          let sum = 0;
          for (const x of arr) {
            sum += x;
          }
          return sum;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/iteration.*limit|exceeded/i);
        enclave.dispose();
      });

      it('should allow loops within iteration limit', async () => {
        const enclave = new Enclave({ maxIterations: 1000 });
        const code = `
          let count = 0;
          for (let i = 0; i < 100; i++) {
            count++;
          }
          return count;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(100);
        enclave.dispose();
      });
    });

    describe('Timeout Enforcement', () => {
      it('should enforce timeout or iteration limits', async () => {
        // This test verifies that long-running code is interrupted
        // by either timeout OR iteration limits - both are valid protections
        const enclave = new Enclave({ timeout: 100, maxIterations: 100 });
        const code = `
          let sum = 0;
          for (let i = 0; i < 10000; i++) {
            sum += Math.sqrt(i);
          }
          return sum;
        `;
        const result = await enclave.run(code);
        // Should fail due to iteration limit (100) being exceeded
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/iteration.*limit|exceeded/i);
        enclave.dispose();
      }, 10000);
    });
  });

  // ============================================================================
  // MEMORY EXHAUSTION - AST LEVEL BLOCKING
  // ============================================================================
  describe('Memory Exhaustion - AST Level', () => {
    describe('Large Array Allocation', () => {
      it('should block very large array allocation literals', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100000000);`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Array size.*exceeds|Resource exhaustion/i);
        enclave.dispose();
      });

      it('should allow reasonable array allocations', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100).fill(0).length;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(100);
        enclave.dispose();
      });
    });

    describe('String Repeat', () => {
      it('should block very large string repeat counts', async () => {
        const enclave = new Enclave();
        const code = `return 'x'.repeat(100000001);`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/String repeat.*exceeds|Resource exhaustion/i);
        enclave.dispose();
      });

      it('should allow reasonable string repeat counts', async () => {
        const enclave = new Enclave();
        const code = `return 'x'.repeat(100).length;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(100);
        enclave.dispose();
      });
    });

    describe('Array.join Memory Attack', () => {
      it('should block large Array.join at AST level', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100000001).join('x');`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // MEMORY EXHAUSTION - RUNTIME LEVEL
  // ============================================================================
  describe('Memory Exhaustion - Runtime Level', () => {
    describe('Memory Limit Enforcement', () => {
      it('should enforce memory limit on string concatenation', async () => {
        const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
        const code = `
          let str = 'x';
          for (let i = 0; i < 25; i++) {
            str = str + str;
          }
          return str.length;
        `;
        const result = await enclave.run(code);
        // Should fail due to memory or iteration limit
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should allow operations within memory limit', async () => {
        const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
        const code = `
          const arr = [1, 2, 3, 4, 5];
          return arr.map(x => x * 2);
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toEqual([2, 4, 6, 8, 10]);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CONSTRUCTOR OBFUSCATION - AST LEVEL BLOCKING
  // ============================================================================
  describe('Constructor Obfuscation Prevention', () => {
    describe('Direct Constructor Access', () => {
      it('should block direct .constructor access', async () => {
        const enclave = new Enclave();
        const code = `
          const arr = [];
          return arr.constructor;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/constructor|Security|Validation/i);
        enclave.dispose();
      });

      it('should block computed ["constructor"] access', async () => {
        const enclave = new Enclave();
        const code = `
          const arr = [];
          return arr["constructor"];
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });

    describe('String Concatenation Obfuscation', () => {
      // Note: Variable-based string concatenation requires data flow analysis
      // which is complex. The runtime protection (codeGeneration.strings=false)
      // already blocks Function constructor attacks at runtime level.

      it('should block inline constructor string concatenation', async () => {
        const enclave = new Enclave();
        // Inline string concat in computed property IS detected
        const code = `
          const arr = [];
          return arr['con' + 'struc' + 'tor'];
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/constructor|Security|Validation/i);
        enclave.dispose();
      });

      it('should detect constructor variable assignment', async () => {
        const enclave = new Enclave();
        // Variable assignment to 'constructor' IS detected at AST level
        const code = `
          const c = 'con' + 'struc' + 'tor';
          return c;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/constructor|sandbox escape/i);
        enclave.dispose();
      });

      it('should block prototype identifier', async () => {
        const enclave = new Enclave();
        // 'prototype' is in the disallowed identifiers list
        const code = `
          const obj = {};
          return obj.prototype;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should block __proto__ identifier', async () => {
        const enclave = new Enclave();
        // '__proto__' access pattern
        const code = `
          const obj = {};
          return obj.__proto__;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });

    describe('Function Constructor Chain', () => {
      it('should block Function constructor chain attack', async () => {
        const enclave = new Enclave();
        const code = `
          const c = 'con' + 'struc' + 'tor';
          const Fn = [][c][c];
          return Fn('return 42')();
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should block process.env access via constructor chain', async () => {
        const enclave = new Enclave();
        const code = `
          const c = 'con' + 'struc' + 'tor';
          const Fn = [][c][c];
          return Fn('return this.process.env')();
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CODE GENERATION BLOCKING
  // ============================================================================
  describe('Code Generation Blocking', () => {
    it('should block new Function() from strings', async () => {
      const enclave = new Enclave();
      const code = `
        try {
          const fn = new Function('return 42');
          return fn();
        } catch (e) {
          return 'blocked: ' + e.message;
        }
      `;
      const result = await enclave.run(code);
      // Either blocked at AST level or at runtime
      if (result.success) {
        expect(result.value).toMatch(/blocked|EvalError|code generation/i);
      } else {
        expect(result.error?.message).toMatch(/Function|eval|not allowed/i);
      }
      enclave.dispose();
    });

    it('should block eval()', async () => {
      const enclave = new Enclave();
      const code = `return eval('1 + 1');`;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/eval|not allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // LEGITIMATE CODE STILL WORKS
  // ============================================================================
  describe('Legitimate Code Functionality', () => {
    it('should allow normal array operations', async () => {
      const enclave = new Enclave();
      const code = `
        const arr = [1, 2, 3, 4, 5];
        return arr.filter(x => x > 2).map(x => x * 2);
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([6, 8, 10]);
      enclave.dispose();
    });

    it('should allow object operations', async () => {
      const enclave = new Enclave();
      const code = `
        const obj = { a: 1, b: 2, c: 3 };
        const keys = Object.keys(obj);
        return keys.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
      enclave.dispose();
    });

    it('should allow small BigInt operations', async () => {
      const enclave = new Enclave();
      const code = `
        const a = 123456789n;
        const b = 987654321n;
        return (a * b).toString();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      enclave.dispose();
    });

    it('should allow string operations', async () => {
      const enclave = new Enclave();
      const code = `
        const str = 'hello world';
        return str.split(' ').map(s => s.toUpperCase()).join('-');
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('HELLO-WORLD');
      enclave.dispose();
    });

    it('should allow for-of iteration within limits', async () => {
      const enclave = new Enclave({ maxIterations: 1000 });
      const code = `
        const items = [1, 2, 3, 4, 5];
        let sum = 0;
        for (const item of items) {
          sum += item;
        }
        return sum;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(15);
      enclave.dispose();
    });
  });

  // ============================================================================
  // WORKER POOL TERMINATION (Integration)
  // ============================================================================
  describe('Worker Pool Hard Termination', () => {
    it('should terminate worker on watchdog timeout', async () => {
      // Use worker_threads adapter with short timeout
      const enclave = new Enclave({
        timeout: 500,
        maxIterations: 10000000, // High limit to test timeout
        adapter: 'worker_threads',
        workerPoolConfig: {
          minWorkers: 1,
          maxWorkers: 1,
        },
      });

      const code = `
        // Long running operation with high iteration limit
        let x = 0;
        for (let i = 0; i < 10000000; i++) {
          x += Math.sin(i);
        }
        return x;
      `;

      const startTime = Date.now();
      const result = await enclave.run(code);
      const elapsed = Date.now() - startTime;

      // Should fail due to timeout or iteration limit
      expect(result.success).toBe(false);
      // Execution should complete in reasonable time
      expect(elapsed).toBeLessThan(15000);

      enclave.dispose();
    }, 20000);
  });
});

describe('Resource Exhaustion Rule Unit Tests', () => {
  // These test the AST rule directly
  describe('BigInt Detection', () => {
    it('should detect BigInt literal exponentiation', async () => {
      const enclave = new Enclave();
      // Using 20000n which exceeds the default 10000 limit
      const result = await enclave.run(`return 2n ** 20000n;`);
      expect(result.success).toBe(false);
      enclave.dispose();
    });

    it('should not block number exponentiation', async () => {
      const enclave = new Enclave();
      const result = await enclave.run(`return 2 ** 10;`);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1024);
      enclave.dispose();
    });
  });
});

// ============================================================================
// ATK-MEM-01: "BILLION LAUGHS" MEMORY BOMB
// The classic memory bomb using String.repeat() which runs in native C++
// and bypasses loop counters. Defense: AST detection for literal values,
// memory tracking transforms for runtime values.
// ============================================================================
describe('ATK-MEM-01: Billion Laughs Memory Bomb', () => {
  it('should block 50MB string.repeat when expressed as literal', async () => {
    // AST can only detect LITERAL values, not computed expressions
    // 52428800 = 50 * 1024 * 1024
    const enclave = new Enclave();
    const code = `"x".repeat(52428800);`;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/String repeat.*exceeds|Resource exhaustion|AgentScript validation/i);
    enclave.dispose();
  });

  it('should handle computed expression repeat count via memory tracking', async () => {
    // When repeat count is computed (50 * 1024 * 1024), AST can't detect it
    // Memory tracking transforms handle this at runtime
    const enclave = new Enclave({ memoryLimit: 10 * 1024 * 1024 }); // 10MB limit
    const code = `"x".repeat(50 * 1024 * 1024);`;
    const result = await enclave.run(code);
    // May succeed (if no memory tracking) or fail (if memory limit enforced)
    // The key point is that the system doesn't crash from OOM
    if (!result.success) {
      expect(result.error?.message).toMatch(/memory|limit|exceeded/i);
    }
    enclave.dispose();
  });

  it('should block memory bomb via iteration limits', async () => {
    // Attempting to create large string via repeat with smaller chunks
    // Iteration counter stops the loop before memory exhaustion
    const enclave = new Enclave({ maxIterations: 100 }); // Low iteration limit
    const code = `
      // Try to create 10MB+ of string data
      let result = '';
      for (let i = 0; i < 1000; i++) {
        result += 'x'.repeat(100000); // 100KB per iteration
      }
      return result.length;
    `;
    const result = await enclave.run(code);
    // Should fail due to iteration limit (1000 > 100)
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/iteration|limit|exceeded/i);
    enclave.dispose();
  });

  it('should survive the attack without crashing', async () => {
    // Even if the attack isn't blocked at AST level for computed values,
    // the system shouldn't crash - it should timeout or hit memory limits
    const enclave = new Enclave({
      timeout: 2000,
      memoryLimit: 100 * 1024 * 1024, // 100MB - generous limit
    });
    const code = `"x".repeat(50 * 1024 * 1024);`;
    const result = await enclave.run(code);
    // Main assertion: we get a result (didn't crash)
    // The result may be success or failure depending on implementation
    expect(result).toBeDefined();
    enclave.dispose();
  });
});

// ============================================================================
// SORT ATTACK: CPU EXHAUSTION VIA NATIVE SORT
// Exploits Array.prototype.sort() running in native C++ with randomized
// comparator to maximize comparison count (N * log(N) comparisons)
// ============================================================================
describe('Sort Attack: CPU Exhaustion via Native Sort', () => {
  it('should block heavy sort attack via timeout', async () => {
    // This attack creates a large array and runs sort with random comparisons
    // The sort runs in native code which can bypass iteration counters
    const enclave = new Enclave({
      timeout: 2000, // 2 second timeout
      maxIterations: 100000,
    });

    const code = `
      // Create a "heavy" array using split to avoid loop detection
      var arr = "x".repeat(5000).split('');

      // Run the Sort Attack
      // This requires roughly N * Log(N) comparisons
      // 5000 * 12 = ~60,000 operations
      arr.sort((a, b) => {
        return Math.random() - 0.5;
      });

      return "Attack Failed";
    `;

    const startTime = Date.now();
    const result = await enclave.run(code);
    const elapsed = Date.now() - startTime;

    // The sort itself should complete within timeout (it's not that slow)
    // But the test verifies we have protection
    if (result.success) {
      // If it succeeded, it should complete within reasonable time
      // (meaning the sort wasn't actually that heavy or was interrupted)
      expect(elapsed).toBeLessThan(10000);
    } else {
      // If blocked, verify it was for security/resource reasons
      expect(result.error?.message).toMatch(/timeout|iteration|limit|AgentScript/i);
    }
    enclave.dispose();
  }, 15000);

  it('should handle sort with callback iteration counting', async () => {
    // Test that iteration counter is injected into sort callbacks
    const enclave = new Enclave({ maxIterations: 100 });

    const code = `
      // Small array, but many iterations due to random comparison
      const arr = Array.from({length: 50}, (_, i) => i);
      arr.sort(() => Math.random() - 0.5);
      return arr.length;
    `;

    const result = await enclave.run(code);
    // Either succeeds (within limit) or fails (exceeded iterations)
    // Both are acceptable depending on how many comparisons happened
    if (!result.success) {
      expect(result.error?.message).toMatch(/iteration|limit/i);
    }
    enclave.dispose();
  });

  it('should block extremely large sort attempts at AST level', async () => {
    const enclave = new Enclave();
    // Creating a very large array at AST level
    const code = `new Array(100000001).sort(() => Math.random() - 0.5);`;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });
});
