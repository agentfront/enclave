/**
 * Local LLM Scorer
 *
 * Provides ML-based security scoring with multiple options:
 * - Built-in heuristics: Keyword-based risk detection (default)
 * - Custom analyzer: Plug in external LLM or static code analyzer
 *
 * Optionally loads Hugging Face transformers.js for on-device ML support.
 *
 * @packageDocumentation
 */

import { BaseScorer } from '../scorer.interface';
import { RuleBasedScorer } from './rule-based.scorer';
import type { ExtractedFeatures, ScoringResult, RiskSignal, LocalLlmConfig, RiskLevel } from '../types';

// Pipeline type from @huggingface/transformers
type Pipeline = (input: string, options?: Record<string, unknown>) => Promise<{ data: number[] }>;

/**
 * Default model cache directory
 */
const DEFAULT_CACHE_DIR = './.cache/transformers';

/**
 * Default model for classification
 */
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * Risk keywords to look for in feature text
 */
const RISK_KEYWORDS = {
  critical: ['password', 'secret', 'apikey', 'token', 'credential', 'private_key'],
  high: ['exfiltration', 'send', 'webhook', 'upload', 'transfer', 'email'],
  medium: ['limit:999', 'bulk', 'batch', 'all', 'wildcard'],
  low: ['loop', 'iterate', 'list', 'query'],
};

/**
 * Local LLM Scorer - ML-based security scoring
 *
 * @example Basic usage with built-in heuristics
 * ```typescript
 * const scorer = new LocalLlmScorer({
 *   modelId: 'Xenova/all-MiniLM-L6-v2',
 * });
 * await scorer.initialize();
 * const result = await scorer.score(features);
 * ```
 *
 * @example With custom analyzer (external LLM)
 * ```typescript
 * const scorer = new LocalLlmScorer({
 *   modelId: 'Xenova/all-MiniLM-L6-v2',
 *   customAnalyzer: {
 *     async analyze(prompt, features) {
 *       const response = await myLLM.score(prompt);
 *       return { score: response.risk, signals: response.signals };
 *     }
 *   }
 * });
 * ```
 */
export class LocalLlmScorer extends BaseScorer {
  readonly type = 'local-llm' as const;
  readonly name = 'LocalLlmScorer';

  private pipeline: Pipeline | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly fallbackScorer: RuleBasedScorer | null;
  private readonly config: LocalLlmConfig;

  constructor(config: LocalLlmConfig) {
    super();
    this.config = {
      ...config,
      modelId: config.modelId || DEFAULT_MODEL_ID,
      mode: config.mode ?? 'classification',
      cacheDir: config.cacheDir ?? config.modelDir ?? DEFAULT_CACHE_DIR,
      fallbackToRules: config.fallbackToRules ?? true,
    };

    // Create fallback scorer if enabled
    this.fallbackScorer = this.config.fallbackToRules !== false ? new RuleBasedScorer() : null;
  }

