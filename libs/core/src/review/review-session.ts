import { z } from 'zod';

import { analyzeScript, type ScriptAnalysis, type ScriptAnalysisOptions } from '../analysis/script-analysis';
import { assertIntegerOption, MAX_TIMEOUT_MS } from '../enclave-options';
import type { ExecutionError, ExecutionResult, ExecutionStats, ToolHandler } from '../types';
import {
  REVIEW_ERROR_CODES,
  type ReviewContext,
  type ReviewDecision,
  type ReviewFinding,
  type ReviewOptions,
  type ReviewPhase,
  type ReviewRecord,
} from './types';

const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;
const MAX_FINDINGS = 100;
const MAX_TEXT_LENGTH = 4096;
const MAX_NAME_LENGTH = 256;
const TIMED_OUT = Symbol('timed out');

export const REVIEW_HALTED = Symbol('review halted');

const text = z.string().max(MAX_TEXT_LENGTH);
const name = z.string().max(MAX_NAME_LENGTH);
const findings = z
  .array(
    z.object({
      rule: name,
      message: text,
      location: z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() }).optional(),
      suggestion: text.optional(),
      toolName: name.optional(),
    }),
  )
  .max(MAX_FINDINGS);
const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), findings: findings.optional() }),
  z.object({ decision: z.literal('needs_changes'), findings: findings.min(1) }),
  z.object({ decision: z.literal('needs_approval'), findings: findings.optional(), reason: text }),
  z.object({ decision: z.literal('denied'), findings: findings.optional(), reason: text }),
]);
const stopSchema = z.object({ action: z.literal('stop'), reason: text, findings: findings.optional() });
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pass') }),
  z.object({ action: z.literal('replace'), value: z.unknown() }),
  stopSchema,
]);
const errorActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pass') }),
  z.object({ action: z.literal('replace'), value: z.object({ name, message: text, code: name.optional() }) }),
  stopSchema,
]);

type Refusal = Exclude<ReviewDecision, { decision: 'allow' }>;

interface HookAnswer {
  decision?: string;
  action?: string;
  findings?: ReviewFinding[];
  reason?: string;
}

interface ReviewTarget {
  phase: ReviewPhase;
  toolName?: string;
  callIndex?: number;
}

/** An error of a reviewer whose message is safe to show in the result (no answer, no key) */
export class ReviewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerError';
  }
}

/** The decision as a plain copy, or undefined when it is out of shape */
export function parseReviewDecision(value: unknown): ReviewDecision | undefined {
  const parsed = decisionSchema.safeParse(value);
  return parsed.success ? (parsed.data as ReviewDecision) : undefined;
}

export interface NormalizedReviewOptions {
  readonly pre?: ReviewOptions['pre'];
  readonly post?: ReviewOptions['post'];
  readonly timeoutMs: number;
}

/** @throws TypeError unless `review` is undefined or a valid `ReviewOptions` */
export function normalizeReviewOptions(review: unknown): NormalizedReviewOptions | undefined {
  if (review === undefined) return undefined;
  if (typeof review !== 'object' || review === null || Array.isArray(review)) {
    throw new TypeError('review must be an object');
  }
  const { pre, post, timeoutMs, ...others } = review as ReviewOptions;
  const unknownOption = Object.keys(others)[0];
  if (unknownOption !== undefined) {
    throw new TypeError(`review has no option ${JSON.stringify(unknownOption.slice(0, 40))}`);
  }
  if (pre !== undefined && typeof pre !== 'function') throw new TypeError('review.pre must be a function');
  if (post !== undefined && typeof post !== 'function') throw new TypeError('review.post must be a function');
  if (timeoutMs !== undefined) assertIntegerOption('review.timeoutMs', timeoutMs, 1, MAX_TIMEOUT_MS);
  return Object.freeze({ pre, post, timeoutMs: timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS });
}

/** @throws TypeError unless `context` is undefined or an object */
export function assertReviewContext(context: unknown): asserts context is ReviewContext | undefined {
  if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
    throw new TypeError('reviewContext must be an object');
  }
}

function describeFindings(list: readonly ReviewFinding[]): string {
  return list
    .map((finding) => (finding.suggestion ? `${finding.message} (${finding.suggestion})` : finding.message))
    .join('; ');
}

