/**
 * OpenAPI Source
 *
 * Orchestrator that ties together the spec poller, tool loader, and broker.
 * Handles diff-based tool updates when specs change.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import { OpenApiSpecPoller } from './openapi-spec-poller';
import type { OpenApiPollerConfig } from './openapi-spec-poller';
import { OpenApiToolLoader } from './openapi-tool-loader';
import type { LoaderOptions, UpstreamAuth } from './openapi-tool-loader';
import type { ToolRegistry } from '../tool-registry';

/**
 * The poller's default timeout for fetching the specification.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/**
 * Health status for the OpenAPI source.
 */
export type SourceHealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/**
 * Configuration for an OpenAPI source.
 */
export interface OpenApiSourceConfig extends OpenApiPollerConfig {
  /** Service name (e.g., 'user-service') */
  name: string;
  /** Upstream API base URL */
  baseUrl: string;
  /** Tool loader options */
  loaderOptions?: LoaderOptions;
  /** Upstream authentication */
  auth?: UpstreamAuth;
}

/**
 * Statistics for the OpenAPI source.
 */
export interface OpenApiSourceStats {
  toolCount: number;
  lastUpdate: string;
  specHash: string;
  pollHealth: SourceHealthStatus;
  /** Message of the last failure, until a specification is applied again */
  lastError?: string;
}

/**
 * Tool update event data.
 */
export interface ToolsUpdatedEvent {
  added: string[];
  removed: string[];
  updated: string[];
}

/**
 * Orchestrator that ties together spec polling, tool loading, and broker registration.
 */
export class OpenApiSource extends EventEmitter {
  private readonly toolRegistry: ToolRegistry;
  private readonly config: OpenApiSourceConfig;
  private poller: OpenApiSpecPoller | null = null;
  private previousToolNames: Set<string> = new Set();
  private lastUpdate = '';
  private specHash = '';
  private loaded = false;
  private syncFailed = false;
  private pollFailing = false;
  private lastError: Error | undefined;
  private disposed = false;
  private _syncLock: Promise<void> = Promise.resolve();

  constructor(toolRegistry: ToolRegistry, config: OpenApiSourceConfig) {
    super();
    this.toolRegistry = toolRegistry;
    this.config = config;
  }

