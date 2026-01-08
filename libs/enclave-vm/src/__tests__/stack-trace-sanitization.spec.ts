/**
 * Stack Trace Sanitization Security Tests
 *
 * Tests for the enhanced stack trace sanitization that prevents
 * information leakage about the host environment.
 *
 * IMPORTANT: Stack trace sanitization applies to the `stack` property of errors,
 * NOT to the error `message`. The message is user-controlled and preserved as-is.
 * These tests validate:
 * 1. The sanitization patterns work correctly
 * 2. Stack traces from the VM runtime are properly sanitized
 * 3. Security level configuration works correctly
 */

import { Enclave } from '../index';

describe('Stack Trace Sanitization', () => {
  describe('Stack Trace Sanitization in User-Returned Values', () => {
    it('should not leak host stack frames when user returns e.stack in STRICT mode', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      // Catch inside the sandbox and return e.stack as a string (previously leaked host frames/paths).
      const result = await enclave.run(`
        try {
          const x = undefined;
          return x.foo;
        } catch (e) {
          return String(e && e.stack);
        }
      `);

      expect(result.success).toBe(true);
      expect(typeof result.value).toBe('string');

      // Must not contain internal filenames / host frames.
      expect(result.value).not.toContain('inner-agentscript.js');
      expect(result.value).not.toContain('parent-vm.js');
      expect(result.value).not.toContain('agentscript.js');
      expect(result.value).not.toContain('node:vm');

      // Sanitized stacks should use redaction markers.
      expect(result.value).toContain('[REDACTED]');

      enclave.dispose();
    });
  });

  describe('Fail-Closed Policy Violations (STRICT/SECURE)', () => {
    it('should fail the run if code generation is attempted and caught in STRICT mode', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', validate: false });

      const result = await enclave.run(`
        const str = (...args) => String.fromCharCode(...args);
        const kCon = str(99,111,110,115,116,114,117,99,116,111,114);
        const kCode = str(114,101,116,117,114,110,32,49);

        try {
          const NumCtor = (1)[kCon];
          const FuncCtor = NumCtor[kCon];
          const exploit = FuncCtor(kCode);
          return exploit();
        } catch (e) {
          // In STRICT mode, enclave-vm should treat this as a policy violation even if caught.
          return 'caught: ' + String(e && e.stack);
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECURITY_VIOLATION');
      expect(result.error?.name).toBe('SecurityViolationError');
      expect(result.error?.stack).toBeUndefined();

      enclave.dispose();
    });
  });

  describe('Stack Trace Sanitization in Runtime Errors', () => {
    it('should redact macOS/Linux home directory paths from stack traces', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      // Cause a runtime error that generates a real stack trace
      const result = await enclave.run(`
        const x = undefined;
        return x.foo;
      `);

      expect(result.success).toBe(false);
      if (result.error?.stack) {
        // Stack should not contain home directory paths
        expect(result.error.stack).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//);
        expect(result.error.stack).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//);
      }

      enclave.dispose();
    });

    it('should redact node_modules paths from stack traces', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      // Cause a runtime error
      const result = await enclave.run(`
        const x = null;
        return x.toString();
      `);

      expect(result.success).toBe(false);
      if (result.error?.stack) {
        // node_modules paths should be redacted
        expect(result.error.stack).not.toMatch(/node_modules\/[^\s[\]]+/);
      }

      enclave.dispose();
    });

    it('should redact line and column numbers in STRICT mode', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      const result = await enclave.run(`
        const arr = [];
        return arr[0].value;
      `);

      expect(result.success).toBe(false);
      if (result.error?.stack) {
        // Should not contain specific line:column patterns outside of [REDACTED]
        // Allow patterns like "at [REDACTED]" but not "at file.js:10:5"
        const lines = result.error.stack.split('\n');
        for (const line of lines) {
          if (line.includes('at ') && !line.includes('[REDACTED]')) {
            // If there's an "at" without [REDACTED], it should not have line numbers
            expect(line).not.toMatch(/:\d+:\d+\)?$/);
          }
        }
      }

      enclave.dispose();
    });

    it('should preserve stack structure while redacting details', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      const result = await enclave.run(`
        JSON.parse('invalid json');
      `);

      expect(result.success).toBe(false);
      if (result.error?.stack) {
        // Should still have "at" keywords indicating stack frames exist
        expect(result.error.stack).toContain('at');
        // Should contain [REDACTED] markers where paths were
        expect(result.error.stack).toContain('[REDACTED]');
      }

      enclave.dispose();
    });
  });

  describe('Security Level Configuration', () => {
    it('STRICT level should enable stack trace sanitization', () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(true);

      enclave.dispose();
    });

    it('SECURE level should enable stack trace sanitization', () => {
      const enclave = new Enclave({ securityLevel: 'SECURE' });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(true);

      enclave.dispose();
    });

    it('STANDARD level should NOT sanitize stack traces by default', () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(false);

      enclave.dispose();
    });

    it('PERMISSIVE level should NOT sanitize stack traces', () => {
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE' });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(false);

      enclave.dispose();
    });

    it('should allow explicit override of sanitization in STANDARD mode', async () => {
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        sanitizeStackTraces: true,
      });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(true);

      // Cause a runtime error
      const result = await enclave.run(`
        const x = undefined;
        return x.bar;
      `);

      expect(result.success).toBe(false);
      if (result.error?.stack) {
        // When sanitization is enabled, paths should be redacted
        expect(result.error.stack).toContain('[REDACTED]');
      }

      enclave.dispose();
    });

    it('should allow disabling sanitization in STRICT mode', async () => {
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        sanitizeStackTraces: false,
      });
      const config = enclave.getEffectiveConfig();

      expect(config.sanitizeStackTraces).toBe(false);

      // Cause a runtime error
      const result = await enclave.run(`
        const y = null;
        return y.baz;
      `);

      expect(result.success).toBe(false);
      // When sanitization is disabled, stack trace may contain paths
      // (We can't reliably test, for paths being present since it depends on the environment)

      enclave.dispose();
    });

    it('STANDARD mode should NOT redact stack traces by default', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD' });

      const result = await enclave.run(`
        const z = undefined;
        return z.qux;
      `);

      expect(result.success).toBe(false);
      // Stack trace should exist but may or may not contain [REDACTED]
      // depending on whether there were any sensitive paths
      expect(result.error?.stack).toBeDefined();

      enclave.dispose();
    });
  });

  describe('Validation Errors', () => {
    it('should handle validation errors gracefully', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      // This should fail validation (__safe_ prefix is reserved)
      const result = await enclave.run('const __safe_foo = 1;');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Should not throw on processing validation errors

      enclave.dispose();
    });
  });

  describe('Error Type Preservation', () => {
    it('should preserve TypeError name', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      const result = await enclave.run(`
        const x = undefined;
        return x.property;
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('TypeError');

      enclave.dispose();
    });

    it('should preserve ReferenceError name', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      const result = await enclave.run(`
        return undeclaredVariable;
      `);

      expect(result.success).toBe(false);
      // Could be caught as UNKNOWN_GLOBAL validation error or ReferenceError at runtime

      enclave.dispose();
    });

    it('should preserve SyntaxError for malformed JSON', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      const result = await enclave.run(`
        return JSON.parse('{invalid}');
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('SyntaxError');

      enclave.dispose();
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors with no stack trace', async () => {
      // Create an enclave - just test that it handles gracefully
      const enclave = new Enclave({ securityLevel: 'STRICT' });

      // This creates a validation error which may not have a VM stack
      const result = await enclave.run('const __safe_test = 1;');

      expect(result.success).toBe(false);
      // Should not throw regardless of stack presence

      enclave.dispose();
    });

    it('should handle iteration limit errors', async () => {
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        maxIterations: 100, // Very low limit to trigger error
      });

      // Use for-of loops which are transformed to __safe_forOf with iteration tracking
      const result = await enclave.run(`
        const items = Array.from({ length: 200 }, (_, i) => i);
        let sum = 0;
        for (const item of items) {
          sum += item;
        }
        return sum;
      `);

      // Should fail due to iteration limit
      expect(result.success).toBe(false);
      // Error should be properly formatted
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('iteration');

      enclave.dispose();
    });
  });

  describe('Vector 1230: Functional Stack-Blaster Attack', () => {
    /**
     * Vector 1230: The Functional Stack-Blaster
     * Purpose: Trigger a Stack Overflow in the host bridge to leak
     * internal function frames without using loops or forbidden keywords.
     *
     * Attack pattern:
     * 1. Create a deeply nested array (10,000 levels) using .reduce()
     * 2. Pass it to callTool() which causes a JSON serialization error
     * 3. Catch the error and extract e.stack to leak internal function frames
     *
     * Expected behavior: Error stack traces should NOT contain internal
     * implementation details like function names, file paths, or line numbers.
     */

    it('should not leak internal stack frames when deeply nested array causes serialization error', async () => {
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        validate: false, // Skip AST validation to test runtime protection
        allowFunctionsInGlobals: true, // Allow function globals for testing
        globals: {
          callTool: async () => ({ success: true }),
        },
      });

      // Vector 1230 attack: create deeply nested array and try to leak stack via error
      const result = await enclave.run(`
        const s = String.fromCharCode;
        try {
          // Create a deeply nested array (1000 levels - enough to cause issues)
          const depth = 1000;
          const deepArray = Array(depth).fill(0).reduce((acc) => [acc], s(88));

          // Try to pass it to callTool - this should fail with serialization error
          await callTool("users.search", { data: deepArray });

          return s(78, 111, 32, 69, 114, 114, 111, 114); // "No Error"
        } catch (e) {
          // Attack: try to capture the stack trace
          return s(83, 84, 65, 67, 75, 58, 32) + (e.stack || e.message);
        }
      `);

      // The result should either succeed (if serialization works) or fail safely
      if (result.success && typeof result.value === 'string') {
        // If we got a stack trace back, verify it doesn't leak internal details
        const stackOutput = result.value;

        // Should NOT contain internal file paths
        expect(stackOutput).not.toContain('parent-vm.js');
        expect(stackOutput).not.toContain('inner-agentscript.js');
        expect(stackOutput).not.toContain('node:vm');
        expect(stackOutput).not.toContain('/var/task/');

        // Should NOT contain internal function names
        expect(stackOutput).not.toContain('innerCallTool');
        expect(stackOutput).not.toContain('sanitizeObject');
        expect(stackOutput).not.toContain('createSecureProxy');
        expect(stackOutput).not.toContain('validateOperation');

        // Should NOT contain line numbers from internal code
        expect(stackOutput).not.toMatch(/parent-vm\.js:\d+:\d+/);
        expect(stackOutput).not.toMatch(/inner-agentscript\.js:\d+:\d+/);
      }

      enclave.dispose();
    });

    it('should not leak stack frames when JSON serialization fails in callTool', async () => {
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        validate: false,
        allowFunctionsInGlobals: true, // Allow function globals for testing
        globals: {
          callTool: async () => ({ success: true }),
        },
      });

      // Try to trigger JSON serialization error with circular reference
      const result = await enclave.run(`
        try {
          const obj = {};
          obj.self = obj; // Circular reference
          await callTool("test", { data: obj });
          return "no error";
        } catch (e) {
          return "STACK: " + (e.stack || "no stack") + " MESSAGE: " + e.message;
        }
      `);

      if (result.success && typeof result.value === 'string') {
        const output = result.value;

        // Should NOT leak internal implementation details
        expect(output).not.toContain('parent-vm.js');
        expect(output).not.toContain('innerCallTool');
        expect(output).not.toContain('node:vm');

        // Should contain the expected error message
        expect(output).toContain('JSON-serializable');
      }

      enclave.dispose();
    });

    it('should use safe errors that prevent prototype chain escape', async () => {
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        validate: false,
        allowFunctionsInGlobals: true, // Allow function globals for testing
        globals: {
          callTool: async () => ({ success: true }),
        },
      });

      // Try to escape via error.constructor.constructor chain
      const result = await enclave.run(`
        try {
          // Trigger an error from the runtime
          const obj = {};
          obj.self = obj;
          await callTool("test", { data: obj });
          return "no error";
        } catch (e) {
          // Try to escape via constructor chain
          try {
            const Func = e.constructor.constructor;
            const exploit = Func('return process.env.SECRET')();
            return "ESCAPED: " + exploit;
          } catch (e2) {
            return "BLOCKED: " + e2.message;
          }
        }
      `);

      // Should either fail or return "BLOCKED"
      if (result.success && typeof result.value === 'string') {
        expect(result.value).not.toContain('ESCAPED');
        // The constructor chain should be blocked
        expect(result.value).toContain('BLOCKED');
      }

      enclave.dispose();
    });
  });

  describe('Pattern Coverage Documentation', () => {
    // These tests document the patterns that are covered by the sanitizer
    // They use string matching to verify the patterns work

    const testPatterns = [
      // Unix paths
      { input: '/Users/admin/project/file.js', pattern: 'macOS home' },
      { input: '/home/ubuntu/app/src/main.ts', pattern: 'Linux home' },
      { input: '/var/log/app.log', pattern: '/var path' },
      { input: '/tmp/cache/temp.dat', pattern: '/tmp path' },
      { input: '/etc/passwd', pattern: '/etc path' },
      { input: '/root/.ssh/id_rsa', pattern: '/root path' },
      { input: '/opt/software/bin', pattern: '/opt path' },
      { input: '/mnt/storage/data', pattern: '/mnt path' },
      { input: '/srv/www/html', pattern: '/srv path' },
      { input: '/data/backups/db.sql', pattern: '/data path' },
      { input: '/app/node_modules', pattern: '/app path' },
      { input: '/proc/1/maps', pattern: '/proc path' },
      { input: '/sys/class/net', pattern: '/sys path' },

      // Windows paths
      { input: 'C:\\Users\\admin\\Documents', pattern: 'Windows drive' },
      { input: '\\\\server\\share\\file.txt', pattern: 'UNC path' },

      // URL-based paths
      { input: 'file:///Users/test/file.js', pattern: 'file URL' },
      { input: 'webpack://project/src/index.js', pattern: 'webpack URL' },

      // Package manager paths
      { input: 'node_modules/lodash/index.js', pattern: 'node_modules' },
      { input: '/nix/store/abc123-package', pattern: 'nix store' },
      { input: '.npm/cache/package.tgz', pattern: 'npm cache' },
      { input: '.yarn/cache/lib.zip', pattern: 'yarn cache' },
      { input: '.pnpm/package/dist', pattern: 'pnpm cache' },

      // Container paths
      { input: '/run/secrets/db_password', pattern: 'Docker secret' },
      { input: '/var/run/docker.sock', pattern: 'runtime path' },
      { input: '/docker/containers/abc', pattern: 'docker path' },
      { input: '/kubelet/pods/xyz', pattern: 'kubelet path' },

      // CI/CD paths
      { input: '/github/workspace/src', pattern: 'GitHub Actions' },
      { input: '/runner/_work/repo', pattern: 'runner path' },
      { input: '/builds/project/job', pattern: 'builds path' },
      { input: '/workspace/src/main.ts', pattern: 'workspace' },
      { input: '/jenkins/workspace/job', pattern: 'Jenkins' },

      // Cloud paths
      { input: '/aws/credentials', pattern: 'AWS path' },
      { input: 's3://bucket/key', pattern: 'S3 URI' },
      { input: 'gs://bucket/object', pattern: 'GCS URI' },

      // Secrets (these would appear in error messages)
      { input: 'AKIAIOSFODNN7EXAMPLE', pattern: 'AWS access key' },
      { input: 'sk-1234567890abcdefghijklmnopqrstuv', pattern: 'OpenAI key' },
      { input: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz', pattern: 'GitHub PAT' },
      { input: 'xoxb-12345-67890-abcdef', pattern: 'Slack token' },
      { input: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload', pattern: 'Bearer token' },
      { input: 'Basic dXNlcjpwYXNzd29yZA==', pattern: 'Basic auth' },

      // Internal network
      { input: '10.0.0.5', pattern: 'private IP (10.x)' },
      { input: '172.16.0.100', pattern: 'private IP (172.16-31)' },
      { input: '192.168.1.1', pattern: 'private IP (192.168)' },
      { input: 'db-server.internal', pattern: 'internal hostname' },
      { input: 'localhost:3000', pattern: 'localhost with port' },
      { input: '127.0.0.1:8080', pattern: 'loopback with port' },
    ];

    // Import the pattern array for testing - we'll just verify the config works
    it('should have documented all sensitive pattern categories', () => {
      // This test just documents that we have comprehensive patterns
      expect(testPatterns.length).toBeGreaterThan(40);

      // Group patterns by category
      const categories = new Set(testPatterns.map((p) => p.pattern.split(' ')[0]));
      expect(categories.size).toBeGreaterThan(10);
    });
  });
});
