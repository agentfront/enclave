/**
 * Rule-Based Scorer Unit Tests
 */

import { RuleBasedScorer } from '../scorers/rule-based.scorer';
import { FeatureExtractor } from '../feature-extractor';

describe('RuleBasedScorer', () => {
  let scorer: RuleBasedScorer;
  let extractor: FeatureExtractor;

  beforeEach(() => {
    scorer = new RuleBasedScorer();
    extractor = new FeatureExtractor();
  });

  describe('constructor', () => {
    it('should be ready immediately', () => {
      expect(scorer.isReady()).toBe(true);
    });

    it('should have correct type and name', () => {
      expect(scorer.type).toBe('rule-based');
      expect(scorer.name).toBe('RuleBasedScorer');
    });
  });

  describe('score()', () => {
    describe('SENSITIVE_FIELD rule', () => {
      it('should score high for password fields', async () => {
        const code = `
          const user = await callTool('users:get', {
            fields: ['password', 'email']
          });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.totalScore).toBeGreaterThan(30);
        expect(result.signals.some((s) => s.id === 'SENSITIVE_FIELD')).toBe(true);
      });

      it('should score for token/secret fields', async () => {
        const code = `
          const config = await callTool('config:get', {
            keys: ['apiToken', 'secretKey']
          });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'SENSITIVE_FIELD')).toBe(true);
      });

      it('should not score for non-sensitive fields', async () => {
        const code = `
          const users = await callTool('users:list', {
            fields: ['name', 'createdAt']
          });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'SENSITIVE_FIELD')).toBe(false);
      });
    });

    describe('EXCESSIVE_LIMIT rule', () => {
      it('should score for limits > 10000', async () => {
        const code = `
          const users = await callTool('users:list', { limit: 50000 });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXCESSIVE_LIMIT')).toBe(true);
      });

      it('should not score for reasonable limits', async () => {
        const code = `
          const users = await callTool('users:list', { limit: 100 });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXCESSIVE_LIMIT')).toBe(false);
      });
    });

    describe('WILDCARD_QUERY rule', () => {
      it('should score for wildcard (*) queries', async () => {
        const code = `
          const result = await callTool('data:search', { query: '*' });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'WILDCARD_QUERY')).toBe(true);
      });

      it('should not score for specific queries', async () => {
        const code = `
          const result = await callTool('data:search', { query: 'specific term' });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'WILDCARD_QUERY')).toBe(false);
      });
    });

    describe('LOOP_TOOL_CALL rule', () => {
      it('should score for tool calls inside loops', async () => {
        const code = `
          for (const user of users) {
            await callTool('emails:send', { to: user.email });
          }
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'LOOP_TOOL_CALL')).toBe(true);
      });

      it('should score higher for multiple tools in loops', async () => {
        const code = `
          for (const item of items) {
            await callTool('process:start', { id: item.id });
            await callTool('notify:send', { id: item.id });
          }
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        const signal = result.signals.find((s) => s.id === 'LOOP_TOOL_CALL');
        expect(signal).toBeDefined();
        expect(signal!.score).toBeGreaterThan(25); // More than single tool
      });

      it('should not score for tools outside loops', async () => {
        const code = `
          const result = await callTool('data:get', {});
          return result;
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'LOOP_TOOL_CALL')).toBe(false);
      });
    });

    describe('EXFIL_PATTERN rule', () => {
      it('should score for list→send pattern', async () => {
        const code = `
          const users = await callTool('users:list', { limit: 1000 });
          await callTool('webhooks:send', { data: users });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXFIL_PATTERN')).toBe(true);
      });

      it('should score for query→export pattern', async () => {
        const code = `
          const data = await callTool('database:query', { sql: 'SELECT *' });
          await callTool('files:export', { content: data });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXFIL_PATTERN')).toBe(true);
      });

      it('should not score for safe patterns', async () => {
        const code = `
          const user = await callTool('users:get', { id: 123 });
          await callTool('users:update', { id: 123, data: user });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXFIL_PATTERN')).toBe(false);
      });
    });

    describe('EXTREME_VALUE rule', () => {
      it('should score for values > 1,000,000', async () => {
        const code = `
          const result = await callTool('data:process', { count: 5000000 });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXTREME_VALUE')).toBe(true);
      });

      it('should not score for normal values', async () => {
        const code = `
          const result = await callTool('data:process', { count: 100 });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'EXTREME_VALUE')).toBe(false);
      });
    });

    describe('DYNAMIC_TOOL rule', () => {
      it('should score for dynamic tool names', async () => {
        const code = `
          const toolName = getToolName();
          await callTool(toolName, {});
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'DYNAMIC_TOOL')).toBe(true);
      });

      it('should not score for static tool names', async () => {
        const code = `
          await callTool('users:list', {});
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'DYNAMIC_TOOL')).toBe(false);
      });
    });

    describe('BULK_OPERATION rule', () => {
      it('should score for bulk operation names', async () => {
        const code = `
          await callTool('users:bulkDelete', { ids: [1, 2, 3] });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'BULK_OPERATION')).toBe(true);
      });

      it('should score for batch operation names', async () => {
        const code = `
          await callTool('data:batchProcess', { items: [] });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'BULK_OPERATION')).toBe(true);
      });

      it('should not score for normal operations', async () => {
        const code = `
          await callTool('users:delete', { id: 123 });
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.signals.some((s) => s.id === 'BULK_OPERATION')).toBe(false);
      });
    });

    describe('risk level calculation', () => {
      it('should return none for safe code', async () => {
        const code = `
          const user = await callTool('users:get', { id: 123 });
          return user.name;
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.riskLevel).toBe('none');
        expect(result.totalScore).toBeLessThan(20);
      });

      it('should return critical for high-risk code', async () => {
        const code = `
          for (const user of await callTool('users:list', { limit: 100000 })) {
            const creds = await callTool('auth:getCredentials', { userId: user.id, fields: ['password', 'apiKey'] });
            await callTool('webhooks:send', { data: creds });
          }
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.riskLevel).toBe('critical');
        expect(result.totalScore).toBeGreaterThanOrEqual(80);
      });
    });

    describe('score capping', () => {
      it('should cap total score at 100', async () => {
        // Code that would trigger many rules
        const code = `
          for (const user of items) {
            const secrets = await callTool('auth:bulkGetSecrets', {
              limit: 5000000,
              query: '*',
              fields: ['password', 'apiToken', 'secretKey']
            });
            await callTool('webhooks:send', { data: secrets });
          }
        `;
        const features = extractor.extract(code);
        const result = await scorer.score(features);

        expect(result.totalScore).toBeLessThanOrEqual(100);
      });
    });
  });

  describe('customRules', () => {
    const exfiltration = `
      const users = await callTool('users:list', { limit: 50 });
      await callTool('webhooks:post', { to: 'a', body: users });
    `;
    const bulkInLoop = `
      for (const page of [1, 2, 3]) {
        await callTool('crm:bulkExport', { page });
      }
    `;
    const signalsOf = async (code: string, customRules?: Record<string, number>) => {
      const result = await new RuleBasedScorer(customRules).score(extractor.extract(code));
      return Object.fromEntries(result.signals.map((signal) => [signal.id, signal.score]));
    };

    it('should use the built-in scores without custom rules', async () => {
      expect(await signalsOf(exfiltration)).toEqual({ EXFIL_PATTERN: 50 });
      expect(await signalsOf(bulkInLoop)).toEqual({ LOOP_TOOL_CALL: 25, BULK_OPERATION: 15 });
    });

    it('should replace the base score of a rule', async () => {
      expect(await signalsOf(exfiltration, { EXFIL_PATTERN: 100 })).toEqual({ EXFIL_PATTERN: 100 });
      expect(await signalsOf(bulkInLoop, { LOOP_TOOL_CALL: 40 })).toEqual({ LOOP_TOOL_CALL: 40, BULK_OPERATION: 15 });
    });

    it('should let a custom score exceed the built-in cap of its rule', async () => {
      // One bulk tool: the built-in cap of the rule is 30
      expect(await signalsOf(bulkInLoop, { BULK_OPERATION: 45 })).toEqual({ LOOP_TOOL_CALL: 25, BULK_OPERATION: 45 });
    });

    it('should turn a rule off at 0', async () => {
      expect(await signalsOf(exfiltration, { EXFIL_PATTERN: 0 })).toEqual({});
      expect(await signalsOf(bulkInLoop, { BULK_OPERATION: 0 })).toEqual({ LOOP_TOOL_CALL: 25 });
    });

    it('should clamp a custom score to 0-100', async () => {
      expect(await signalsOf(exfiltration, { EXFIL_PATTERN: 500 })).toEqual({ EXFIL_PATTERN: 100 });
      expect(await signalsOf(exfiltration, { EXFIL_PATTERN: -5 })).toEqual({});
    });

    it('should ignore ids that are not rules and values that are not numbers', async () => {
      const custom = { NOT_A_RULE: 100, EXFIL_PATTERN: 'high', toString: 100 } as unknown as Record<string, number>;

      expect(await signalsOf(exfiltration, custom)).toEqual({ EXFIL_PATTERN: 50 });
    });

    it('should change the total score', async () => {
      const builtIn = await new RuleBasedScorer().score(extractor.extract(exfiltration));
      const custom = await new RuleBasedScorer({ EXFIL_PATTERN: 80 }).score(extractor.extract(exfiltration));

      expect([builtIn.totalScore, custom.totalScore]).toEqual([50, 80]);
    });
  });

  describe('scoring metadata', () => {
    it('should include scoring time', async () => {
      const code = `const x = 1;`;
      const features = extractor.extract(code);
      const result = await scorer.score(features);

      expect(result.scoringTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include scorer type', async () => {
      const code = `const x = 1;`;
      const features = extractor.extract(code);
      const result = await scorer.score(features);

      expect(result.scorerType).toBe('rule-based');
    });
  });
});