  /**
   * Initial load + start polling.
   *
   * A failure while polling (a specification that cannot be fetched, parsed or applied) is
   * reported with the `error` event when it has a listener, and always through `getStats()`:
   * `pollHealth` becomes `unhealthy` and `lastError` holds the message. The tools of the last
   * specification that was applied stay registered.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('OpenApiSource is disposed');

    // Initial load
    await this.refresh();

    // Start polling
    this.poller = new OpenApiSpecPoller(this.config);

    this.poller.on('changed', (spec: string) => {
      this._syncLock = this._syncLock
        .then(async () => {
          if (this.disposed) return;
          const parsed: unknown = JSON.parse(spec);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('The OpenAPI spec is not a JSON object');
          }
          await this.syncTools(parsed as Record<string, unknown>);
        })
        .catch((error: unknown) => {
          this.syncFailed = true;
          this.reportError(error);
        });
    });

    this.poller.on('unhealthy', (failures: number) => {
      this.pollFailing = true;
      this.notify('unhealthy', failures);
    });

    this.poller.on('recovered', () => {
      this.pollFailing = false;
      this.notify('recovered');
    });

    this.poller.on('pollError', (error: Error) => {
      this.reportError(error);
    });

    this.poller.on('unchanged', () => {
      // A poll that worked: an earlier poll failure is over
      if (!this.syncFailed) this.lastError = undefined;
    });

    this.poller.start();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.poller) {
      this.poller.stop();
    }
  }

  /**
   * Manual refresh (for webhook triggers).
   *
   * @throws when the specification cannot be fetched or applied; the registered tools are
   * then what they were before
   */
  async refresh(): Promise<void> {
    if (this.disposed) throw new Error('OpenApiSource is disposed');

    try {
      const loader = await OpenApiToolLoader.fromURL(
        this.config.url,
        {
          // The request for the specification is the one the poller sends: same headers,
          // same timeout, same size limit.
          specHeaders: this.config.headers,
          specTimeoutMs: this.config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
          maxSpecBytes: this.config.maxSpecBytes,
          ...this.config.loaderOptions,
          baseUrl: this.config.baseUrl,
          sourceName: this.config.name,
        },
        this.config.auth,
      );
      this.applyTools(loader);
    } catch (error) {
      this.syncFailed = true;
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Sync tools based on a new spec (diff-based update).
   */
  private async syncTools(spec: Record<string, unknown>): Promise<void> {
    const loader = await OpenApiToolLoader.fromSpec(
      spec,
      {
        ...this.config.loaderOptions,
        baseUrl: this.config.baseUrl,
        sourceName: this.config.name,
      },
      this.config.auth,
    );
    this.applyTools(loader);
  }

  /**
   * Replace the tools of this source with the tools of a loaded specification, in one step:
   * either every tool of the new specification is registered and every tool that is gone is
   * removed, or nothing changes. A tool this source does not manage is never replaced.
   */
  private applyTools(loader: OpenApiToolLoader): void {
    const newTools = loader.getTools();
    const newToolNames = loader.getToolNames();
    const oldToolNames = this.previousToolNames;

    // Check everything before anything is changed
    for (const tool of newTools) {
      if (!oldToolNames.has(tool.name) && this.toolRegistry.has(tool.name)) {
        throw new Error(
          `Tool "${tool.name}" is already registered and is not managed by OpenAPI source "${this.config.name}"`,
        );
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    for (const tool of newTools) {
      this.toolRegistry.replace(tool);
      (oldToolNames.has(tool.name) ? updated : added).push(tool.name);
    }
    for (const name of oldToolNames) {
      if (!newToolNames.has(name)) {
        this.toolRegistry.unregister(name);
        removed.push(name);
      }
    }

    this.previousToolNames = newToolNames;
    this.specHash = loader.getSpecHash();
    this.lastUpdate = new Date().toISOString();
    this.loaded = true;
    this.syncFailed = false;
    this.lastError = undefined;

    const event: ToolsUpdatedEvent = { added, removed, updated };
    this.notify('toolsUpdated', event);

    // Emit catalog_changed for connected clients
    if (added.length > 0 || removed.length > 0) {
      this.notify('catalogChanged', {
        version: this.specHash,
        addedActions: added,
        removedActions: removed,
      });
    }
  }

  /**
   * Record a failure and tell the `error` listeners, if there are any. Without a listener the
   * failure is kept for `getStats()`; it is never raised from here.
   */
  private reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    if (this.listenerCount('error') > 0) {
      this.notify('error', this.lastError);
    }
  }

  /**
   * Emit an event. A listener that throws does not stop the source.
   */
  private notify(event: string, ...args: unknown[]): void {
    if (event === 'error' && this.listenerCount('error') === 0) return;
    try {
      this.emit(event, ...args);
    } catch {
      // A failing listener is the listener's failure
    }
  }

  /**
   * Get the set of tool names managed by this source.
   */
  getToolNames(): Set<string> {
    return new Set(this.previousToolNames);
  }

  /**
   * Get source statistics.
   */
  getStats(): OpenApiSourceStats {
    const failing = this.syncFailed || this.pollFailing;
    return {
      toolCount: this.previousToolNames.size,
      lastUpdate: this.lastUpdate,
      specHash: this.specHash,
      pollHealth: failing ? 'unhealthy' : this.loaded ? 'healthy' : 'unknown',
      ...(this.lastError && { lastError: this.lastError.message }),
    };
  }

  /**
   * Get the source name.
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Dispose the source and release resources.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.poller) {
      this.poller.dispose();
      this.poller = null;
    }
    this.removeAllListeners();
  }
}