  /**
   * Initialize the ML model
   */
  override async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  /**
   * Internal initialization logic
   */
  private async _initialize(): Promise<void> {
    try {
      // Dynamic import using Function to avoid TypeScript checking for the optional dependency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transformers = await (Function('return import("@huggingface/transformers")')() as Promise<any>);
      const { pipeline } = transformers;

      // Use feature-extraction pipeline for both modes
      // (classification mode uses embeddings + heuristics, similarity mode uses embeddings + VectoriaDB)
      const pipelineFn = await pipeline('feature-extraction', this.config.modelId, {
        cache_dir: this.config.cacheDir,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pipeline type is complex
      this.pipeline = pipelineFn as any as Pipeline;

      // Initialize custom analyzer if provided
      if (this.config.customAnalyzer?.initialize) {
        await this.config.customAnalyzer.initialize();
      }

      this.ready = true;
    } catch (error) {
      this.initPromise = null;

      if (this.fallbackScorer) {
        console.warn(
          `[LocalLlmScorer] Model load failed, using rule-based fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        // Initialize custom analyzer even when model fails (it may not need the model)
        if (this.config.customAnalyzer?.initialize) {
          await this.config.customAnalyzer.initialize();
        }

        this.ready = true; // Ready with fallback
      } else {
        throw new LocalLlmScorerError(
          `Failed to initialize model: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Score the extracted features
   */
  async score(features: ExtractedFeatures): Promise<ScoringResult> {
    const startTime = performance.now();

    // If custom analyzer is provided, use it even if model failed to load
    if (this.config.customAnalyzer) {
      try {
        if (this.config.mode === 'similarity') {
          return await this.scoreWithSimilarity(features, startTime);
        }
        return await this.scoreWithClassification(features, startTime);
      } catch (error) {
        // On error, try fallback
        if (this.fallbackScorer) {
          console.warn(
            `[LocalLlmScorer] Custom analyzer failed, using fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          const result = await this.fallbackScorer.score(features);
          return {
            ...result,
            scorerType: 'local-llm',
          };
        }
        throw error;
      }
    }

    // If model failed to load and we have fallback (no custom analyzer)
    if (!this.pipeline && this.fallbackScorer) {
      const result = await this.fallbackScorer.score(features);
      return {
        ...result,
        scorerType: 'local-llm', // Report as local-llm even when using fallback
      };
    }

    try {
      if (this.config.mode === 'similarity') {
        return await this.scoreWithSimilarity(features, startTime);
      }
      return await this.scoreWithClassification(features, startTime);
    } catch (error) {
      // On error, try fallback
      if (this.fallbackScorer) {
        console.warn(
          `[LocalLlmScorer] Scoring failed, using fallback: ${error instanceof Error ? error.message : String(error)}`,
        );
        const result = await this.fallbackScorer.score(features);
        return {
          ...result,
          scorerType: 'local-llm',
        };
      }
      throw error;
    }
  }

  /**
   * Score using text classification approach
   *
   * Uses custom analyzer if configured, otherwise falls back to heuristic analysis.
   */
  private async scoreWithClassification(features: ExtractedFeatures, startTime: number): Promise<ScoringResult> {
    // Convert features to text prompt
    const prompt = this.featuresToPrompt(features);

    // Score using custom analyzer or built-in heuristics
    const { score, signals } = await this.analyzePrompt(prompt, features);

    return {
      totalScore: this.clampScore(score),
      riskLevel: this.calculateRiskLevel(score),
      signals,
      scoringTimeMs: performance.now() - startTime,
      scorerType: 'local-llm',
    };
  }

  /**
   * Score using similarity to known malicious patterns
   */
  private async scoreWithSimilarity(features: ExtractedFeatures, startTime: number): Promise<ScoringResult> {
    // Convert features to text prompt
    const prompt = this.featuresToPrompt(features);

    // Score using custom analyzer or built-in heuristics
    const { score, signals } = await this.analyzePrompt(prompt, features);

    // Add similarity mode signal
    signals.push({
      id: 'SIMILARITY_MODE',
      score: 0,
      description: 'Similarity scoring (VectoriaDB integration pending)',
      level: 'none' as RiskLevel,
    });

    return {
      totalScore: this.clampScore(score),
      riskLevel: this.calculateRiskLevel(score),
      signals,
      scoringTimeMs: performance.now() - startTime,
      scorerType: 'local-llm',
    };
  }

  /**
   * Convert extracted features to a text prompt for the model
   */
  private featuresToPrompt(features: ExtractedFeatures): string {
    const parts: string[] = [];

    // Tool call summary
    const toolNames = features.toolCalls.map((tc) => tc.toolName);
    if (toolNames.length > 0) {
      parts.push(`TOOLS: ${toolNames.slice(0, 10).join(', ')}${toolNames.length > 10 ? '...' : ''}`);
    }

    // Arguments summary
    const allArgs = features.toolCalls.flatMap((tc) => tc.argumentKeys);
    if (allArgs.length > 0) {
      const uniqueArgs = [...new Set(allArgs)];
      parts.push(`ARGS: ${uniqueArgs.slice(0, 10).join(', ')}${uniqueArgs.length > 10 ? '...' : ''}`);
    }

    // String literals (potential sensitive data)
    const strings = features.toolCalls.flatMap((tc) => tc.stringLiterals);
    if (strings.length > 0) {
      parts.push(`STRINGS: ${strings.slice(0, 5).join(', ')}${strings.length > 5 ? '...' : ''}`);
    }

    // Sensitive fields
    if (features.sensitive.fieldsAccessed.length > 0) {
      parts.push(`SENSITIVE: ${features.sensitive.fieldsAccessed.join(', ')}`);
      parts.push(`CATEGORIES: ${features.sensitive.categories.join(', ')}`);
    }

    // Pattern signals
    parts.push(
      `PATTERNS: loops=${features.patterns.maxLoopNesting} ` +
        `tools_in_loops=${features.patterns.toolsInLoops.length} ` +
        `sequence_len=${features.patterns.toolSequence.length}`,
    );

    // Numeric signals
    parts.push(
      `SIGNALS: limit=${features.signals.maxLimit} ` +
        `fanout=${features.signals.fanOutRisk} ` +
        `density=${features.signals.toolCallDensity.toFixed(2)}`,
    );

    // Tool sequence for exfiltration detection
    if (features.patterns.toolSequence.length > 1) {
      parts.push(`SEQUENCE: ${features.patterns.toolSequence.join(' -> ')}`);
    }

    return parts.join(' | ');
  }

  /**
   * Analyze prompt for risk signals
   *
   * Uses custom analyzer if provided, otherwise falls back to built-in heuristics.
   */
  private async analyzePrompt(
    prompt: string,
    features: ExtractedFeatures,
  ): Promise<{ score: number; signals: RiskSignal[] }> {
    // Use custom analyzer if provided
    if (this.config.customAnalyzer) {
      return this.config.customAnalyzer.analyze(prompt, features);
    }

    // Fall back to built-in heuristic analysis
    return this.analyzeWithHeuristics(prompt, features);
  }

  /**
   * Built-in heuristic analysis for risk signals
   *
   * This is a keyword-based approach used when no custom analyzer is provided.
   */
  private analyzeWithHeuristics(prompt: string, features: ExtractedFeatures): { score: number; signals: RiskSignal[] } {
    const signals: RiskSignal[] = [];
    let totalScore = 0;
    const promptLower = prompt.toLowerCase();

    // Check for critical keywords (report all matches, cap total contribution)
    const criticalMatches: string[] = [];
    for (const keyword of RISK_KEYWORDS.critical) {
      if (promptLower.includes(keyword)) {
        criticalMatches.push(keyword);
      }
    }
    if (criticalMatches.length > 0) {
      // Score: 25 for first match + 5 for each additional (capped at 40 total)
      const score = Math.min(40, 25 + (criticalMatches.length - 1) * 5);
      totalScore += score;
      signals.push({
        id: 'ML_CRITICAL_KEYWORD',
        score,
        description: `Critical security keyword${
          criticalMatches.length > 1 ? 's' : ''
        } detected: ${criticalMatches.join(', ')}`,
        level: 'critical',
        context: { keywords: criticalMatches },
      });
    }

    // Check for high risk keywords (report all matches, cap total contribution)
    const highRiskMatches: string[] = [];
    for (const keyword of RISK_KEYWORDS.high) {
      if (promptLower.includes(keyword)) {
        highRiskMatches.push(keyword);
      }
    }
    if (highRiskMatches.length > 0) {
      // Score: 15 for first match + 5 for each additional (capped at 30 total)
      const score = Math.min(30, 15 + (highRiskMatches.length - 1) * 5);
      totalScore += score;
      signals.push({
        id: 'ML_HIGH_RISK_KEYWORD',
        score,
        description: `High risk keyword${highRiskMatches.length > 1 ? 's' : ''} detected: ${highRiskMatches.join(
          ', ',
        )}`,
        level: 'high',
        context: { keywords: highRiskMatches },
      });
    }

    // Exfiltration pattern detection (enhanced)
    const sequence = features.patterns.toolSequence.join(' ');
    const seqLower = sequence.toLowerCase();
    if (
      (seqLower.includes('list') || seqLower.includes('get') || seqLower.includes('query')) &&
      (seqLower.includes('send') || seqLower.includes('email') || seqLower.includes('webhook'))
    ) {
      const score = 35;
      totalScore += score;
      signals.push({
        id: 'ML_EXFILTRATION_PATTERN',
        score,
        description: 'Data retrieval followed by external send pattern',
        level: 'critical',
        context: { sequence: features.patterns.toolSequence },
      });
    }

    // High fan-out risk
    if (features.signals.fanOutRisk > 50) {
      const score = Math.min(20, Math.floor(features.signals.fanOutRisk / 5));
      totalScore += score;
      signals.push({
        id: 'ML_HIGH_FANOUT',
        score,
        description: `High fan-out risk detected: ${features.signals.fanOutRisk}`,
        level: 'medium',
        context: { fanOutRisk: features.signals.fanOutRisk },
      });
    }

    // Multiple sensitive categories
    if (features.sensitive.categories.length > 1) {
      const score = 15 * features.sensitive.categories.length;
      totalScore += score;
      signals.push({
        id: 'ML_MULTI_SENSITIVE',
        score,
        description: `Multiple sensitive data categories: ${features.sensitive.categories.join(', ')}`,
        level: 'high',
        context: { categories: features.sensitive.categories },
      });
    }

    return { score: totalScore, signals };
  }

  /**
   * Get the model configuration
   */
  getConfig(): Readonly<LocalLlmConfig> {
    return this.config;
  }

  /**
   * Check if using fallback scorer
   */
  isUsingFallback(): boolean {
    return this.pipeline === null && this.fallbackScorer !== null && this.ready;
  }

  /**
   * Dispose of resources
   */
  override dispose(): void {
    this.pipeline = null;
    this.initPromise = null;
    this.fallbackScorer?.dispose?.();
    this.config.customAnalyzer?.dispose?.();
    super.dispose();
  }
}

/**
 * Error thrown by LocalLlmScorer
 */
export class LocalLlmScorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalLlmScorerError';
  }
}
