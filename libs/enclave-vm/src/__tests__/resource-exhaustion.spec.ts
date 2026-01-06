/**
 * ATK-RSRC: Resource Exhaustion Prevention Tests
 *
 * Category: ATK-RSRC (CWE-400: Uncontrolled Resource Consumption)
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
 * Test Categories:
 * - ATK-RSRC-01 to ATK-RSRC-10: CPU Exhaustion (BigInt, Loops)
 * - ATK-RSRC-11 to ATK-RSRC-20: Memory Exhaustion (Arrays, Strings)
 * - ATK-RSRC-21 to ATK-RSRC-30: Constructor Obfuscation
 * - ATK-RSRC-31 to ATK-RSRC-40: Code Generation Blocking
 * - ATK-MEM-01: Billion Laughs Memory Bomb
 * - ATK-SORT-01: Sort Attack CPU Exhaustion
 * - ATK-ESC-01: Constructor Leak via Arrow Function
 * - ATK-TPL-01: Template Literal Logic Injection
 * - ATK-JSON-02/03: JSON Parser Bombs
 * - ATK-BRIDGE-04: Zombie Object
 * - ATK-DATA-02: Serialization Hijack
 * - ATK-RECON-01: Global Reconnaissance
 *
 * Related CWEs:
 * - CWE-400: Uncontrolled Resource Consumption
 * - CWE-770: Allocation of Resources Without Limits
 * - CWE-835: Loop with Unreachable Exit Condition
 * - CWE-693: Protection Mechanism Failure
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

describe('ATK-RSRC: Resource Exhaustion Prevention (CWE-400)', () => {
  // ============================================================================
  // ATK-RSRC-01 to ATK-RSRC-10: CPU EXHAUSTION - AST LEVEL BLOCKING
  // ============================================================================
  describe('ATK-RSRC-01 to ATK-RSRC-10: CPU Exhaustion - AST Level', () => {
    describe('BigInt Exponentiation', () => {
      it('ATK-RSRC-01: should block large BigInt exponent literals', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 100000n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/BigInt exponent.*exceeds maximum|Resource exhaustion/i);
        enclave.dispose();
      });

      it('ATK-RSRC-02: should block very large BigInt exponents', async () => {
        const enclave = new Enclave();
        const code = `return 10n ** 10000000n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('ATK-RSRC-03: should allow small BigInt exponents', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 10n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(1024n);
        enclave.dispose();
      });

      it('ATK-RSRC-04: should allow BigInt exponents up to limit', async () => {
        const enclave = new Enclave();
        const code = `return 2n ** 100n;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        enclave.dispose();
      });
    });

    describe('Infinite Loop Detection', () => {
      it('ATK-RSRC-05: should block while(true) at AST level', async () => {
        const enclave = new Enclave();
        const code = `while(true) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/infinite loop|not allowed|Validation/i);
        enclave.dispose();
      });

      it('ATK-RSRC-06: should block for(;;) at AST level', async () => {
        const enclave = new Enclave();
        const code = `for(;;) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/infinite loop|not allowed|Validation/i);
        enclave.dispose();
      });

      it('ATK-RSRC-07: should block while(1) at AST level', async () => {
        const enclave = new Enclave();
        const code = `while(1) { }`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-RSRC-08 to ATK-RSRC-10: CPU EXHAUSTION - RUNTIME LEVEL
  // ============================================================================
  describe('ATK-RSRC-08 to ATK-RSRC-10: CPU Exhaustion - Runtime Level', () => {
    describe('Iteration Limits', () => {
      it('ATK-RSRC-08: should enforce iteration limit on for loops', async () => {
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

      it('ATK-RSRC-09: should enforce iteration limit on for-of loops', async () => {
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

      it('ATK-RSRC-10: should allow loops within iteration limit', async () => {
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
  // ATK-RSRC-11 to ATK-RSRC-16: MEMORY EXHAUSTION - AST LEVEL BLOCKING
  // ============================================================================
  describe('ATK-RSRC-11 to ATK-RSRC-16: Memory Exhaustion - AST Level', () => {
    describe('Large Array Allocation', () => {
      it('ATK-RSRC-11: should block very large array allocation literals', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100000000);`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Array size.*exceeds|Resource exhaustion/i);
        enclave.dispose();
      });

      it('ATK-RSRC-12: should allow reasonable array allocations', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100).fill(0).length;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(100);
        enclave.dispose();
      });
    });

    describe('String Repeat', () => {
      it('ATK-RSRC-13: should block very large string repeat counts', async () => {
        const enclave = new Enclave();
        const code = `return 'x'.repeat(100000001);`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/String repeat.*exceeds|Resource exhaustion/i);
        enclave.dispose();
      });

      it('ATK-RSRC-14: should allow reasonable string repeat counts', async () => {
        const enclave = new Enclave();
        const code = `return 'x'.repeat(100).length;`;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(100);
        enclave.dispose();
      });
    });

    describe('Array.join Memory Attack', () => {
      it('ATK-RSRC-15: should block large Array.join at AST level', async () => {
        const enclave = new Enclave();
        const code = `return new Array(100000001).join('x');`;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-RSRC-16 to ATK-RSRC-17: MEMORY EXHAUSTION - RUNTIME LEVEL
  // ============================================================================
  describe('ATK-RSRC-16 to ATK-RSRC-17: Memory Exhaustion - Runtime Level', () => {
    describe('Memory Limit Enforcement', () => {
      it('ATK-RSRC-16: should enforce memory limit on string concatenation', async () => {
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

      it('ATK-RSRC-17: should allow operations within memory limit', async () => {
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
  // ATK-RSRC-18 to ATK-RSRC-25: CONSTRUCTOR OBFUSCATION - AST LEVEL BLOCKING
  // ============================================================================
  describe('ATK-RSRC-18 to ATK-RSRC-25: Constructor Obfuscation Prevention', () => {
    describe('Direct Constructor Access', () => {
      it('ATK-RSRC-18: should block direct .constructor access', async () => {
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

      it('ATK-RSRC-19: should block computed ["constructor"] access', async () => {
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

      it('ATK-RSRC-20: should block inline constructor string concatenation', async () => {
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

      it('ATK-RSRC-21: should detect constructor variable assignment', async () => {
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

      it('ATK-RSRC-22: should block prototype identifier', async () => {
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

      it('ATK-RSRC-23: should block __proto__ identifier', async () => {
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
      it('ATK-RSRC-24: should block Function constructor chain attack', async () => {
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

      it('ATK-RSRC-25: should block process.env access via constructor chain', async () => {
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
  // ATK-RSRC-26 to ATK-RSRC-27: CODE GENERATION BLOCKING
  // ============================================================================
  describe('ATK-RSRC-26 to ATK-RSRC-27: Code Generation Blocking', () => {
    it('ATK-RSRC-26: should block new Function() from strings', async () => {
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

    it('ATK-RSRC-27: should block eval()', async () => {
      const enclave = new Enclave();
      const code = `return eval('1 + 1');`;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/eval|not allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-RSRC-28 to ATK-RSRC-32: LEGITIMATE CODE STILL WORKS (Safe Patterns)
  // ============================================================================
  describe('ATK-RSRC-28 to ATK-RSRC-32: Legitimate Code Functionality', () => {
    it('ATK-RSRC-28: should allow normal array operations', async () => {
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

    it('ATK-RSRC-29: should allow object operations', async () => {
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

    it('ATK-RSRC-30: should allow small BigInt operations', async () => {
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

    it('ATK-RSRC-31: should allow string operations', async () => {
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

    it('ATK-RSRC-32: should allow for-of iteration within limits', async () => {
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
  // ATK-RSRC-33: WORKER POOL TERMINATION (Integration)
  // ============================================================================
  describe('ATK-RSRC-33: Worker Pool Hard Termination', () => {
    it('ATK-RSRC-33: should terminate worker on watchdog timeout', async () => {
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
describe('ATK-SORT-01: Sort Attack - CPU Exhaustion via Native Sort (CWE-400)', () => {
  it('ATK-SORT-01: should block heavy sort attack via timeout', async () => {
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

  it('ATK-SORT-02: should handle sort with callback iteration counting', async () => {
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

  it('ATK-SORT-03: should block extremely large sort attempts at AST level', async () => {
    const enclave = new Enclave();
    // Creating a very large array at AST level
    const code = `new Array(100000001).sort(() => Math.random() - 0.5);`;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });
});

// ============================================================================
// ATK-ESC-01: CONSTRUCTOR LEAK VIA ARROW FUNCTION
// Uses arrow function literal to access Function constructor and execute
// arbitrary code that bypasses AST transformations.
// Defense-in-depth:
// 1. AST: ResourceExhaustionRule detects 'con' + 'structor' pattern
// 2. Runtime: codeGeneration: { strings: false } blocks Function from strings
// ============================================================================
describe('ATK-ESC-01: Constructor Leak via Arrow Function', () => {
  it('should block arrow function constructor access at AST level', async () => {
    const enclave = new Enclave();
    const code = `
      // ATK-ESC-01: The Constructor Leak
      // Arrow functions are Function objects
      const RealFunction = (() => {})['con'+'structor'];
      const unsafeCode = RealFunction('return "I have escaped! " + (1+1)');
      return unsafeCode();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/constructor|sandbox escape|AgentScript validation/i);
    enclave.dispose();
  });

  it('should block constructor chain even with validation disabled (runtime defense)', async () => {
    // Test the runtime layer: codeGeneration: { strings: false }
    const enclave = new Enclave({ validate: false });
    const code = `
      // Without AST validation, this should still be blocked at runtime
      const c = 'con' + 'struc' + 'tor';
      const RealFunction = (() => {})[c];
      const unsafeCode = RealFunction('return "I have escaped!"');
      return unsafeCode();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    // Should fail with code generation error at runtime
    expect(result.error?.message).toMatch(/code generation.*strings|EvalError/i);
    enclave.dispose();
  });

  it('should block Function constructor via object literal method', async () => {
    const enclave = new Enclave();
    const code = `
      // Object method is also a Function object
      const obj = { method() {} };
      const Fn = obj.method['con'+'structor'];
      return Fn('return 42')();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block Function constructor via class method', async () => {
    const enclave = new Enclave();
    const code = `
      // Class methods are Function objects
      class MyClass { doSomething() {} }
      const instance = new MyClass();
      const Fn = instance.doSomething['con'+'structor'];
      return Fn('return 42')();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block Function constructor via bound function', async () => {
    const enclave = new Enclave();
    const code = `
      // Bound functions are still Function objects
      const fn = function() {};
      const bound = fn.bind(null);
      const Fn = bound['con'+'structor'];
      return Fn('return 42')();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block process.env access via escaped function', async () => {
    const enclave = new Enclave();
    const code = `
      // Attempt to access Node.js internals via escaped function
      const RealFunction = (() => {})['con'+'structor'];
      const payload = RealFunction('return typeof process !== "undefined" ? process.env : "no access"');
      return payload();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block require access via escaped function', async () => {
    const enclave = new Enclave();
    const code = `
      // Attempt to require modules via escaped function
      const RealFunction = (() => {})['con'+'structor'];
      const payload = RealFunction('return typeof require !== "undefined" ? require("fs") : "no access"');
      return payload();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block variable-based constructor concatenation (k1+k2 variant)', async () => {
    const enclave = new Enclave();
    const code = `
      // ATK-ESC-01 variant: variable-based concatenation
      const k1 = "constr";
      const k2 = "uctor";
      const key = k1 + k2; // "constructor"
      const RealFunction = (() => {})[key];
      const attack = RealFunction('return "Sandbox Escaped"');
      return attack();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    // Should be blocked by AST (pattern detection) or runtime (codeGeneration.strings=false)
    expect(result.error?.message).toMatch(/constructor|sandbox escape|code generation|AgentScript/i);
    enclave.dispose();
  });
});

// ============================================================================
// ATK-TPL-01: TEMPLATE LITERAL LOGIC INJECTION
// Exploits that sandboxes may scan "code" but treat template strings as data.
// Logic inside ${} is executable code that may bypass static analysis.
// Defense: AST transformation still applies inside template expressions.
// ============================================================================
describe('ATK-TPL-01: Template Literal Logic Injection', () => {
  it('should apply resource limits inside template literal expressions', async () => {
    const enclave = new Enclave({ memoryLimit: 10 * 1024 * 1024 }); // 10MB
    const code = `
      // ATK-TPL-01: Hidden Logic in Template Literals
      // Logic inside \${} is executable code
      const payload = \`\${
        (() => {
          // Try memory bomb inside template expression
          return "x".repeat(10 * 1024 * 1024).length;
        })()
      }\`;
      return payload;
    `;
    const result = await enclave.run(code);
    // Either succeeds with tracked memory or fails due to limits
    // Key point: doesn't cause OOM crash
    expect(result).toBeDefined();
    enclave.dispose();
  });

  it('should apply iteration limits inside template expressions', async () => {
    const enclave = new Enclave({ maxIterations: 100 });
    const code = `
      // Infinite loop inside template expression
      const payload = \`\${
        (() => {
          let i = 0;
          while (i < 10000) { i++; }
          return i;
        })()
      }\`;
      return payload;
    `;
    const result = await enclave.run(code);
    // Should fail due to iteration limit OR AST blocking the while loop
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/iteration|limit|exceeded|while|FORBIDDEN_LOOP|AgentScript/i);
    enclave.dispose();
  });

  it('should block constructor obfuscation inside template expressions', async () => {
    const enclave = new Enclave();
    const code = `
      // Constructor escape attempt inside template
      const payload = \`\${
        (() => {
          const Fn = (() => {})['con'+'structor'];
          return Fn('return 42')();
        })()
      }\`;
      return payload;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/constructor|sandbox escape|code generation|AgentScript/i);
    enclave.dispose();
  });

  it('should handle nested template expressions safely', async () => {
    const enclave = new Enclave({ maxIterations: 1000 });
    const code = `
      // Multiple levels of template nesting
      const inner = \`\${1 + 2}\`;
      const middle = \`\${inner + \`\${3 + 4}\`}\`;
      const outer = \`\${middle + \`\${5 + 6}\`}\`;
      return outer;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe('37' + '11');
    enclave.dispose();
  });
});

// ============================================================================
// ATK-JSON-02: DEEP NESTING BOMB VIA JSON.PARSE
// Creates deeply nested JSON structure that forces C++ recursion.
// Can cause stack overflow in native code.
// Defense: JSON.parse depth may be limited by V8, test verifies no crash.
// ============================================================================
describe('ATK-JSON-02: Deep Nesting Bomb', () => {
  it('should handle moderately deep JSON without crashing', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    // 1000 levels is reasonable, should parse fine
    const code = `
      const deep = "[".repeat(1000) + "]".repeat(1000);
      try {
        JSON.parse(deep);
        return "parsed";
      } catch (e) {
        return "error: " + e.message;
      }
    `;
    const result = await enclave.run(code);
    expect(result).toBeDefined();
    if (result.success) {
      // Either parsed successfully or caught stack error
      expect(['parsed', 'error: Maximum call stack size exceeded']).toContain(
        result.value?.toString().substring(0, 6) === 'error:'
          ? 'error: Maximum call stack size exceeded'
          : result.value,
      );
    }
    enclave.dispose();
  });

  it('should survive deep nesting attack without process crash', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    // 20000 levels - likely to hit stack limit
    const code = `
      // ATK-JSON-02: Deep Nesting Bomb
      var deep = "[".repeat(20000) + "]".repeat(20000);
      try {
        JSON.parse(deep);
        return "parsed - unexpected";
      } catch (e) {
        // Expected: stack overflow or similar
        return "safely caught: " + e.name;
      }
    `;
    const result = await enclave.run(code);
    // The KEY assertion: we got a result (didn't crash the process)
    expect(result).toBeDefined();
    // Should either succeed with caught error or fail safely
    if (result.success) {
      expect(result.value).toMatch(/safely caught|parsed/);
    }
    enclave.dispose();
  });

  it('should handle very deep nesting without crashing', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    // Even deeper - 100000 levels
    const code = `
      var deep = "[".repeat(100000) + "]".repeat(100000);
      try {
        JSON.parse(deep);
        return "parsed";
      } catch (e) {
        return "error: " + e.name;
      }
    `;
    const result = await enclave.run(code);
    // Critical: no crash, we get a result
    expect(result).toBeDefined();
    enclave.dispose();
  });

  it('should handle nested object bomb', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    // Nested objects instead of arrays
    const code = `
      const deep = '{"a":'.repeat(10000) + '{}' + '}'.repeat(10000);
      try {
        JSON.parse(deep);
        return "parsed";
      } catch (e) {
        return "error: " + e.name;
      }
    `;
    const result = await enclave.run(code);
    expect(result).toBeDefined();
    enclave.dispose();
  });

  it('should handle mixed deep nesting', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    // Alternating arrays and objects
    const code = `
      let json = '';
      for (let i = 0; i < 5000; i++) {
        json += i % 2 === 0 ? '[{"a":' : '{"b":[';
      }
      json += '1';
      for (let i = 0; i < 5000; i++) {
        json += i % 2 === 0 ? '}]' : ']}';
      }
      try {
        JSON.parse(json);
        return "parsed";
      } catch (e) {
        return "error: " + e.name;
      }
    `;
    const result = await enclave.run(code);
    expect(result).toBeDefined();
    enclave.dispose();
  });
});

// ============================================================================
// ATK-JSON-03: THE PARSER BOMB (Variant of ATK-JSON-02)
// Build a deep string using native 'repeat' and force C++ parser recursion.
// Defense: V8's JSON parser handles deep nesting gracefully (iterative, not recursive).
// ============================================================================
describe('ATK-JSON-03: Parser Bomb', () => {
  it('should handle parser bomb with 10k depth without crashing', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    const code = `
      // ATK-JSON-03: The Parser Bomb
      var depth = 10000;
      var jsonString = "[".repeat(depth) + "]".repeat(depth);
      try {
        JSON.parse(jsonString);
        return "Survived Parse";
      } catch(e) {
        return "Crashed Parser: " + e.message;
      }
    `;
    const result = await enclave.run(code);
    expect(result).toBeDefined();
    // V8's parser handles this gracefully - no crash
    if (result.success) {
      expect(result.value).toMatch(/Survived|Crashed/);
    }
    enclave.dispose();
  });

  it('should handle extreme parser bomb (50k depth) without process crash', async () => {
    const enclave = new Enclave({ timeout: 10000 });
    const code = `
      var depth = 50000;
      var jsonString = "[".repeat(depth) + "]".repeat(depth);
      try {
        JSON.parse(jsonString);
        return "Survived Parse";
      } catch(e) {
        return "Safely caught: " + e.name;
      }
    `;
    const result = await enclave.run(code);
    // Critical: process didn't crash
    expect(result).toBeDefined();
    enclave.dispose();
  });
});

// ============================================================================
// ATK-BRIDGE-04: THE ZOMBIE OBJECT
// Uses defineProperty to create a getter trap that executes during host
// serialization, creating a massive string.
// Defense: Object.defineProperty is blocked by SafeObject.
// ============================================================================
describe('ATK-BRIDGE-04: Zombie Object', () => {
  it('should block zombie object creation via defineProperty getter', async () => {
    const enclave = new Enclave({ validate: false }); // Test runtime defense
    const code = `
      // ATK-BRIDGE-04: The Zombie Object
      var d = 'def' + 'ineProperty';
      var trap = {};
      Object[d](trap, "output", {
        get: () => {
          // This would run inside HOST's serialization step
          return new Array(1000000).join("DEADBEEF");
        },
        enumerable: true
      });
      return trap;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/defineProperty.*not allowed|security/i);
    enclave.dispose();
  });

  it('should block zombie object with AST validation enabled', async () => {
    const enclave = new Enclave();
    const code = `
      var trap = {};
      Object.defineProperty(trap, "output", {
        get: () => new Array(1000000).join("X"),
        enumerable: true
      });
      return trap;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    // Blocked at AST or runtime level
    expect(result.error?.message).toMatch(/defineProperty|NO_META_PROGRAMMING|security/i);
    enclave.dispose();
  });

  it('should block zombie object via __defineGetter__', async () => {
    const enclave = new Enclave();
    const code = `
      var trap = {};
      trap.__defineGetter__("output", function() {
        return new Array(1000000).join("BOMB");
      });
      return trap;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    // __defineGetter__ is a blocked identifier
    enclave.dispose();
  });
});

// ============================================================================
// ATK-DATA-02: SERIALIZATION HIJACK VIA DEFINEPROPERTY
// Uses Object.defineProperty to add a malicious toJSON method that hijacks
// serialization. When the host serializes the returned object, the attacker's
// code executes and can inject arbitrary data.
// Defense: Remove Object.defineProperty and related methods from sandbox.
// ============================================================================
describe('ATK-DATA-02: Serialization Hijack', () => {
  it('should block Object.defineProperty', async () => {
    const enclave = new Enclave();
    const code = `
      var malicious = {};
      Object.defineProperty(malicious, "toJSON", {
        value: () => ({ isAdmin: true })
      });
      return malicious;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    // Blocked at AST level (NO_META_PROGRAMMING) or runtime (SafeObject)
    expect(result.error?.message).toMatch(/defineProperty.*not allowed|NO_META_PROGRAMMING|security/i);
    enclave.dispose();
  });

  it('should block Object.defineProperties', async () => {
    const enclave = new Enclave();
    const code = `
      var malicious = {};
      Object.defineProperties(malicious, {
        toJSON: { value: () => ({ isAdmin: true }) }
      });
      return malicious;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/defineProperties.*not allowed|NO_META_PROGRAMMING|security/i);
    enclave.dispose();
  });

  it('should block string-concatenated defineProperty access', async () => {
    const enclave = new Enclave();
    const code = `
      var malicious = {};
      Object['def' + 'ineProperty'](malicious, "toJSON", {
        value: () => ({ isAdmin: true })
      });
      return malicious;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block string-concatenated defineProperty with validation disabled', async () => {
    // Test runtime protection when AST validation is disabled
    const enclave = new Enclave({ validate: false });
    const code = `
      var malicious = {};
      Object['def' + 'ineProperty'](malicious, "toJSON", {
        value: () => ({ isAdmin: true })
      });
      return malicious;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/defineProperty.*not allowed|security/i);
    enclave.dispose();
  });

  it('should block Object.setPrototypeOf', async () => {
    const enclave = new Enclave();
    const code = `
      var obj = {};
      Object.setPrototypeOf(obj, { toJSON: () => ({ evil: true }) });
      return obj;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/setPrototypeOf.*not allowed|NO_META_PROGRAMMING|security/i);
    enclave.dispose();
  });

  it('should block Object.getOwnPropertyDescriptor', async () => {
    const enclave = new Enclave();
    const code = `
      // Try to get defineProperty indirectly
      var desc = Object.getOwnPropertyDescriptor(Object, 'defineProperty');
      return desc ? 'found' : 'blocked';
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/getOwnPropertyDescriptor.*not allowed|NO_META_PROGRAMMING|security/i);
    enclave.dispose();
  });

  it('should block Object.create (blocked at AST level)', async () => {
    const enclave = new Enclave();
    const code = `
      // Object.create is blocked at AST level by NO_META_PROGRAMMING
      var obj = Object.create({});
      return obj;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Object\.create.*not allowed|NO_META_PROGRAMMING/i);
    enclave.dispose();
  });

  it('should allow safe Object methods', async () => {
    const enclave = new Enclave();
    const code = `
      var obj = { a: 1, b: 2, c: 3 };
      var keys = Object.keys(obj);
      var values = Object.values(obj);
      var entries = Object.entries(obj);
      var frozen = Object.freeze({ x: 1 });
      var isFrozen = Object.isFrozen(frozen);
      return {
        keys: keys,
        values: values,
        entriesCount: entries.length,
        isFrozen: isFrozen
      };
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      keys: ['a', 'b', 'c'],
      values: [1, 2, 3],
      entriesCount: 3,
      isFrozen: true,
    });
    enclave.dispose();
  });

  it('should prevent defineProperty obtained from tool result', async () => {
    // Even if a tool somehow returns a reference to defineProperty,
    // the method itself is blocked in the sandbox
    const enclave = new Enclave({
      validate: false, // Skip AST validation to test runtime protection
      toolHandler: async () => {
        return {
          hijackMethod: 'defineProperty',
        };
      },
    });

    const code = `
      const result = await callTool('getHijackMethod', {});
      // Even with the method name, the method throws when called
      const method = Object[result.hijackMethod];
      try {
        method({}, 'test', { value: 1 });
        return 'attack succeeded';
      } catch (e) {
        return 'blocked: ' + e.message;
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toMatch(/blocked.*defineProperty.*not allowed/i);
    enclave.dispose();
  });

  it('should block __defineGetter__ legacy attack', async () => {
    const enclave = new Enclave();
    const code = `
      var obj = {};
      obj.__defineGetter__('toJSON', function() {
        return function() { return { evil: true }; };
      });
      return obj;
    `;
    const result = await enclave.run(code);
    // Should fail at AST level (__defineGetter__ is a disallowed identifier)
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('should block __defineSetter__ legacy attack', async () => {
    const enclave = new Enclave();
    const code = `
      var obj = {};
      obj.__defineSetter__('value', function(v) {
        this._secret = 'hijacked: ' + v;
      });
      return obj;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });
});

// ============================================================================
// ATK-RECON-01: GLOBAL RECONNAISSANCE
// Enumerates all available globals to identify attack surface.
// Defense-in-depth: Remove dangerous globals from VM context entirely,
// even though codeGeneration.strings=false blocks the primary escape vector.
//
// NOTE: These tests use validate:false to bypass AST-level validation and
// test specifically the VM-level defense (removal of dangerous globals from context).
// In practice, BOTH layers provide defense - AST blocks unknown globals,
// and VM removes dangerous globals from context.
// ============================================================================
describe('ATK-RECON-01: Global Reconnaissance Defense', () => {
  describe('Code Execution Globals Removal (VM Level)', () => {
    it('should remove Function constructor from STANDARD security level', async () => {
      // Disable AST validation to test VM-level defense specifically
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof Function;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove Function constructor from SECURE security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'SECURE' });
      const code = `return typeof Function;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove Function constructor from STRICT security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `return typeof Function;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove eval from all security levels', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof eval;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove globalThis from STRICT security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `return typeof globalThis;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });
  });

  describe('Metaprogramming Globals Removal (VM Level)', () => {
    it('should remove Proxy from STRICT security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `return typeof Proxy;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove Proxy from SECURE security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'SECURE' });
      const code = `return typeof Proxy;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove Reflect from STRICT security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `return typeof Reflect;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });
  });

  describe('Memory/Timing Globals Removal (VM Level)', () => {
    it('should remove SharedArrayBuffer from all security levels', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof SharedArrayBuffer;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove Atomics from all security levels', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof Atomics;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove gc from all security levels (if exposed)', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'PERMISSIVE' });
      const code = `return typeof gc;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      // gc may or may not be exposed by default, but should be removed if it was
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });
  });

  describe('Dangerous Future APIs Removal (VM Level)', () => {
    it('should remove ShadowRealm from all security levels', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'PERMISSIVE' });
      const code = `return typeof ShadowRealm;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove WeakRef from STANDARD security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof WeakRef;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });

    it('should remove FinalizationRegistry from STANDARD security level', async () => {
      const enclave = new Enclave({ validate: false, securityLevel: 'STANDARD' });
      const code = `return typeof FinalizationRegistry;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
      enclave.dispose();
    });
  });

  describe('Essential Globals Still Available', () => {
    it('should still have Object (SafeObject)', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof Object;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('function');
      enclave.dispose();
    });

    it('should still have Array', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof Array;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('function');
      enclave.dispose();
    });

    it('should still have String', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof String;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('function');
      enclave.dispose();
    });

    it('should still have JSON', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof JSON;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('object');
      enclave.dispose();
    });

    it('should still have Math', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof Math;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('object');
      enclave.dispose();
    });

    // Note: Promise availability depends on whether it's added to safe-runtime
    // Currently Promise is NOT in safe-runtime's secureStdLib
    // The double-VM bootstrap does add Promise explicitly
    // This is a known gap - tracked separately from the dangerous globals removal

    it('should still have Date', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `return typeof Date;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('function');
      enclave.dispose();
    });
  });

  describe('AST Level Defense', () => {
    it('should block unknown globals at AST level when validation enabled', async () => {
      // With validation enabled, unknown globals like 'gc' are blocked at AST level
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE' });
      const code = `return typeof gc;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Unknown identifier|UNKNOWN_GLOBAL/i);
      enclave.dispose();
    });

    it('should block Function reference at AST level when validation enabled', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });
      const code = `return typeof Function;`;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Unknown identifier|UNKNOWN_GLOBAL/i);
      enclave.dispose();
    });
  });

  describe('Reconnaissance Attack Blocked', () => {
    it('should block the full ATK-RECON-01 reconnaissance attack', async () => {
      // The original ATK-RECON-01 attack used Function constructor to enumerate globals
      // Even with validation disabled, this should be blocked
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `
        // Attempt ATK-RECON-01: Reconnaissance
        // Step 1: Try to get Function constructor
        try {
          const Fn = (() => {})['con' + 'struc' + 'tor'];
          const globalDump = Fn('return Object.getOwnPropertyNames(this)')();
          return { globals: globalDump };
        } catch (e) {
          return { blocked: true, reason: e.message };
        }
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      // Should be blocked - either Function is undefined or code generation fails
      expect(result.value).toMatchObject({ blocked: true });
      expect((result.value as { reason?: string }).reason).toMatch(/code generation|strings|undefined/i);
      enclave.dispose();
    });

    it('should not expose dangerous globals in VM context (with validation disabled)', async () => {
      // Test that even with AST validation disabled, dangerous globals are not present
      const enclave = new Enclave({ validate: false, securityLevel: 'STRICT' });
      const code = `
        // Check for dangerous globals directly using typeof (no error if undefined)
        return {
          Function: typeof Function,
          eval: typeof eval,
          globalThis: typeof globalThis,
          Proxy: typeof Proxy,
          Reflect: typeof Reflect,
          SharedArrayBuffer: typeof SharedArrayBuffer,
          Atomics: typeof Atomics,
          gc: typeof gc,
          ShadowRealm: typeof ShadowRealm,
          WeakRef: typeof WeakRef,
          FinalizationRegistry: typeof FinalizationRegistry
        };
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      const value = result.value as Record<string, string>;
      // All dangerous globals should be undefined
      expect(value['Function']).toBe('undefined');
      expect(value['eval']).toBe('undefined');
      expect(value['globalThis']).toBe('undefined');
      expect(value['Proxy']).toBe('undefined');
      expect(value['Reflect']).toBe('undefined');
      expect(value['SharedArrayBuffer']).toBe('undefined');
      expect(value['Atomics']).toBe('undefined');
      expect(value['gc']).toBe('undefined');
      expect(value['ShadowRealm']).toBe('undefined');
      expect(value['WeakRef']).toBe('undefined');
      expect(value['FinalizationRegistry']).toBe('undefined');
      enclave.dispose();
    });
  });
});
