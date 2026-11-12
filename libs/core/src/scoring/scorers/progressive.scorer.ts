/**
 * Progressive Scorer
 *
 * Two-stage scoring strategy:
 * 1. Fast rule-based check
 * 2. Detailed ML-based analysis if score exceeds escalation threshold
 *
 * This provides optimal latency for benign code while still catching
 * sophisticated attacks through ML analysis.
 *
 * When the detailed stage is called for and cannot answer (it throws, or it was not
 * configured), the scorer either answers with the fast score alone or fails, depending on
 * `requireDetailed` (see `ProgressiveScorerOptions`).
 *
 * @packageDocumentation
 */

import { BaseScorer, type Scorer } from '../scorer.interface';
import { RuleBasedScorer } from './rule-based.scorer';
import { ExternalApiScorer } from './external-api.scorer';
import { LocalLlmScorer } from './local-llm.scorer';
import type { ExtractedFeatures, ScoringResult, RiskSignal, ProgressiveScoringConfig } from '../types';
import { DEFAULT_PROGRESSIVE_CONFIG } from '../types';

/**
 * Options of the progressive scorer
 */
export interface ProgressiveScorerOptions {
  /**
   * What happens when the fast score reaches the escalation threshold and the detailed stage
   * cannot answer (it throws, or none is configured):
   *
   * - false: the fast result is the answer
   * - true: `score()` throws a `ProgressiveScorerError`, so that whoever asked decides. The
   *   scoring gate sets this when it is configured with `failOpen: false`.
   *
   * @default false
   */
  requireDetailed?: boolean;
}

/**
 * Error thrown when the detailed stage is required and cannot answer
 */
export class ProgressiveScorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressiveScorerError';
  }
}

/**
 * Progressive Scorer - fast check first, escalate if suspicious
 *
 * @example
 * ```typescript
 * const scorer = new ProgressiveScorer({
 *   strategy: 'progressive',
 *   fast: { type: 'rule-based' },
 *   detailed: { type: 'local-llm', localLlm: { modelId: 'Xenova/codebert-base' } },
 *   escalationThreshold: 30,
 *   combination: 'max'
 * });
 *
 * await scorer.initialize();
 * const result = await scorer.score(features);
 * ```
 */
export class ProgressiveScorer extends BaseScorer {
  readonly type = 'progressive' as const;
  readonly name = 'ProgressiveScorer';

  private readonly fastScorer: Scorer;
  private detailedScorer: Scorer | null = null;
  private readonly escalationThreshold: number;
  private readonly combination: 'replace' | 'max' | 'avg';
  private readonly config: ProgressiveScoringConfig;
  private readonly requireDetailed: boolean;

  constructor(config: ProgressiveScoringConfig, options: ProgressiveScorerOptions = {}) {
    super();
    this.config = config;
    this.requireDetailed = options.requireDetailed === true;
    this.escalationThreshold = config.escalationThreshold ?? DEFAULT_PROGRESSIVE_CONFIG.escalationThreshold;
    this.combination = config.combination ?? DEFAULT_PROGRESSIVE_CONFIG.combination;

    // Fast scorer is always rule-based
    this.fastScorer = new RuleBasedScorer(config.fast.customRules);
  }

  /**
   * Initialize both scorers
   */
  override async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    // Initialize fast scorer
    await this.fastScorer.initialize?.();

    // Create and initialize detailed scorer
    this.detailedScorer = this.createDetailedScorer();
    await this.detailedScorer?.initialize?.();

