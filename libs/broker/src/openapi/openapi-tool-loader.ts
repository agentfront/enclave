/**
 * OpenAPI Tool Loader
 *
 * Converts OpenAPI specifications into Enclave ToolDefinitions.
 * Uses mcp-from-openapi as an optional peer dependency.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { sha256Hex } from './hash-utils';
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
  /** Source/service name prefix for default tool names (prevents collisions across sources) */
  sourceName?: string;
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

  private constructor(spec: Record<string, unknown>, hash: string, options: LoaderOptions = {}, auth?: UpstreamAuth) {
    this.options = options;
    this.auth = auth;
    this.specHash = hash;
    this.loadFromSpec(spec);
  }

  /**
   * Create a loader from a URL.
   */
  static async fromURL(url: string, options?: LoaderOptions, auth?: UpstreamAuth): Promise<OpenApiToolLoader> {
    const headers: Record<string, string> = { ...options?.headers };
    if (auth) {
      switch (auth.type) {
        case 'bearer':
          if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
          break;
        case 'api-key':
          if (auth.token) headers[auth.header ?? 'X-API-Key'] = auth.token;
          break;
        case 'basic':
          if (auth.token) headers['Authorization'] = `Basic ${auth.token}`;
          break;
      }
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${url}: ${response.status}`);
    }
    const spec = (await response.json()) as Record<string, unknown>;
    const hash = await sha256Hex(JSON.stringify(spec));

    // Resolve baseUrl: explicit option > spec.servers[0].url > fetch origin
    let resolvedBaseUrl = options?.baseUrl;
    if (!resolvedBaseUrl) {
      const servers = spec['servers'] as Array<{ url?: string }> | undefined;
      if (servers?.[0]?.url) {
        try {
          resolvedBaseUrl = new URL(servers[0].url, url).origin + new URL(servers[0].url, url).pathname;
        } catch {
          resolvedBaseUrl = new URL(url).origin;
        }
      } else {
        resolvedBaseUrl = new URL(url).origin;
      }
    }

    return new OpenApiToolLoader(spec, hash, { ...options, baseUrl: resolvedBaseUrl }, auth);
  }

  /**
   * Create a loader from a spec object.
   */
  static async fromSpec(
    spec: Record<string, unknown>,
    options?: LoaderOptions,
    auth?: UpstreamAuth,
  ): Promise<OpenApiToolLoader> {
    const hash = await sha256Hex(JSON.stringify(spec));

    // Resolve baseUrl from spec.servers when not explicitly provided
    let resolvedBaseUrl = options?.baseUrl;
    if (!resolvedBaseUrl) {
      const servers = spec['servers'] as Array<{ url?: string }> | undefined;
      if (servers?.[0]?.url) {
        try {
          const serverUrl = new URL(servers[0].url);
          resolvedBaseUrl = serverUrl.origin + serverUrl.pathname;
        } catch {
          throw new Error(
            `Cannot resolve relative server URL "${servers[0].url}" without a source URL. Use fromURL() or provide an explicit baseUrl option.`,
          );
        }
      }
    }

    return new OpenApiToolLoader(
      spec,
      hash,
      resolvedBaseUrl ? { ...options, baseUrl: resolvedBaseUrl } : options,
      auth,
    );
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

      const baseName = op.operationId || `${op.method}_${op.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const toolName = this.options.namingStrategy
        ? this.options.namingStrategy(op.method, op.path, op.operationId)
        : this.options.sourceName
          ? `${this.options.sourceName}_${baseName}`
          : baseName;

      const { schema: argsSchema, bodyMediaType } = this.buildArgsSchema(op);
      const timeout = this.options.perToolDeadlineMs ?? 30000;

      const tool: ToolDefinition = {
        name: toolName,
        description: op.summary || op.description || `${op.method.toUpperCase()} ${op.path}`,
        argsSchema,
        config: {
          timeout,
        },
        handler: this.createHandler(op, baseUrl, bodyMediaType),
      };

      if (this.toolNames.has(toolName)) {
        throw new Error(
          `Duplicate tool name "${toolName}" generated for ${op.method.toUpperCase()} ${op.path}` +
            ` (operationId: ${op.operationId}). Use a custom namingStrategy or sourceName to disambiguate.`,
        );
      }

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
      const pathParams = (pathItem['parameters'] as ParsedOperation['parameters']) ?? [];

      for (const method of httpMethods) {
        const operation = pathItem[method] as Record<string, unknown> | undefined;
        if (!operation) continue;

        const operationId = (operation['operationId'] as string) || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

        // Merge path-level and operation-level parameters; operation-level overrides by (name, in)
        const opParams = (operation['parameters'] as ParsedOperation['parameters']) ?? [];
        const merged = this.mergeParameters(pathParams, opParams);

        operations.push({
          operationId,
          method,
          path,
          summary: operation['summary'] as string | undefined,
          description: operation['description'] as string | undefined,
          parameters: merged.length > 0 ? merged : undefined,
          requestBody: operation['requestBody'] as ParsedOperation['requestBody'],
          deprecated: operation['deprecated'] as boolean | undefined,
        });
      }
    }

    return operations;
  }

  /**
   * Merge path-level and operation-level parameters, de-duplicating by (name, in).
   * Operation-level entries override path-level ones.
   */
  private mergeParameters(
    pathParams: NonNullable<ParsedOperation['parameters']>,
    opParams: NonNullable<ParsedOperation['parameters']>,
  ): NonNullable<ParsedOperation['parameters']> {
    const seen = new Map<string, (typeof opParams)[0]>();
    for (const p of pathParams) {
      seen.set(`${p.in}:${p.name}`, p);
    }
    for (const p of opParams) {
      seen.set(`${p.in}:${p.name}`, p);
    }
    return [...seen.values()];
  }

  /**
   * Build a Zod args schema from an OpenAPI operation.
   */
  private buildArgsSchema(op: ParsedOperation): { schema: z.ZodType; bodyMediaType?: string } {
    const shape: Record<string, z.ZodType> = {};
    let bodyMediaType: string | undefined;

    // Add parameters with OpenAPI type mapping
    if (op.parameters) {
      for (const param of op.parameters) {
        const baseType = this.mapOpenApiType(param.schema);
        shape[param.name] = param.required ? baseType : baseType.optional();
      }
    }

    // Add request body as 'body' parameter, inspecting content media type
    if (op.requestBody?.content) {
      const { schema: bodySchema, mediaType } = this.buildBodySchema(op.requestBody.content);
      shape['body'] = op.requestBody.required ? bodySchema : bodySchema.optional();
      bodyMediaType = mediaType;
    } else if (op.requestBody) {
      const fallback = z.record(z.string(), z.unknown());
      shape['body'] = op.requestBody.required ? fallback : fallback.optional();
    }

    const schema = Object.keys(shape).length > 0 ? z.object(shape) : z.record(z.string(), z.unknown());
    return { schema, bodyMediaType };
  }

  /**
   * Serialize a parameter value for use in URLs/headers.
   * Arrays and objects are JSON-stringified; primitives use String().
   */
  private static serializeParam(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /**
   * Check if a content-type string represents a JSON media type.
   * Matches 'application/json' and structured syntax suffix '+json' (RFC 6838).
   */
  private static isJsonContentType(contentType: string): boolean {
    return contentType.includes('application/json') || contentType.includes('+json');
  }

  /**
   * Map an OpenAPI schema type to the corresponding Zod type.
   */
  private mapOpenApiType(schema?: Record<string, unknown>): z.ZodType {
    if (!schema || !schema['type']) return z.unknown();

    const type = schema['type'] as string;
    const enumValues = schema['enum'] as string[] | undefined;

    switch (type) {
      case 'integer':
        return z.number().int();
      case 'number':
        return z.number();
      case 'boolean':
        return z.boolean();
      case 'array':
        return z.array(this.mapOpenApiType(schema['items'] as Record<string, unknown> | undefined));
      case 'object':
        return z.record(z.string(), z.unknown());
      case 'string':
        if (enumValues && enumValues.length > 0) {
          return z.enum(enumValues as [string, ...string[]]);
        }
        return z.string();
      default:
        return z.unknown();
    }
  }

  /**
   * Build a Zod schema for the request body based on the media type.
   * Returns both the schema and the chosen media type for correct serialization.
   */
  private buildBodySchema(content: Record<string, { schema?: Record<string, unknown> }>): {
    schema: z.ZodType;
    mediaType: string;
  } {
    // Prefer JSON media types
    const jsonKey = Object.keys(content).find((k) => k.includes('json'));
    if (jsonKey) {
      const schema = content[jsonKey].schema;
      if (schema) return { schema: this.mapOpenApiType(schema), mediaType: jsonKey };
      return { schema: z.record(z.string(), z.unknown()), mediaType: jsonKey };
    }

    // Form data
    if (content['application/x-www-form-urlencoded']) {
      return { schema: z.record(z.string(), z.unknown()), mediaType: 'application/x-www-form-urlencoded' };
    }
    if (content['multipart/form-data']) {
      return { schema: z.record(z.string(), z.unknown()), mediaType: 'multipart/form-data' };
    }

    // Plain text
    const textKey = Object.keys(content).find((k) => k.startsWith('text/'));
    if (textKey) {
      return { schema: z.string(), mediaType: textKey };
    }

    // Fallback
    return { schema: z.record(z.string(), z.unknown()), mediaType: 'application/json' };
  }

  /**
   * Create a handler function for an OpenAPI operation.
   */
  private createHandler(op: ParsedOperation, baseUrl: string, bodyMediaType?: string): ToolDefinition['handler'] {
    const auth = this.auth;
    const headers = this.options.headers ?? {};

    return async (args: unknown, context: ToolContext): Promise<unknown> => {
      const params = args as Record<string, unknown>;

      // Build URL with path parameters
      const normalizedBase = baseUrl.replace(/\/+$/, '');
      let url = `${normalizedBase}${op.path.startsWith('/') ? op.path : '/' + op.path}`;
      const queryParams: Record<string, string> = {};

      if (op.parameters) {
        for (const param of op.parameters) {
          const value = params[param.name];
          if (value === undefined) continue;

          if (param.in === 'path') {
            url = url.replace(`{${param.name}}`, encodeURIComponent(OpenApiToolLoader.serializeParam(value)));
          } else if (param.in === 'query') {
            queryParams[param.name] = OpenApiToolLoader.serializeParam(value);
          }
        }
      }

      // Append query parameters
      const queryString = new URLSearchParams(queryParams).toString();
      if (queryString) {
        url += `?${queryString}`;
      }

      // Build request headers (only set Content-Type for methods with a body)
      const hasBody =
        (['post', 'put', 'patch', 'delete'].includes(op.method) || op.requestBody != null) &&
        Object.prototype.hasOwnProperty.call(params, 'body') &&
        params['body'] != null;
      const resolvedMediaType = bodyMediaType ?? 'application/json';
      const isMultipart = resolvedMediaType === 'multipart/form-data';
      const requestHeaders: Record<string, string> = {
        // Omit Content-Type for multipart/form-data to let the runtime set the boundary
        ...(hasBody && !isMultipart && { 'Content-Type': resolvedMediaType }),
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

      // Add header parameters (skip protected auth headers to prevent credential overwrite)
      const protectedHeaders = new Set<string>();
      if (auth) {
        if (auth.type === 'bearer' || auth.type === 'basic') protectedHeaders.add('authorization');
        if (auth.type === 'api-key') protectedHeaders.add((auth.header ?? 'X-API-Key').toLowerCase());
      }
      if (op.parameters) {
        for (const param of op.parameters) {
          if (param.in === 'header' && params[param.name] !== undefined) {
            if (protectedHeaders.has(param.name.toLowerCase())) continue;
            requestHeaders[param.name] = OpenApiToolLoader.serializeParam(params[param.name]);
          }
        }
      }

      // Build fetch options
      const fetchOptions: RequestInit = {
        method: op.method.toUpperCase(),
        headers: requestHeaders,
        signal: context.signal,
      };

      if (hasBody) {
        if (OpenApiToolLoader.isJsonContentType(resolvedMediaType)) {
          fetchOptions.body = JSON.stringify(params['body']);
        } else if (resolvedMediaType === 'application/x-www-form-urlencoded') {
          fetchOptions.body = new URLSearchParams(params['body'] as Record<string, string>).toString();
        } else if (resolvedMediaType === 'multipart/form-data') {
          const formData = new FormData();
          const bodyObj = params['body'] as Record<string, unknown>;
          for (const [key, value] of Object.entries(bodyObj)) {
            formData.append(key, value instanceof Blob ? value : String(value));
          }
          fetchOptions.body = formData;
        } else if (resolvedMediaType.startsWith('text/')) {
          fetchOptions.body = String(params['body']);
        } else {
          fetchOptions.body = JSON.stringify(params['body']);
        }
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        let body: string;
        try {
          body = OpenApiToolLoader.isJsonContentType(contentType)
            ? JSON.stringify(await response.json())
            : await response.text();
        } catch {
          body = '';
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (OpenApiToolLoader.isJsonContentType(contentType)) {
        return response.json();
      }
      return response.text();
    };
  }
}
