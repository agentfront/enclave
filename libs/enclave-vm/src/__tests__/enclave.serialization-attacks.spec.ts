import { Enclave } from '../enclave';

describe('Enclave Serialization Edge Cases', () => {
  it('should safely handle __proto__ in object literals without polluting host', async () => {
    // Note: __proto__ as an object key is NOT blocked by validation because it's
    // a property key, not an identifier access. However, the VM isolation ensures
    // prototype pollution doesn't leak to the host environment.
    const enclave = new Enclave();

    const code = `
      const payload = { __proto__: { polluted: true } };
      return payload;
    `;

    const result = await enclave.run(code);

    // The code should execute successfully - __proto__ in object literals is valid JS
    expect(result.success).toBe(true);

    // Verify host environment is NOT polluted
    const testObj: Record<string, unknown> = {};
    expect(testObj['polluted']).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();

    enclave.dispose();
  });

  it('should safely round-trip circular object graphs', async () => {
    const enclave = new Enclave({ validate: false });

    const code = `
      const node = {};
      node.self = node;
      return node;
    `;

    const result = await enclave.run(code);

    expect(result.success).toBe(true);
    const value = result.value as { self: unknown };
    // Circular references are sanitized to "[Circular]" string for security
    expect(value.self).toBe('[Circular]');

    enclave.dispose();
  });

  it('should handle extremely deep nested objects without crashing', async () => {
    // Set high iteration limit to allow the loop to complete - we're testing serialization, not iteration limits
    const enclave = new Enclave({ validate: false, maxIterations: 2000 });

    const code = `
      let depth = 0;
      let node = { depth: 0 };
      while (depth < 1500) {
        node = { depth: depth + 1, next: node };
        depth++;
      }
      return node;
    `;

    const result = await enclave.run(code);

    // The sanitizer prevents deep nesting (>20 levels) to avoid stack overflow
    // This is a security feature - the system fails safely rather than crashing
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/maximum depth|deeply nested/i);

    enclave.dispose();
  });

  it('should allow strings containing unpaired surrogate characters', async () => {
    const enclave = new Enclave();

    const code = `
      const invalid = '\\uD800';
      return invalid;
    `;

    const result = await enclave.run(code);

    expect(result.success).toBe(true);
    expect(result.value).toBe('\uD800');

    enclave.dispose();
  });
});