    this.ready = true;
  }

  /**
   * Create the detailed scorer based on configuration
   */
  private createDetailedScorer(): Scorer | null {
    const { detailed } = this.config;

    if (detailed.type === 'local-llm') {
      if (!detailed.localLlm) {
        console.warn('[ProgressiveScorer] local-llm requested but no localLlm config provided');
        return null;
      }
      return new LocalLlmScorer(detailed.localLlm);
    }

    if (detailed.type === 'external-api') {
      if (!detailed.externalApi) {
        console.warn('[ProgressiveScorer] external-api requested but no externalApi config provided');
        return null;
      }
      return new ExternalApiScorer(detailed.externalApi);
    }

    return null;
  }

  /**
   * Score with progressive strategy
   */
  async score(features: ExtractedFeatures): Promise<ScoringResult> {
    const startTime = performance.now();

    // Step 1: Fast rule-based check
    const fastResult = await this.fastScorer.score(features);

    // Step 2: Check if we need to escalate
    if (fastResult.totalScore < this.escalationThreshold) {
      // Below threshold - return fast result
      return {
        ...fastResult,
        scoringTimeMs: performance.now() - startTime,
        scorerType: 'progressive',
      };
    }

    // Step 3: Escalate to detailed scoring
    if (!this.detailedScorer) {
      if (this.requireDetailed) {
        throw new ProgressiveScorerError(
          `Detailed scoring is required at a fast score of ${fastResult.totalScore} ` +
            `(escalation threshold ${this.escalationThreshold}), and no detailed scorer is configured`,
        );
      }
      // No detailed scorer available - return fast result with note
      return {
        ...fastResult,
        scoringTimeMs: performance.now() - startTime,
        scorerType: 'progressive',
      };
    }

    try {
      const detailedResult = await this.detailedScorer.score(features);

      // Step 4: Combine results
      const combinedScore = this.combineScores(fastResult.totalScore, detailedResult.totalScore);
      const mergedSignals = this.mergeSignals(fastResult.signals, detailedResult.signals);

      return {
        totalScore: combinedScore,
        riskLevel: this.calculateRiskLevel(combinedScore),
        signals: mergedSignals,
        scoringTimeMs: performance.now() - startTime,
        scorerType: 'progressive',
      };
    } catch (error) {
      if (this.requireDetailed) {
        throw new ProgressiveScorerError(
          `Detailed scoring failed at a fast score of ${fastResult.totalScore} ` +
            `(escalation threshold ${this.escalationThreshold}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Detailed scoring failed - use fast result
      console.warn(`[ProgressiveScorer] Detailed scoring failed: ${error}`);
      return {
        ...fastResult,
        scoringTimeMs: performance.now() - startTime,
        scorerType: 'progressive',
      };
    }
  }

  /**
   * Combine fast and detailed scores based on configuration
   */
  private combineScores(fast: number, detailed: number): number {
    switch (this.combination) {
      case 'replace':
        return this.clampScore(detailed);
      case 'max':
        return this.clampScore(Math.max(fast, detailed));
      case 'avg':
        return this.clampScore((fast + detailed) / 2);
      default:
        return this.clampScore(Math.max(fast, detailed));
    }
  }

  /**
   * Merge signals from both scorers, keeping higher scores for duplicates
   */
  private mergeSignals(fast: RiskSignal[], detailed: RiskSignal[]): RiskSignal[] {
    const signalMap = new Map<string, RiskSignal>();

    // Add fast signals
    for (const signal of fast) {
      signalMap.set(signal.id, signal);
    }

    // Add/override with detailed signals if they have higher scores
    for (const signal of detailed) {
      const existing = signalMap.get(signal.id);
      if (!existing || signal.score > existing.score) {
        signalMap.set(signal.id, signal);
      }
    }

    return Array.from(signalMap.values());
  }

  /**
   * Get the escalation threshold
   */
  getEscalationThreshold(): number {
    return this.escalationThreshold;
  }

  /**
   * Get the combination mode
   */
  getCombinationMode(): 'replace' | 'max' | 'avg' {
    return this.combination;
  }

  /**
   * Check if detailed scorer is available
   */
  hasDetailedScorer(): boolean {
    return this.detailedScorer !== null;
  }

  /**
   * Dispose of resources
   */
  override dispose(): void {
    this.fastScorer.dispose?.();
    this.detailedScorer?.dispose?.();
    this.detailedScorer = null;
    super.dispose();
  }
}
