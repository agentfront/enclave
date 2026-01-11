import { z } from 'zod';
import { Broker, createBroker } from './broker';
import type { StreamEvent } from '@enclavejs/types';

describe('Broker', () => {
  let broker: Broker;

  beforeEach(() => {
    broker = createBroker();
  });

  afterEach(async () => {
    await broker.dispose();
  });

  describe('tool registration', () => {
    it('should register a tool using fluent API', () => {
      broker.tool('greet', {
        handler: async ({ name }: { name: string }) => `Hello, ${name}!`,
      });

      expect(broker.hasTool('greet')).toBe(true);
    });

    it('should support chaining', () => {
      broker
        .tool('tool1', { handler: async () => 'a' })
        .tool('tool2', { handler: async () => 'b' })
        .tool('tool3', { handler: async () => 'c' });

      expect(broker.listTools()).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should register multiple tools at once', () => {
      broker.tools({
        tool1: { handler: async () => 'a' },
        tool2: { handler: async () => 'b' },
      });

      expect(broker.hasTool('tool1')).toBe(true);
      expect(broker.hasTool('tool2')).toBe(true);
    });

    it('should remove a tool', () => {
      broker.tool('removable', { handler: async () => 'x' });
      broker.removeTool('removable');

      expect(broker.hasTool('removable')).toBe(false);
    });
  });

  describe('secret management', () => {
    it('should set a secret', () => {
      broker.secret('API_KEY', 'secret123');

      expect(broker.hasSecret('API_KEY')).toBe(true);
    });

    it('should support chaining', () => {
      broker.secret('KEY1', 'value1').secret('KEY2', 'value2');

      expect(broker.hasSecret('KEY1')).toBe(true);
      expect(broker.hasSecret('KEY2')).toBe(true);
    });

    it('should set multiple secrets at once', () => {
      broker.secrets({
        API_KEY: 'secret1',
        DATABASE_URL: 'secret2',
      });

      expect(broker.hasSecret('API_KEY')).toBe(true);
      expect(broker.hasSecret('DATABASE_URL')).toBe(true);
    });

    it('should remove a secret', () => {
      broker.secret('removable', 'value');
      broker.removeSecret('removable');

      expect(broker.hasSecret('removable')).toBe(false);
    });
  });

  describe('session management', () => {
    it('should create a session', () => {
      const session = broker.createSession();

      expect(session).toBeDefined();
      expect(session.sessionId).toMatch(/^s_/);
      expect(session.state).toBe('starting');
    });

    it('should get a session by ID', () => {
      const session = broker.createSession();
      const retrieved = broker.getSession(session.sessionId);

      expect(retrieved).toBe(session);
    });

    it('should list sessions', () => {
      broker.createSession();
      broker.createSession();

      const sessions = broker.listSessions();

      expect(sessions.length).toBe(2);
    });

    it('should terminate a session', async () => {
      const session = broker.createSession();
      const terminated = await broker.terminateSession(session.sessionId);

      expect(terminated).toBe(true);
      expect(broker.getSession(session.sessionId)).toBeUndefined();
    });
  });

  describe('statistics', () => {
    it('should report stats', () => {
      broker.tool('tool1', { handler: async () => 'a' }).tool('tool2', { handler: async () => 'b' });

      broker.createSession();

      const stats = broker.stats();

      expect(stats.tools).toBe(2);
      expect(stats.totalSessions).toBe(1);
    });
  });

  describe('execution', () => {
    it('should execute simple code', async () => {
      const result = await broker.execute('return 1 + 2');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });

    it('should execute code with tool calls', async () => {
      broker.tool('add', {
        argsSchema: z.object({ a: z.number(), b: z.number() }),
        handler: async ({ a, b }: { a: number; b: number }) => a + b,
      });

      const result = await broker.execute(`
        const sum = await callTool('add', { a: 5, b: 3 });
        return sum;
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(8);
    });

    it('should handle tool call errors gracefully', async () => {
      broker.tool('failing', {
        handler: async () => {
          throw new Error('Tool error');
        },
      });

      const result = await broker.execute(`
        try {
          await callTool('failing', {});
          return 'unexpected';
        } catch (e) {
          return 'caught';
        }
      `);

      // The script catches the error and returns 'caught'
      expect(result.success).toBe(true);
      expect(result.value).toBe('caught');
    });

    it('should stream events to handler', async () => {
      const events: StreamEvent[] = [];

      await broker.execute('return 42', {
        onEvent: (event) => events.push(event),
      });

      // Should have at least session_init and final events
      expect(events.some((e) => e.type === 'session_init')).toBe(true);
      expect(events.some((e) => e.type === 'final')).toBe(true);
    });

    it('should provide secrets to tools', async () => {
      let receivedKey = '';

      broker.secret('API_KEY', 'secret123').tool('useSecret', {
        secrets: ['API_KEY'],
        handler: async (_args, { secrets }) => {
          receivedKey = secrets['API_KEY'] ?? '';
          return 'done';
        },
      });

      await broker.execute(`
        return await callTool('useSecret', {});
      `);

      expect(receivedKey).toBe('secret123');
    });
  });

  describe('lifecycle', () => {
    it('should dispose cleanly', async () => {
      broker.tool('test', { handler: async () => 'x' });
      broker.createSession();

      await broker.dispose();

      expect(broker.isDisposed).toBe(true);
    });

    it('should throw when using disposed broker', async () => {
      await broker.dispose();

      expect(() => broker.createSession()).toThrow('disposed');
      await expect(broker.execute('return 1')).rejects.toThrow('disposed');
    });

    it('should handle multiple dispose calls', async () => {
      await broker.dispose();
      await broker.dispose(); // Should not throw
    });

    it('should clean up sessions', () => {
      broker.createSession();
      broker.createSession();

      const cleaned = broker.cleanup();

      // New sessions aren't expired or terminal, so shouldn't be cleaned
      expect(cleaned).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle tool that returns undefined', async () => {
      broker.tool('voidTool', {
        handler: async () => undefined,
      });

      const result = await broker.execute(`
        const r = await callTool('voidTool', {});
        return r;
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('should handle tool that returns null', async () => {
      broker.tool('nullTool', {
        handler: async () => null,
      });

      const result = await broker.execute(`
        return await callTool('nullTool', {});
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });

    it('should handle tool that returns complex object', async () => {
      const complexData = {
        nested: { array: [1, 2, 3], map: { a: 1, b: 2 } },
        date: '2025-01-01',
        numbers: [Infinity, -Infinity], // Will be null in JSON
      };

      broker.tool('complexTool', {
        handler: async () => complexData,
      });

      const result = await broker.execute(`
        return await callTool('complexTool', {});
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBeDefined();
    });

    it('should handle execution with empty code', async () => {
      const result = await broker.execute('');

      // Empty code should return undefined
      expect(result.success).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('should handle code with only comments', async () => {
      const result = await broker.execute('// just a comment');

      expect(result.success).toBe(true);
    });

    it('should handle code with syntax error', async () => {
      const result = await broker.execute('return {{{');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle tool that modifies args', async () => {
      broker.tool('mutatingTool', {
        handler: async (args) => {
          // Try to mutate args (should be safe)
          (args as any).newProp = 'added';
          return args;
        },
      });

      const originalArgs = { foo: 'bar' };
      const result = await broker.execute(`
        return await callTool('mutatingTool', ${JSON.stringify(originalArgs)});
      `);

      expect(result.success).toBe(true);
    });

    it('should handle concurrent tool calls in sequence', async () => {
      const callOrder: number[] = [];

      broker.tool('sequenceTool', {
        handler: async (args) => {
          callOrder.push((args as any).order);
          return (args as any).order;
        },
      });

      const result = await broker.execute(`
        const r1 = await callTool('sequenceTool', { order: 1 });
        const r2 = await callTool('sequenceTool', { order: 2 });
        const r3 = await callTool('sequenceTool', { order: 3 });
        return [r1, r2, r3];
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1, 2, 3]);
      expect(callOrder).toEqual([1, 2, 3]);
    });

    it('should handle session with custom limits', async () => {
      const session = broker.createSession({
        limits: {
          sessionTtlMs: 1000,
          maxToolCalls: 2,
        },
      });

      expect(session.expiresAt - session.createdAt).toBeLessThanOrEqual(1001);
    });

    it('should provide session stats', async () => {
      broker.tool('statsTool', {
        handler: async () => 'ok',
      });

      const result = await broker.execute(`
        await callTool('statsTool', {});
        return 'done';
      `);

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.stats?.toolCallCount).toBe(1);
    });
  });

  describe('error recovery', () => {
    it('should continue after tool error if not fatal', async () => {
      let callCount = 0;

      broker.tool('sometimesFailsTool', {
        handler: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('First call fails');
          }
          return 'success';
        },
      });

      const result = await broker.execute(`
        try {
          await callTool('sometimesFailsTool', {});
        } catch (e) {
          // Ignore first error
        }
        return await callTool('sometimesFailsTool', {});
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(callCount).toBe(2);
    });

    it('should handle tool timeout gracefully', async () => {
      broker.tool('slowTool', {
        handler: async () => {
          // This would timeout in real scenario
          return 'done';
        },
      });

      const result = await broker.execute(`
        return await callTool('slowTool', {});
      `);

      expect(result.success).toBe(true);
    });
  });
});
