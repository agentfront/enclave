/**
 * Tool namespaces in the scoring gate
 *
 * With `toolNamespaces: { mail: ['send'] }`, `mail.send(args)` is the tool call
 * `callTool('mail.send', args)`. The feature extractor reads it as one when it is given the
 * namespaces.
 */

import { FeatureExtractor } from '../feature-extractor';
import { ScoringGate } from '../scoring-gate';
import { normalizeScoringConfig } from '../types';

describe('Tool namespace calls in scoring', () => {
  const toolNamespaces = [
    {
      name: 'users',
      methods: [
        { name: 'list', toolName: 'users:list' },
        { name: 'get', toolName: 'users.get' },
      ],
    },
    { name: 'mail', methods: [{ name: 'send', toolName: 'mail.send' }] },
  ];

  describe('FeatureExtractor', () => {
    const extractor = new FeatureExtractor({ toolNamespaces });

    it('should extract a namespace call as a call of its tool', () => {
      const features = extractor.extract(`const page = await users.list({ limit: 25, filter: 'active' });`);

      expect(features.toolCalls).toHaveLength(1);
      expect(features.toolCalls[0]).toMatchObject({
        toolName: 'users:list',
        isStaticName: true,
        argumentKeys: ['limit', 'filter'],
        stringLiterals: ['active'],
        numericLiterals: [25],
        insideLoop: false,
      });
    });

    it('should take the arguments from the first argument of the method', () => {
      const features = extractor.extract(`await mail.send({ to: 'a@example.com' }, { throwOnError: false });`);

      expect(features.toolCalls[0].argumentKeys).toEqual(['to']);
    });

    it('should keep the order of tool calls across both spellings', () => {
      const features = extractor.extract(`
        const a = await users.list({});
        const b = await callTool('audit:log', {});
        await mail.send({ to: 'x' });
      `);

      expect(features.patterns.toolSequence).toEqual(['users:list', 'audit:log', 'mail.send']);
    });

    it('should see a namespace call inside a loop and a loop over its result', () => {
      const features = extractor.extract(`
        const all = await users.list({});
        for (const user of all) {
          await mail.send({ to: user });
        }
      `);

      expect(features.patterns.toolsInLoops).toEqual(['mail.send']);
      expect(features.patterns.iteratesOverToolResults).toBe(true);
    });

    it('should read a method named with a string like a method named with an identifier', () => {
      const features = extractor.extract(`await mail['send']({ to: 'x' }); await mail?.send({ to: 'y' });`);

      expect(features.toolCalls.map((tc) => tc.toolName)).toEqual(['mail.send', 'mail.send']);
    });

    it('should count a method chosen at run time as a dynamic tool call', () => {
      const features = extractor.extract(`await mail[method]({ to: 'x' });`);

      expect(features.toolCalls).toHaveLength(1);
      expect(features.toolCalls[0].isStaticName).toBe(false);
    });

    it('should count a method taken as a value as a call of its tool', () => {
      const features = extractor.extract(`const send = mail.send; await send({ to: 'x' });`);

      expect(features.toolCalls.map((tc) => tc.toolName)).toEqual(['mail.send']);
      expect(features.toolCalls[0].argumentKeys).toEqual([]);
    });

    it('should count a namespace taken as a value as a dynamic tool call', () => {
      const features = extractor.extract(`const m = mail; await m.send({ to: 'x' });`);

      expect(features.toolCalls).toHaveLength(1);
      expect(features.toolCalls[0].isStaticName).toBe(false);
    });

    it('should ignore members that are not methods of the namespace and other objects', () => {
      const features = extractor.extract(`
        await mail.unknown({});
        await other.send({});
        const config = { mail: true };
        console.log(config.mail);
      `);

      expect(features.toolCalls).toHaveLength(0);
    });

    it('should extract nothing from a namespace call without the namespaces', () => {
      const features = new FeatureExtractor().extract(`await mail.send({ to: 'x' });`);

      expect(features.toolCalls).toHaveLength(0);
    });
  });

  describe('ScoringGate', () => {
    it('should accept the namespaces as a host configures them', async () => {
      const gate = new ScoringGate({
        scorer: 'rule-based',
        blockThreshold: 50,
        toolNamespaces: { users: { list: 'users:list' }, mail: ['send'] },
      });

      const result = await gate.evaluate(`
        const all = await users.list({ limit: 50 });
        await mail.send({ to: 'a', body: all });
      `);

      expect(result.allowed).toBe(false);
      expect(result.signals?.map((signal) => signal.id)).toEqual(['EXFIL_PATTERN']);
      gate.dispose();
    });

    it('should accept the namespaces in normalized form', () => {
      expect(normalizeScoringConfig({ scorer: 'rule-based', toolNamespaces }).toolNamespaces).toBe(toolNamespaces);
      expect(normalizeScoringConfig({ scorer: 'rule-based' }).toolNamespaces).toEqual([]);
      expect(
        normalizeScoringConfig({ scorer: 'rule-based', toolNamespaces: { mail: ['send'] } }).toolNamespaces,
      ).toEqual([{ name: 'mail', methods: [{ name: 'send', toolName: 'mail.send' }] }]);
    });

    it('should refuse namespaces the enclave would refuse', () => {
      expect(() => new ScoringGate({ scorer: 'rule-based', toolNamespaces: { constructor: ['x'] } })).toThrow(
        /Invalid toolNamespaces/,
      );
    });
  });
});
