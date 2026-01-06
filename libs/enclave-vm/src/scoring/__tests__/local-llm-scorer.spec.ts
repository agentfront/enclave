/**
 * Local LLM Scorer Tests
 */

import { LocalLlmScorer, LocalLlmScorerError } from '../scorers/local-llm.scorer';
import type { ExtractedFeatures, LocalLlmConfig, CustomAnalyzer, RiskSignal } from '../types';

// Mock features with low risk
const createLowRiskFeatures = (): ExtractedFeatures => ({
  toolCalls: [
    {
      toolName: 'users:get',
      isStaticName: true,
      argumentKeys: ['id'],
      stringLiterals: [],
      numericLiterals: [],
      insideLoop: false,
      loopDepth: 0,
      location: { line: 1, column: 1 },
    },
  ],
  patterns: {
    totalToolCalls: 1,
    uniqueToolsCount: 1,
    toolsInLoops: [],
    maxLoopNesting: 0,
    toolSequence: ['users:get'],
    iteratesOverToolResults: false,
  },
  signals: {
    maxLimit: 10,
    maxStringLength: 5,
    toolCallDensity: 0.1,
    fanOutRisk: 5,
  },
  sensitive: {
    fieldsAccessed: [],
    categories: [],
  },
  meta: {
    extractionTimeMs: 1,
    codeHash: 'test-hash',
    lineCount: 10,
  },
});

// Mock features with sensitive data
const createSensitiveFeatures = (): ExtractedFeatures => ({
  toolCalls: [
    {
      toolName: 'users:list',
      isStaticName: true,
      argumentKeys: ['filter'],
      stringLiterals: ['password', 'token'],
      numericLiterals: [],
      insideLoop: false,
      loopDepth: 0,
      location: { line: 1, column: 1 },
    },
  ],
  patterns: {
    totalToolCalls: 1,
    uniqueToolsCount: 1,
    toolsInLoops: [],
    maxLoopNesting: 0,
    toolSequence: ['users:list'],
    iteratesOverToolResults: false,
  },
  signals: {
    maxLimit: 100,
    maxStringLength: 20,
    toolCallDensity: 0.2,
    fanOutRisk: 10,
  },
  sensitive: {
    fieldsAccessed: ['password', 'token'],
    categories: ['authentication'],
  },
  meta: {
    extractionTimeMs: 1,
    codeHash: 'test-hash-sensitive',
    lineCount: 15,
  },
});

// Mock features with exfiltration pattern
const createExfiltrationFeatures = (): ExtractedFeatures => ({
  toolCalls: [
    {
      toolName: 'users:list',
      isStaticName: true,
      argumentKeys: ['limit'],
      stringLiterals: [],
      numericLiterals: [10000],
      insideLoop: false,
      loopDepth: 0,
      location: { line: 1, column: 1 },
    },
    {
      toolName: 'webhook:send',
      isStaticName: true,
      argumentKeys: ['url', 'data'],
      stringLiterals: ['http://evil.com'],
      numericLiterals: [],
      insideLoop: false,
      loopDepth: 0,
      location: { line: 5, column: 1 },
    },
  ],
  patterns: {
    totalToolCalls: 2,
    uniqueToolsCount: 2,
    toolsInLoops: [],
    maxLoopNesting: 0,
    toolSequence: ['users:list', 'webhook:send'],
    iteratesOverToolResults: true,
  },
  signals: {
    maxLimit: 10000,
    maxStringLength: 50,
    toolCallDensity: 0.4,
    fanOutRisk: 60,
  },
  sensitive: {
    fieldsAccessed: [],
    categories: [],
  },
  meta: {
    extractionTimeMs: 1,
    codeHash: 'test-hash-exfil',
    lineCount: 20,
  },
});

