/**
 * Pausable Timer
 *
 * A one-shot countdown that can be paused and resumed, used to leave the time spent waiting for
 * the host's tool handler out of the execution timeout. Elapsed time is measured on the monotonic
 * clock, so a system clock change cannot stretch or cut the countdown.
 *
 * @packageDocumentation
 */

export class PausableTimer {
  private remainingMs: number;
  private resumedAt = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    durationMs: number,
    private readonly onExpire: () => void,
  ) {
    this.remainingMs = durationMs;
  }

  /** Start or resume the countdown. Does nothing while running or after `stop()`. */
  resume(): void {
    if (this.stopped || this.handle !== null) return;
    this.resumedAt = performance.now();
    this.handle = setTimeout(() => this.expire(), Math.max(0, this.remainingMs));
  }

  /** Pause the countdown, keeping the time left. */
  pause(): void {
    if (this.handle === null) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.remainingMs -= performance.now() - this.resumedAt;
  }

  /** Cancel the countdown for good. */
  stop(): void {
    this.pause();
    this.stopped = true;
  }

  private expire(): void {
    this.handle = null;
    this.stopped = true;
    this.onExpire();
  }
}
