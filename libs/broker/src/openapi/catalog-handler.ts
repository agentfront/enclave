/**
 * Catalog Handler
 *
 * HTTP handler for GET /code/actions endpoint.
 * Returns the current action catalog derived from OpenAPI sources.
 *
 * @packageDocumentation
 */

import type { ToolRegistry } from '../tool-registry';
import type { OpenApiSource } from './openapi-source';
import type { BrokerRequest, BrokerResponse } from '../http/types';

/**
 * Action descriptor in the catalog.
 */
export interface CatalogAction {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  service: string;
  tags?: string[];
  deprecated?: boolean;
}

/**
 * Service descriptor in the catalog.
 */
export interface CatalogService {
  name: string;
  specUrl: string;
  lastUpdated: string;
  actionCount: number;
}

/**
 * Full catalog response.
 */
export interface CatalogResponse {
  actions: CatalogAction[];
  services: CatalogService[];
  version: string;
}

/**
 * HTTP handler for the action catalog endpoint.
 */
export class CatalogHandler {
  private readonly toolRegistry: ToolRegistry;
  private readonly sources: OpenApiSource[];

  constructor(toolRegistry: ToolRegistry, sources: OpenApiSource[]) {
    this.toolRegistry = toolRegistry;
    this.sources = sources;
  }

  /**
   * Get route definitions for the catalog endpoint.
   */
  getRoutes(): Array<{
    method: string;
    path: string;
    handler: (req: BrokerRequest, res: BrokerResponse) => Promise<void>;
  }> {
    return [
      {
        method: 'GET',
        path: '/code/actions',
        handler: this.handleGetActions.bind(this),
      },
    ];
  }

  /**
   * Handle GET /code/actions request.
   */
  private async handleGetActions(_req: BrokerRequest, res: BrokerResponse): Promise<void> {
    const catalog = this.buildCatalog();
    res.status(200);
    res.json(catalog);
  }

  /**
   * Build the full catalog response.
   */
  buildCatalog(): CatalogResponse {
    const actions: CatalogAction[] = [];
    const services: CatalogService[] = [];

    // Build service info from OpenAPI sources
    for (const source of this.sources) {
      const stats = source.getStats();
      services.push({
        name: source.getName(),
        specUrl: '', // URL is internal to the source
        lastUpdated: stats.lastUpdate,
        actionCount: stats.toolCount,
      });
    }

    // Build actions from tool registry
    const toolNames = this.toolRegistry.list();
    for (const name of toolNames) {
      const tool = this.toolRegistry.get(name);
      if (!tool) continue;

      actions.push({
        name: tool.name,
        description: tool.description,
        service: this.findServiceForTool(name),
      });
    }

    // Version is a hash of all source hashes
    const versionParts = this.sources.map((s) => s.getStats().specHash).join(':');
    const version = versionParts || 'empty';

    return { actions, services, version };
  }

  /**
   * Find which service a tool belongs to.
   */
  private findServiceForTool(toolName: string): string {
    for (const source of this.sources) {
      const stats = source.getStats();
      if (stats.toolCount > 0) {
        return source.getName();
      }
    }
    return 'default';
  }
}