function refusalMessage(target: ReviewTarget, refusal: Refusal): string {
  const subject = target.phase === 'script' ? 'the script' : `the call to ${target.toolName}`;
  if (refusal.decision === 'needs_changes')
    return `Review asks for changes to ${subject}: ${describeFindings(refusal.findings)}`;
  if (refusal.decision === 'needs_approval') return `Review asks for approval of ${subject}: ${refusal.reason}`;
  return `Review denied ${subject}: ${refusal.reason}`;
}

function refusalError(target: ReviewTarget, refusal: Refusal): Error {
  const error = new Error(refusalMessage(target, refusal)) as Error & { code?: string };
  error.name = 'ReviewError';
  error.code = REVIEW_ERROR_CODES[refusal.decision];
  return error;
}

function pending(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** The review of one run: its hooks, failing closed, and every decision they made */
export class ReviewSession {
  readonly halted: Promise<typeof REVIEW_HALTED>;
  private readonly decisions: ReviewRecord[] = [];
  private analysis?: ScriptAnalysis;
  private stopError?: ExecutionError;
  private closed = false;
  private nextCallIndex = 0;
  private signalHalt: () => void = () => undefined;

  constructor(
    private readonly options: NormalizedReviewOptions,
    private readonly context: ReviewContext | undefined,
  ) {
    this.halted = new Promise((resolve) => {
      this.signalHalt = () => resolve(REVIEW_HALTED);
    });
  }

  /** `pre` on the script; returns the error the run ends with when no statement may run */
  async reviewScript(code: string, analysisOptions: ScriptAnalysisOptions): Promise<ExecutionError | undefined> {
    const pre = this.options.pre;
    if (!pre) return undefined;
    const target: ReviewTarget = { phase: 'script' };
    let analysis: ScriptAnalysis;
    try {
      analysis = analyzeScript(code, analysisOptions);
    } catch {
      this.fail(target, 'The script could not be analyzed', 0);
      return this.stopError;
    }
    this.analysis = analysis;
    const decision = await this.ask(
      target,
      () => pre({ phase: 'script', code, analysis, context: this.context }),
      decisionSchema,
    );
    if (decision && decision.decision !== 'allow') {
      this.halt(REVIEW_ERROR_CODES[decision.decision], refusalMessage(target, decision), { ...target, ...decision });
    }
    return this.stopError;
  }

  /** The tool handler with `pre` before and `post` after each call */
  wrapToolHandler(handler: ToolHandler | undefined): ToolHandler | undefined {
    if (!handler) return undefined;
    return async (toolName, args) => {
      if (this.isOver()) return pending();
      const target: ReviewTarget = { phase: 'call', toolName, callIndex: this.nextCallIndex++ };
      const pre = this.options.pre;
      if (pre) {
        const analysis = this.analysis as ScriptAnalysis;
        const decision = await this.ask(
          target,
          () =>
            pre({
              phase: 'call',
              toolName,
              args,
              callIndex: target.callIndex as number,
              analysis,
              context: this.context,
            }),
          decisionSchema,
        );
        if (!decision || this.isOver()) return pending();
        if (decision.decision === 'needs_approval') {
          this.halt(REVIEW_ERROR_CODES.needs_approval, refusalMessage(target, decision), {
            ...target,
            ...decision,
            args,
          });
          return pending();
        }
        if (decision.decision !== 'allow') throw refusalError(target, decision);
      }
      const result = await handler(toolName, args);
      const post = this.options.post;
      if (this.isOver()) return pending();
      if (!post) return result;
      const resultTarget: ReviewTarget = { ...target, phase: 'call-result' };
      const action = await this.ask(
        resultTarget,
        () =>
          post({
            phase: 'call-result',
            toolName,
            args,
            callIndex: target.callIndex as number,
            result,
            context: this.context,
          }),
        actionSchema,
      );
      if (!action || this.isOver()) return pending();
      if (action.action === 'stop') {
        this.stop(resultTarget, action);
        return pending();
      }
      return action.action === 'replace' ? action.value : result;
    };
  }

  /** The result of the run: refused when the review stopped it, otherwise through `post` */
  async finish<T>(
    outcome: ExecutionResult<T> | typeof REVIEW_HALTED,
    stats: ExecutionStats,
  ): Promise<ExecutionResult<T>> {
    this.closed = true;
    let result = outcome === REVIEW_HALTED || this.stopError ? undefined : outcome;
    const post = this.options.post;
    if (result && post) result = await this.reviewOutput(result, post);
    if (!result || this.stopError) {
      const measured = outcome === REVIEW_HALTED ? stats : outcome.stats;
      const endTime = Date.now();
      result = {
        success: false,
        error: this.stopError,
        stats: { ...measured, duration: endTime - measured.startTime, endTime },
      };
    }
    return { ...result, review: { decisions: [...this.decisions] } };
  }

  private async reviewOutput<T>(
    result: ExecutionResult<T>,
    post: NonNullable<ReviewOptions['post']>,
  ): Promise<ExecutionResult<T> | undefined> {
    if (result.success) {
      const target: ReviewTarget = { phase: 'return' };
      const action = await this.ask(
        target,
        () => post({ phase: 'return', value: result.value, context: this.context }),
        actionSchema,
      );
      if (action?.action === 'stop') this.stop(target, action);
      if (!action || action.action === 'stop') return undefined;
      return action.action === 'replace' ? { ...result, value: action.value as T } : result;
    }
    const { name: errorName = 'Error', message = '', code } = result.error ?? {};
    const target: ReviewTarget = { phase: 'error' };
    const error = { name: errorName, message, ...(code !== undefined ? { code } : {}) };
    const action = await this.ask(
      target,
      () => post({ phase: 'error', error, context: this.context }),
      errorActionSchema,
    );
    if (action?.action === 'stop') this.stop(target, action);
    if (!action || action.action === 'stop') return undefined;
    return action.action === 'replace' ? { ...result, error: action.value } : result;
  }

  private isOver(): boolean {
    return this.closed || this.stopError !== undefined;
  }

  private async ask<T>(target: ReviewTarget, invoke: () => unknown, schema: z.ZodType<T>): Promise<T | undefined> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: string;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(TIMED_OUT), this.options.timeoutMs);
      });
      const answer = await Promise.race([Promise.resolve().then(invoke), timeout]);
      // A hook that blocks the thread answers before the timer can fire
      if (Date.now() - started > this.options.timeoutMs) throw TIMED_OUT;
      const parsed = schema.safeParse(answer);
      if (parsed.success) {
        this.record(target, parsed.data as HookAnswer, Date.now() - started);
        return parsed.data;
      }
      failure = 'The review hook gave an answer of the wrong shape';
    } catch (error) {
      if (error === TIMED_OUT) failure = `The review hook did not answer within ${this.options.timeoutMs} ms`;
      else if (error instanceof ReviewerError) failure = error.message.slice(0, MAX_TEXT_LENGTH);
      else failure = 'The review hook threw';
    } finally {
      clearTimeout(timer);
    }
    this.fail(target, failure, Date.now() - started);
    return undefined;
  }

  private record(target: ReviewTarget, answer: HookAnswer, durationMs: number): void {
    this.decisions.push({
      ...target,
      decision: (answer.decision ?? answer.action) as ReviewRecord['decision'],
      ...(answer.findings ? { findings: answer.findings } : {}),
      ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
      durationMs,
    });
  }

  private fail(target: ReviewTarget, reason: string, durationMs: number): void {
    this.decisions.push({ ...target, decision: 'review_failed', reason, durationMs });
    this.halt(REVIEW_ERROR_CODES.review_failed, `Review failed: ${reason}`, {
      ...target,
      decision: 'review_failed',
      reason,
    });
  }

  private stop(target: ReviewTarget, action: { reason: string; findings?: ReviewFinding[] }): void {
    this.halt(REVIEW_ERROR_CODES.denied, `Review stopped the run: ${action.reason}`, {
      ...target,
      decision: 'denied',
      reason: action.reason,
      ...(action.findings ? { findings: action.findings } : {}),
    });
  }

  private halt(code: string, message: string, data: Record<string, unknown>): void {
    if (this.stopError) return;
    this.stopError = { name: 'ReviewError', message, code, data };
    this.signalHalt();
  }
}
