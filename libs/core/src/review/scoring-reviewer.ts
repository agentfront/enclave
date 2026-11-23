import { ScoringGate } from '../scoring/scoring-gate';
import type { ScoringGateConfig } from '../scoring/types';
import type { PreReviewInput, ReviewDecision } from './types';

/** The scoring gate as a `pre` reviewer: allow, then needs_approval from warnThreshold, denied from blockThreshold */
export function scoringReviewer(config: ScoringGateConfig = {}): (input: PreReviewInput) => Promise<ReviewDecision> {
  const gate = new ScoringGate({ scorer: 'rule-based', ...config, failOpen: false });
  const { blockThreshold, warnThreshold } = gate.getConfig();
  const disabled = gate.getScorerType() === 'disabled';
  return async (input) => {
    if (input.phase !== 'script' || disabled) return { decision: 'allow' };
    const scored = await gate.evaluate(input.code);
    if (scored.totalScore === undefined) throw new Error(scored.reason ?? 'The scorer gave no score');
    const findings = (scored.signals ?? []).map((signal) => ({ rule: String(signal.id), message: signal.description }));
    if (!scored.allowed) {
      return { decision: 'denied', reason: `Risk score ${scored.totalScore} reaches ${blockThreshold}`, findings };
    }
    if (scored.totalScore >= warnThreshold) {
      return {
        decision: 'needs_approval',
        reason: `Risk score ${scored.totalScore} reaches ${warnThreshold}`,
        findings,
      };
    }
    return { decision: 'allow', findings };
  };
}
