/**
 * OpenAPI Spec Poller
 *
 * Polls an OpenAPI specification URL for changes using ETag/content-hash detection.
 * Follows the HealthChecker pattern (EventEmitter, start/stop, setInterval).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import { sha256Hex } from './hash-utils';

/**
 * Change detection strategy.
 */
export type ChangeDetectionMode = 'content-hash' | 'etag' | 'auto';

/**
 * Retry configuration for failed polls.
 */
export interface PollerRetryConfig {
  /** Maximum number of retries per poll cycle @default 3 */
  maxRetries?: number;
  /** Initial delay before first retry in ms @default 1000 */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms @default 10000 */
  maxDelayMs?: number;
  /** Backoff multiplier @default 2 */
  backoffMultiplier?: number;
}

/**
 * Configuration for the OpenAPI spec poller.
 */
export interface OpenApiPollerConfig {
  /** URL of the OpenAPI specification */
  url: string;
  /** Poll interval in milliseconds @default 60000 */
  intervalMs?: number;
  /** Fetch timeout in milliseconds @default 10000 */
  fetchTimeoutMs?: number;
  /** Change detection strategy @default 'auto' */
  changeDetection?: ChangeDetectionMode;
  /** Retry configuration */
  retry?: PollerRetryConfig;
  /** Number of consecutive failures before marking unhealthy @default 3 */
  unhealthyThreshold?: number;
  /** Additional headers for fetch requests */
  headers?: Record<string, string>;
}

/**
 * Events emitted by the poller.
 */
export interface OpenApiPollerEvents {
  changed: [spec: string, hash: string];
  unchanged: [];
  pollError: [error: Error];
  unhealthy: [consecutiveFailures: number];
  recovered: [];
}

const DEFAULT_RETRY: Required<PollerRetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Polls an OpenAPI spec URL for changes using ETag and content-hash detection.
 */
export class OpenApiSpecPoller extends EventEmitter {
  private readonly config: Required<Omit<OpenApiPollerConfig, 'retry' | 'headers'>> & {
    retry: Required<PollerRetryConfig>;
    headers: Record<string, string>;
  };

  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private lastHash: string | null = null;
  private lastEtag: string | null = null;
  private lastModified: string | null = null;
  private consecutiveFailures = 0;
  private isPolling = false;
  private wasUnhealthy = false;
  /** Per-run abort controller — aborted on stop(), recreated on start() */
  private _runAbort: AbortController = new AbortController();
  private _fetchController: AbortController | null = null;
  private _activePoll: Promise<void> | null = null;

  constructor(config: OpenApiPollerConfig) {
    super();
    this.config = {
      url: config.url,
      intervalMs: config.intervalMs ?? 60000,
      fetchTimeoutMs: config.fetchTimeoutMs ?? 10000,
      changeDetection: config.changeDetection ?? 'auto',
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      retry: { ...DEFAULT_RETRY, ...config.retry },
      headers: config.headers ?? {},
    };
  }

  /**
   * Start polling for changes.
   */
  start(): void {
    if (this.intervalTimer) return;
    this._runAbort = new AbortController();
    const runSignal = this._runAbort.signal;

    // If a previous poll is still settling after stop(), chain the initial
    // poll so it runs once the old one completes instead of being dropped.
    const pendingPoll = this._activePoll;
    if (pendingPoll) {
      pendingPoll.finally(() => {
        if (!runSignal.aborted) {
          this._activePoll = this.pollWithSignal(runSignal).catch(() => undefined);
        }
      });
    } else {
      this._activePoll = this.pollWithSignal(runSignal).catch(() => undefined);
    }

    this.intervalTimer = setInterval(() => {
      this._activePoll = this.pollWithSignal(runSignal).catch(() => undefined);
    }, this.config.intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    this._runAbort.abort();
    if (this._fetchController) {
      this._fetchController.abort();
      this._fetchController = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Get the current content hash.
   */
  getHash(): string | null {
    return this.lastHash;
  }

  /**
   * Get the number of consecutive failures.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Perform a single poll cycle.
   */
  async poll(): Promise<void> {
    return this.pollWithSignal(this._runAbort.signal);
  }

  private async pollWithSignal(runSignal: AbortSignal): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      await this.fetchWithRetry(runSignal);
    } finally {
      this.isPolling = false;
      this._activePoll = null;
    }
  }

  private async fetchWithRetry(runSignal: AbortSignal): Promise<void> {
    const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier } = this.config.retry;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (runSignal.aborted) return;

      try {
        await this.doFetch(runSignal);
        if (runSignal.aborted) return;
        // Success — reset failure counter and emit recovered if applicable
        if (this.consecutiveFailures > 0) {
          this.consecutiveFailures = 0;
          if (this.wasUnhealthy) {
            this.wasUnhealthy = false;
            this.emit('recovered');
          }
        }
        return;
      } catch (error) {
        if (runSignal.aborted) return;

        if (attempt === maxRetries) {
          this.consecutiveFailures++;
          this.emit('pollError', error instanceof Error ? error : new Error(String(error)));

          if (this.consecutiveFailures >= this.config.unhealthyThreshold && !this.wasUnhealthy) {
            this.wasUnhealthy = true;
            this.emit('unhealthy', this.consecutiveFailures);
          }
          return;
        }

        // Wait before retrying (abortable)
        const delay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt), maxDelayMs);
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            runSignal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          runSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }

  private async doFetch(runSignal: AbortSignal): Promise<void> {
    if (runSignal.aborted) return;

    const headers: Record<string, string> = { ...this.config.headers };

    // Add conditional request headers
    if (this.config.changeDetection !== 'content-hash') {
      if (this.lastEtag) {
        headers['If-None-Match'] = this.lastEtag;
      }
      if (this.lastModified) {
        headers['If-Modified-Since'] = this.lastModified;
      }
    }

    const controller = new AbortController();
    this._fetchController = controller;
    const timeout = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);

    try {
      const response = await fetch(this.config.url, {
        headers,
        signal: controller.signal,
      });

      if (runSignal.aborted) return;

      // HTTP 304: Not Modified
      if (response.status === 304) {
        this.emit('unchanged');
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Read response headers (defer storing until body is fully processed)
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');

      const body = await response.text();

      if (runSignal.aborted) return;

      const hash = await sha256Hex(body);

      if (runSignal.aborted) return;

      if (this.lastHash && this.lastHash === hash) {
        this.emit('unchanged');
        if (etag) this.lastEtag = etag;
        if (lastModified) this.lastModified = lastModified;
        return;
      }

      this.emit('changed', body, hash);
      this.lastHash = hash;

      // Store headers only after successful body processing
      if (etag) this.lastEtag = etag;
      if (lastModified) this.lastModified = lastModified;
    } finally {
      clearTimeout(timeout);
      if (this._fetchController === controller) {
        this._fetchController = null;
      }
    }
  }

  /**
   * Dispose the poller and release resources.
   */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
