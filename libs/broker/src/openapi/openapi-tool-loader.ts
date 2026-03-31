/**
 * OpenAPI Tool Loader
 *
 * Converts OpenAPI specifications into Enclave ToolDefinitions.
 * Uses mcp-from-openapi as an optional peer dependency.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolContext } from '../tool-registry';

/**
 * Options for the OpenAPI tool loader.
 */
export interface LoaderOptions {
  /** Base URL for the upstream API */
  baseUrl?: string;
  /** Additional headers for API requests */
  headers?: Record<string, string>;
  /** Custom naming strategy for tool names */
  namingStrategy?: (method: string, path: string, operationId?: string) => string;
  /** Only include these operation IDs */
  includeOperations?: string[];
  /** Exclude these operation IDs */
  excludeOperations?: string[];
  /** Default timeout per API call in ms @default 30000 */
  perToolDeadlineMs?: number;
}

/**
 * Authentication configuration for upstream API requests.
 */
export interface UpstreamAuth {
  type: 'bearer' | 'api-key' | 'basic';
  token?: string;
  header?: string;
}

/**
 * Represents a parsed OpenAPI operation.
 */
interface ParsedOperation {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  deprecated?: boolean;
}

/**
 * Converts OpenAPI specs into Enclave ToolDefinitions.
 */
export class OpenApiToolLoader {
  private tools: ToolDefinition[] = [];
  private toolNames: Set<string> = new Set();
  private specHash: string;
  private readonly options: LoaderOptions;
  private readonly auth?: UpstreamAuth;

  private constructor(
    spec: Record<string, unknown>,
    options: LoaderOptions = {},
    auth?: UpstreamAuth,
  ) {
    this.options = options;
    this.auth = auth;
    this.specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    this.loadFromSpec(spec);
  }

  /**
   * Create a loader from a URL.
   */
  static async fromURL(url: string, options?: LoaderOptions, auth?: UpstreamAuth): Promise<OpenApiToolLoader> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${url}: ${response.status}`);
    }
    const spec = (await response.json()) as Record<string, unknown>;
    return new OpenApiToolLoader(spec, { ...options, baseUrl: options?.baseUrl ?? new URL(url).origin }, auth);
  }

  /**
   * Create a loader from a spec object.
   */
  static async fromSpec(
    spec: Record<string, unknown>,
    options?: LoaderOptions,
    auth?: UpstreamAuth,
  ): Promise<OpenApiToolLoader> {
    return new OpenApiToolLoader(spec, options, auth);
  }

  /**
   * Get all loaded tool definitions.
   */
  getTools(): ToolDefinition[] {
    return [...this.tools];
  }

  /**
   * Get all tool names.
   */
  getToolNames(): Set<string> {
    return new Set(this.toolNames);
  }

  /**
   * Get the hash of the loaded spec.
   */
  getSpecHash(): string {
    return this.specHash;
  }

  /**
   * Parse the OpenAPI spec and generate tool definitions.
   */
  private loadFromSpec(spec: Record<string, unknown>): void {
    const paths = spec['paths'] as Record<string, Record<string, unknown>> | undefined;
    if (!paths) return;

    const baseUrl = this.options.baseUrl ?? '';
    const operations = this.extractOperations(paths);

    for (const op of operations) {
      // Apply filters
      if (this.options.includeOperations && !this.options.includeOperations.includes(op.operationId)) {
        continue;
      }
      if (this.options.excludeOperations && this.options.excludeOperations.includes(op.operationId)) {
        continue;
      }

      const toolName = this.options.namingStrategy
        ? this.options.namingStrategy(op.method, op.path, op.operationId)
        : op.operationId || `${op.method}_${op.path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const argsSchema = this.buildArgsSchema(op);
      const timeout = this.options.perToolDeadlineMs ?? 30000;

      const tool: ToolDefinition = {
        name: toolName,
        description: op.summary || op.description || `${op.method.toUpperCase()} ${op.path}`,
        argsSchema,
        config: {
          timeout,
        },
        handler: this.createHandler(op, baseUrl),
      };

      this.tools.push(tool);
      this.toolNames.add(toolName);
    }
  }

  /**
   * Extract operations from OpenAPI paths.
   */
  private extractOperations(paths: Record<string, Record<string, unknown>>): ParsedOperation[] {
    const operations: ParsedOperation[] = [];
    const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const method of httpMethods) {
        const operation = pathItem[method] as Record<string, unknown> | undefined;
        if (!operation) continue;

        const operationId = (operation['operationId'] as string) || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
        operations.push({
          operationId,
          method,
          path,
          summary: operation['summary'] as string | undefined,
          description: operation['description'] as string | undefined,
          parameters: operation['parameters'] as ParsedOperation['parameters'],
          requestBody: operation['requestBody'] as ParsedOperation['requestBody'],
          deprecated: operation['deprecated'] as boolean | undefined,
        });
      }
    }

    return operations;
  }

  /**
   * Build a Zod args schema from an OpenAPI operation.
   */
  private buildArgsSchema(op: ParsedOperation): z.ZodType {
    const shape: Record<string, z.ZodType> = {};

    // Add parameters
    if (op.parameters) {
      for (const param of op.parameters) {
        shape[param.name] = param.required ? z.string() : z.string().optional();
      }
    }

    // Add request body as 'body' parameter
    if (op.requestBody) {
      shape['body'] = op.requestBody.required
        ? z.record(z.string(), z.unknown())
        : z.record(z.string(), z.unknown()).optional();
    }

    return Object.keys(shape).length > 0 ? z.object(shape) : z.record(z.string(), z.unknown());
  }

  /**
   * Create a handler function for an OpenAPI operation.
   */
  private createHandler(op: ParsedOperation, baseUrl: string): ToolDefinition['handler'] {
    const auth = this.auth;
    const headers = this.options.headers ?? {};

    return async (args: unknown, context: ToolContext): Promise<unknown> => {
      const params = args as Record<string, unknown>;

      // Build URL with path parameters
      let url = `${baseUrl}${op.path}`;
      const queryParams: Record<string, string> = {};

      if (op.parameters) {
        for (const param of op.parameters) {
          const value = params[param.name];
          if (value === undefined) continue;

          if (param.in === 'path') {
            url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)));
          } else if (param.in === 'query') {
            queryParams[param.name] = String(value);
          }
        }
      }

      // Append query parameters
      const queryString = new URLSearchParams(queryParams).toString();
      if (queryString) {
        url += `?${queryString}`;
      }

      // Build request headers
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };

      // Add auth headers
      if (auth) {
        switch (auth.type) {
          case 'bearer':
            if (auth.token) requestHeaders['Authorization'] = `Bearer ${auth.token}`;
            break;
          case 'api-key':
            if (auth.token) requestHeaders[auth.header ?? 'X-API-Key'] = auth.token;
            break;
          case 'basic':
            if (auth.token) requestHeaders['Authorization'] = `Basic ${auth.token}`;
            break;
        }
      }

      // Add header parameters
      if (op.parameters) {
        for (const param of op.parameters) {
          if (param.in === 'header' && params[param.name] !== undefined) {
            requestHeaders[param.name] = String(params[param.name]);
          }
        }
      }

      // Build fetch options
      const fetchOptions: RequestInit = {
        method: op.method.toUpperCase(),
        headers: requestHeaders,
        signal: context.signal,
      };

      // Add body for methods that support it
      if (['post', 'put', 'patch'].includes(op.method) && params['body']) {
        fetchOptions.body = JSON.stringify(params['body']);
      }

      const response = await fetch(url, fetchOptions);
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        return response.json();
      }
      return response.text();
    };
  }
}
