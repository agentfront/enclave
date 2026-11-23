import type { ScriptAnalysis } from '../analysis/script-analysis';

/** What the host passes to `run()` for its hooks: the caller, the session, anything it decides on */
export type ReviewContext = Readonly<Record<string, unknown>>;

export interface ReviewFinding {
  rule: string;
  message: string;
  location?: { line: number; column: number };
  suggestion?: string;
  toolName?: string;
}

export type ReviewDecision =
  | { decision: 'allow'; findings?: ReviewFinding[] }
  | { decision: 'needs_changes'; findings: ReviewFinding[] }
  | { decision: 'needs_approval'; findings?: ReviewFinding[]; reason: string }
  | { decision: 'denied'; findings?: ReviewFinding[]; reason: string };

/** At `phase: 'error'` a replacement `value` is the whole error: `{ name, message, code? }` */
export type PostReviewAction =
  | { action: 'pass' }
  | { action: 'replace'; value: unknown }
  | { action: 'stop'; reason: string; findings?: ReviewFinding[] };

export type PreReviewInput =
  | { phase: 'script'; code: string; analysis: ScriptAnalysis; context?: ReviewContext }
  | {
      phase: 'call';
      toolName: string;
      args: unknown;
      callIndex: number;
      analysis: ScriptAnalysis;
      context?: ReviewContext;
    };

export type PostReviewInput =
  | {
      phase: 'call-result';
      toolName: string;
      args: unknown;
      callIndex: number;
      result: unknown;
      context?: ReviewContext;
    }
  | { phase: 'return'; value: unknown; context?: ReviewContext }
  | { phase: 'error'; error: { name: string; message: string; code?: string }; context?: ReviewContext };

export interface ReviewOptions {
  pre?: (input: PreReviewInput) => ReviewDecision | Promise<ReviewDecision>;
  post?: (input: PostReviewInput) => PostReviewAction | Promise<PostReviewAction>;
  /** How long one hook may take, in ms (default 30000) */
  timeoutMs?: number;
}

export type ReviewPhase = PreReviewInput['phase'] | PostReviewInput['phase'];

export interface ReviewRecord {
  phase: ReviewPhase;
  toolName?: string;
  callIndex?: number;
  decision: ReviewDecision['decision'] | PostReviewAction['action'] | 'review_failed';
  findings?: ReviewFinding[];
  reason?: string;
  durationMs: number;
}

export interface ReviewReport {
  decisions: ReviewRecord[];
}

export const REVIEW_ERROR_CODES = {
  needs_changes: 'REVIEW_NEEDS_CHANGES',
  needs_approval: 'REVIEW_NEEDS_APPROVAL',
  denied: 'REVIEW_DENIED',
  review_failed: 'REVIEW_FAILED',
} as const;