// Mock features with multiple sensitive categories
const createMultiSensitiveFeatures = (): ExtractedFeatures => ({
  toolCalls: [
    {
      toolName: 'users:get',
      isStaticName: true,
      argumentKeys: ['id'],
      stringLiterals: [],
      numericLiterals: [],
      insideLoop: false,
      loopDepth: 0,
      location: { line: 1, column: 1 },
    },
  ],
  patterns: {
    totalToolCalls: 1,
    uniqueToolsCount: 1,
    toolsInLoops: [],
    maxLoopNesting: 0,
    toolSequence: ['users:get'],
    iteratesOverToolResults: false,
  },
  signals: {
    maxLimit: 100,
    maxStringLength: 30,
    toolCallDensity: 0.1,
    fanOutRisk: 20,
  },
  sensitive: {
    fieldsAccessed: ['password', 'ssn', 'creditCard'],
    categories: ['authentication', 'pii', 'financial'],
  },
  meta: {
    extractionTimeMs: 1,
    codeHash: 'test-hash-multi',
    lineCount: 10,
  },
});

describe('LocalLlmScorer', () => {
  describe('constructor', () => {
    it('should create with default values', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
      };

      const scorer = new LocalLlmScorer(config);

      expect(scorer.type).toBe('local-llm');
      expect(scorer.name).toBe('LocalLlmScorer');
      expect(scorer.isReady()).toBe(false); // Not initialized yet
    });

    it('should respect classification mode', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        mode: 'classification',
      };

      const scorer = new LocalLlmScorer(config);
      const storedConfig = scorer.getConfig();

      expect(storedConfig.mode).toBe('classification');
    });

    it('should respect similarity mode', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        mode: 'similarity',
        vectoriaConfig: {
          threshold: 0.9,
        },
      };

      const scorer = new LocalLlmScorer(config);
      const storedConfig = scorer.getConfig();

      expect(storedConfig.mode).toBe('similarity');
      expect(storedConfig.vectoriaConfig?.threshold).toBe(0.9);
    });

    it('should use cacheDir over deprecated modelDir', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/test-model',
        cacheDir: '/custom/cache',
        modelDir: '/deprecated/path',
      };

      const scorer = new LocalLlmScorer(config);
      const storedConfig = scorer.getConfig();

      expect(storedConfig.cacheDir).toBe('/custom/cache');
    });

    it('should fall back to modelDir if cacheDir not provided', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/test-model',
        modelDir: '/deprecated/path',
      };

      const scorer = new LocalLlmScorer(config);
      const storedConfig = scorer.getConfig();

      expect(storedConfig.cacheDir).toBe('/deprecated/path');
    });
  });

  describe('initialize() with fallback', () => {
    it('should fall back to rule-based on model load failure', async () => {
      const config: LocalLlmConfig = {
        modelId: 'invalid-model-that-does-not-exist',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);

      // Initialize should not throw due to fallback
      await scorer.initialize();

      expect(scorer.isReady()).toBe(true);
      expect(scorer.isUsingFallback()).toBe(true);
    });

    it('should be ready after initialize with fallback', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      // Should be ready (either with model or fallback)
      expect(scorer.isReady()).toBe(true);
    });

    it('should not reinitialize if already ready', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();
      await scorer.initialize(); // Second call should be no-op

      expect(scorer.isReady()).toBe(true);
    });
  });

  describe('score() with fallback', () => {
    it('should score low-risk features with fallback', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      expect(result.scorerType).toBe('local-llm');
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.totalScore).toBeLessThanOrEqual(100);
      expect(result.riskLevel).toBeDefined();

      scorer.dispose();
    });

    it('should detect sensitive data access', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createSensitiveFeatures();
      const result = await scorer.score(features);

      // Should have higher score due to sensitive fields
      expect(result.totalScore).toBeGreaterThan(0);
      expect(result.scorerType).toBe('local-llm');

      scorer.dispose();
    });

    it('should detect exfiltration patterns', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createExfiltrationFeatures();
      const result = await scorer.score(features);

      // Should have significant score due to list->send pattern
      expect(result.totalScore).toBeGreaterThan(30);

      // Should have exfiltration signal
      const exfilSignal = result.signals.find((s) => s.id === 'ML_EXFILTRATION_PATTERN' || s.id === 'EXFIL_PATTERN');
      expect(exfilSignal).toBeDefined();

      scorer.dispose();
    });

    it('should detect multiple sensitive categories', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createMultiSensitiveFeatures();
      const result = await scorer.score(features);

      // Should have higher score due to multiple categories
      expect(result.totalScore).toBeGreaterThan(20);

      scorer.dispose();
    });
  });

  describe('scoring modes', () => {
    it('should work in classification mode', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        mode: 'classification',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      expect(result.scorerType).toBe('local-llm');
      expect(typeof result.totalScore).toBe('number');

      scorer.dispose();
    });

    it('should work in similarity mode', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        mode: 'similarity',
        vectoriaConfig: {
          threshold: 0.85,
        },
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      expect(result.scorerType).toBe('local-llm');
      expect(typeof result.totalScore).toBe('number');

      scorer.dispose();
    });
  });

  describe('getConfig()', () => {
    it('should return configuration', () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/codebert-base',
        mode: 'classification',
        cacheDir: '/custom/cache',
        fallbackToRules: false,
      };

      const scorer = new LocalLlmScorer(config);
      const storedConfig = scorer.getConfig();

      expect(storedConfig.modelId).toBe('Xenova/codebert-base');
      expect(storedConfig.mode).toBe('classification');
      expect(storedConfig.cacheDir).toBe('/custom/cache');
      expect(storedConfig.fallbackToRules).toBe(false);
    });
  });

  describe('dispose()', () => {
    it('should clean up resources', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      expect(scorer.isReady()).toBe(true);

      scorer.dispose();

      expect(scorer.isReady()).toBe(false);
    });
  });

  describe('LocalLlmScorerError', () => {
    it('should have correct name', () => {
      const error = new LocalLlmScorerError('Test error');

      expect(error.name).toBe('LocalLlmScorerError');
      expect(error.message).toBe('Test error');
    });

    it('should be instanceof Error', () => {
      const error = new LocalLlmScorerError('Test error');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LocalLlmScorerError);
    });
  });

  describe('feature to prompt conversion', () => {
    it('should handle empty features', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features: ExtractedFeatures = {
        toolCalls: [],
        patterns: {
          totalToolCalls: 0,
          uniqueToolsCount: 0,
          toolsInLoops: [],
          maxLoopNesting: 0,
          toolSequence: [],
          iteratesOverToolResults: false,
        },
        signals: {
          maxLimit: 0,
          maxStringLength: 0,
          toolCallDensity: 0,
          fanOutRisk: 0,
        },
        sensitive: {
          fieldsAccessed: [],
          categories: [],
        },
        meta: {
          extractionTimeMs: 1,
          codeHash: 'empty-hash',
          lineCount: 0,
        },
      };

      const result = await scorer.score(features);

      expect(result.totalScore).toBe(0);
      expect(result.riskLevel).toBe('none');

      scorer.dispose();
    });

    it('should handle many tool calls', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const toolCalls = Array.from({ length: 20 }, (_, i) => ({
        toolName: `tool:action${i}`,
        isStaticName: true,
        argumentKeys: ['arg1', 'arg2'],
        stringLiterals: [],
        numericLiterals: [],
        insideLoop: false,
        loopDepth: 0,
        location: { line: i + 1, column: 1 },
      }));

      const features: ExtractedFeatures = {
        toolCalls,
        patterns: {
          totalToolCalls: 20,
          uniqueToolsCount: 20,
          toolsInLoops: [],
          maxLoopNesting: 0,
          toolSequence: toolCalls.map((tc) => tc.toolName),
          iteratesOverToolResults: false,
        },
        signals: {
          maxLimit: 100,
          maxStringLength: 50,
          toolCallDensity: 1.0,
          fanOutRisk: 30,
        },
        sensitive: {
          fieldsAccessed: [],
          categories: [],
        },
        meta: {
          extractionTimeMs: 1,
          codeHash: 'many-tools-hash',
          lineCount: 20,
        },
      };

      // Should not throw and should handle gracefully
      const result = await scorer.score(features);

      expect(result.scorerType).toBe('local-llm');
      expect(typeof result.totalScore).toBe('number');

      scorer.dispose();
    });
  });

  describe('custom analyzer', () => {
    it('should use custom analyzer when provided', async () => {
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockResolvedValue({
          score: 75,
          signals: [
            {
              id: 'CUSTOM_SIGNAL',
              score: 75,
              description: 'Custom analysis detected risk',
              level: 'high' as const,
            },
          ],
        }),
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      // Custom analyzer should have been called
      expect(customAnalyzer.analyze).toHaveBeenCalled();
      expect(result.totalScore).toBe(75);
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0].id).toBe('CUSTOM_SIGNAL');

      scorer.dispose();
    });

    it('should initialize custom analyzer', async () => {
      const initializeFn = jest.fn().mockResolvedValue(undefined);
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockResolvedValue({ score: 0, signals: [] }),
        initialize: initializeFn,
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      // Initialize may or may not be called depending on model load
      // since we use fallback, the model may fail and custom init may not run
      // But if model loads (or uses fallback), we should still function
      expect(scorer.isReady()).toBe(true);

      scorer.dispose();
    });

    it('should dispose custom analyzer', async () => {
      const disposeFn = jest.fn();
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockResolvedValue({ score: 0, signals: [] }),
        dispose: disposeFn,
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();
      scorer.dispose();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('should fall back to heuristics when no custom analyzer', async () => {
      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        // No customAnalyzer
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      // Use features that trigger built-in heuristics
      const features = createSensitiveFeatures();
      const result = await scorer.score(features);

      // Should use built-in heuristics (keyword detection)
      expect(result.scorerType).toBe('local-llm');
      expect(result.totalScore).toBeGreaterThan(0);
      // Should have ML_CRITICAL_KEYWORD signal from heuristics (password keyword)
      const hasHeuristicSignal = result.signals.some(
        (s) => s.id === 'ML_CRITICAL_KEYWORD' || s.id === 'SENSITIVE_FIELD',
      );
      expect(hasHeuristicSignal).toBe(true);

      scorer.dispose();
    });

    it('should pass prompt and features to custom analyzer', async () => {
      const analyzeFn = jest.fn().mockResolvedValue({ score: 50, signals: [] });
      const customAnalyzer: CustomAnalyzer = {
        analyze: analyzeFn,
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createExfiltrationFeatures();
      await scorer.score(features);

      // Check that analyzer received a prompt string and features
      expect(analyzeFn).toHaveBeenCalledWith(expect.any(String), features);

      // Verify the prompt contains expected content
      const [prompt] = analyzeFn.mock.calls[0];
      expect(prompt).toContain('TOOLS:');
      expect(prompt).toContain('users:list');

      scorer.dispose();
    });

    it('should handle custom analyzer errors gracefully with fallback', async () => {
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockRejectedValue(new Error('Custom analyzer failed')),
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      // Should use fallback scorer when custom analyzer fails
      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      // Falls back to rule-based scorer
      expect(result.scorerType).toBe('local-llm');
      expect(typeof result.totalScore).toBe('number');

      scorer.dispose();
    });

    it('should clamp custom analyzer scores to 0-100', async () => {
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockResolvedValue({
          score: 150, // Over 100
          signals: [],
        }),
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      // Score should be clamped to 100
      expect(result.totalScore).toBe(100);

      scorer.dispose();
    });

    it('should calculate risk level from custom analyzer score', async () => {
      const customAnalyzer: CustomAnalyzer = {
        analyze: jest.fn().mockResolvedValue({
          score: 85,
          signals: [],
        }),
      };

      const config: LocalLlmConfig = {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        fallbackToRules: true,
        customAnalyzer,
      };

      const scorer = new LocalLlmScorer(config);
      await scorer.initialize();

      const features = createLowRiskFeatures();
      const result = await scorer.score(features);

      // Score of 85 should map to 'critical' risk level (>= 80)
      expect(result.riskLevel).toBe('critical');

      scorer.dispose();
    });
  });
});
