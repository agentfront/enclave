import { z } from 'zod';
import { ToolRegistry, createToolRegistry } from './tool-registry';
import type { ToolDefinition, ToolContext } from './tool-registry';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createToolRegistry();
  });

  describe('registration', () => {
    it('should register a tool', () => {
      const tool: ToolDefinition<{ name: string }, string> = {
        name: 'greet',
        handler: async ({ name }) => `Hello, ${name}!`,
      };

      registry.register(tool);

      expect(registry.has('greet')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('should throw when registering duplicate tool name', () => {
      const tool: ToolDefinition<void, string> = {
        name: 'greet',
        handler: async () => 'Hello!',
      };

      registry.register(tool);

      expect(() => registry.register(tool)).toThrow('already registered');
    });

    it('should unregister a tool', () => {
      registry.register({
        name: 'test',
        handler: async () => 'test',
      });

      const removed = registry.unregister('test');

      expect(removed).toBe(true);
      expect(registry.has('test')).toBe(false);
    });

    it('should return false when unregistering non-existent tool', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });

    it('should list registered tools', () => {
      registry.register({ name: 'tool1', handler: async () => 'a' });
      registry.register({ name: 'tool2', handler: async () => 'b' });
      registry.register({ name: 'tool3', handler: async () => 'c' });

      const tools = registry.list();

      expect(tools).toContain('tool1');
      expect(tools).toContain('tool2');
      expect(tools).toContain('tool3');
      expect(tools.length).toBe(3);
    });

    it('should clear all tools', () => {
      registry.register({ name: 'tool1', handler: async () => 'a' });
      registry.register({ name: 'tool2', handler: async () => 'b' });

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  describe('validation', () => {
    it('should validate arguments with Zod schema', () => {
      registry.register({
        name: 'greet',
        argsSchema: z.object({
          name: z.string(),
          age: z.number().optional(),
        }),
        handler: async () => 'Hello!',
      });

      const valid = registry.validate('greet', { name: 'John' });
      expect(valid.success).toBe(true);
      expect(valid.validatedArgs).toEqual({ name: 'John' });

      const invalid = registry.validate('greet', { name: 123 });
      expect(invalid.success).toBe(false);
      expect(invalid.error).toContain('Invalid arguments');
    });

    it('should reject unknown tools', () => {
      const result = registry.validate('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('should use default schema when none provided', () => {
      registry.register({
        name: 'noSchema',
        handler: async () => 'result',
      });

      const result = registry.validate('noSchema', { any: 'data' });
      expect(result.success).toBe(true);
    });
  });

  describe('secrets', () => {
    it('should set and retrieve secrets', () => {
      registry.setSecret('API_KEY', 'secret123');

      expect(registry.hasSecret('API_KEY')).toBe(true);
    });

    it('should remove secrets', () => {
      registry.setSecret('API_KEY', 'secret123');
      registry.removeSecret('API_KEY');

      expect(registry.hasSecret('API_KEY')).toBe(false);
    });

    it('should clear all secrets', () => {
      registry.setSecret('KEY1', 'value1');
      registry.setSecret('KEY2', 'value2');

      registry.clearSecrets();

      expect(registry.hasSecret('KEY1')).toBe(false);
      expect(registry.hasSecret('KEY2')).toBe(false);
    });

    it('should report required secrets for a tool', () => {
      registry.register({
        name: 'secure',
        secrets: ['API_KEY', 'DATABASE_URL'],
        handler: async () => 'result',
      });

      const required = registry.getRequiredSecrets('secure');
      expect(required).toContain('API_KEY');
      expect(required).toContain('DATABASE_URL');
    });
  });

  describe('execution', () => {
    const createContext = (overrides?: Partial<Omit<ToolContext, 'secrets'>>): Omit<ToolContext, 'secrets'> => ({
      sessionId: 's_test123',
      callId: 'c_call123',
      signal: new AbortController().signal,
      ...overrides,
    });

    it('should execute a tool successfully', async () => {
      registry.register({
        name: 'greet',
        argsSchema: z.object({ name: z.string() }),
        handler: async ({ name }: { name: string }) => `Hello, ${name}!`,
      });

      const result = await registry.execute('greet', { name: 'World' }, createContext());

      expect(result.success).toBe(true);
      expect(result.value).toBe('Hello, World!');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should fail for unknown tool', async () => {
      const result = await registry.execute('unknown', {}, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_TOOL');
    });

    it('should fail for invalid arguments', async () => {
      registry.register({
        name: 'typed',
        argsSchema: z.object({ value: z.number() }),
        handler: async () => 'result',
      });

      const result = await registry.execute('typed', { value: 'not a number' }, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should fail when required secret is missing', async () => {
      registry.register({
        name: 'secure',
        secrets: ['API_KEY'],
        handler: async () => 'result',
      });

      const result = await registry.execute('secure', {}, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECRET_ERROR');
    });

    it('should provide resolved secrets to handler', async () => {
      let receivedSecrets: Record<string, string> = {};

      registry.register({
        name: 'secure',
        secrets: ['API_KEY'],
        handler: async (args, context) => {
          receivedSecrets = context.secrets;
          return 'done';
        },
      });

      registry.setSecret('API_KEY', 'secret123');

      await registry.execute('secure', {}, createContext());

      expect(receivedSecrets['API_KEY']).toBe('secret123');
    });

    it('should capture handler errors', async () => {
      registry.register({
        name: 'failing',
        handler: async () => {
          throw new Error('Handler failed');
        },
      });

      const result = await registry.execute('failing', {}, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toBe('Handler failed');
    });

    it('should preserve custom error codes', async () => {
      registry.register({
        name: 'customError',
        handler: async () => {
          const error = new Error('Custom error');
          (error as Error & { code: string }).code = 'CUSTOM_CODE';
          throw error;
        },
      });

      const result = await registry.execute('customError', {}, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CUSTOM_CODE');
    });

    it('should pass context to handler', async () => {
      let receivedContext: ToolContext | null = null;

      registry.register({
        name: 'contextAware',
        handler: async (_args, context) => {
          receivedContext = context;
          return 'done';
        },
      });

      const context = createContext({
        sessionId: 's_mySession',
        callId: 'c_myCall',
      });

      await registry.execute('contextAware', {}, context);

      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.sessionId).toBe('s_mySession');
      expect(receivedContext!.callId).toBe('c_myCall');
    });
  });

  describe('tool configs', () => {
    it('should return configs for tools that have them', () => {
      registry.register({
        name: 'configured',
        config: { timeout: 5000, retryable: true },
        handler: async () => 'result',
      });

      registry.register({
        name: 'unconfigured',
        handler: async () => 'result',
      });

      const configs = registry.getConfigs();

      expect(configs['configured']).toEqual({ timeout: 5000, retryable: true });
      expect(configs['unconfigured']).toBeUndefined();
    });
  });
});
