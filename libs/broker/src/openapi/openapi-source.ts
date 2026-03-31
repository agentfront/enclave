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
  private lastUpdate: string = '';
  private specHash: string = '';
  private health: SourceHealthStatus = 'unknown';
  private disposed = false;

  constructor(toolRegistry: ToolRegistry, config: OpenApiSourceConfig) {
    super();
    this.toolRegistry = toolRegistry;
    this.config = config;
  }

  /**
   * Initial load + start polling.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('OpenApiSource is disposed');

    // Initial load
    await this.refresh();

    // Start polling
    this.poller = new OpenApiSpecPoller(this.config);

    this.poller.on('changed', async (spec: string) => {
      try {
        const parsed = JSON.parse(spec) as Record<string, unknown>;
        await this.syncTools(parsed);
        this.health = 'healthy';
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.poller.on('unhealthy', (failures: number) => {
      this.health = 'unhealthy';
      this.emit('unhealthy', failures);
    });

    this.poller.on('recovered', () => {
      this.health = 'healthy';
      this.emit('recovered');
    });

    this.poller.on('error', (error: Error) => {
      this.emit('error', error);
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
   */
  async refresh(): Promise<void> {
    if (this.disposed) throw new Error('OpenApiSource is disposed');

    const loader = await OpenApiToolLoader.fromURL(
      this.config.url,
      {
        ...this.config.loaderOptions,
        baseUrl: this.config.baseUrl,
      },
      this.config.auth,
    );

    const tools = loader.getTools();
    const newToolNames = loader.getToolNames();

    // Register all tools
    for (const tool of tools) {
      if (this.toolRegistry.has(tool.name)) {
        this.toolRegistry.replace(tool);
      } else {
        this.toolRegistry.register(tool);
      }
    }

    // Remove tools that no longer exist
    for (const name of this.previousToolNames) {
      if (!newToolNames.has(name)) {
        this.toolRegistry.unregister(name);
      }
    }

    this.previousToolNames = newToolNames;
    this.specHash = loader.getSpecHash();
    this.lastUpdate = new Date().toISOString();
    this.health = 'healthy';

    this.emit('toolsUpdated', {
      added: [...newToolNames].filter((n) => !this.previousToolNames.has(n)),
      removed: [],
      updated: [...newToolNames],
    });
  }

  /**
   * Sync tools based on a new spec (diff-based update).
   */
  private async syncTools(spec: Record<string, unknown>): Promise<void> {
    const loader = await OpenApiToolLoader.fromSpec(spec, {
      ...this.config.loaderOptions,
      baseUrl: this.config.baseUrl,
    }, this.config.auth);

    const newTools = loader.getTools();
    const newToolNames = loader.getToolNames();

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    // Find added and updated tools
    for (const tool of newTools) {
      if (this.previousToolNames.has(tool.name)) {
        this.toolRegistry.replace(tool);
        updated.push(tool.name);
      } else {
        this.toolRegistry.register(tool);
        added.push(tool.name);
      }
    }

    // Find removed tools
    for (const name of this.previousToolNames) {
      if (!newToolNames.has(name)) {
        this.toolRegistry.unregister(name);
        removed.push(name);
      }
    }

    this.previousToolNames = newToolNames;
    this.specHash = loader.getSpecHash();
    this.lastUpdate = new Date().toISOString();

    const event: ToolsUpdatedEvent = { added, removed, updated };
    this.emit('toolsUpdated', event);

    // Emit catalog_changed for connected clients
    if (added.length > 0 || removed.length > 0) {
      this.emit('catalogChanged', {
        version: this.specHash,
        addedActions: added,
        removedActions: removed,
      });
    }
  }

  /**
   * Get source statistics.
   */
  getStats(): OpenApiSourceStats {
    return {
      toolCount: this.previousToolNames.size,
      lastUpdate: this.lastUpdate,
      specHash: this.specHash,
      pollHealth: this.health,
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
