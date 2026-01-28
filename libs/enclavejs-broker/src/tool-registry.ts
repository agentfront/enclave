/**
 * Tool Registry
 *
 * Manages tool definitions with Zod validation for the broker.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { ToolConfig } from '@enclave-vm/types';

/**
 * Tool definition for registration
 */
export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  /**
   * Tool name (must be unique)
   */
  name: string;

  /**
   * Tool description for documentation
   */
  description?: string;

  /**
   * Zod schema for argument validation
   */
  argsSchema?: z.ZodType<TArgs>;

  /**
   * Tool handler function
   */
  handler: ToolHandler<TArgs, TResult>;

  /**
   * Tool configuration
   */
  config?: ToolConfig;

  /**
   * Required secrets (keys from secret store)
   */
  secrets?: string[];
}

/**
 * Tool handler function type
 */
export type ToolHandler<TArgs = unknown, TResult = unknown> = (args: TArgs, context: ToolContext) => Promise<TResult>;

/**
 * Context provided to tool handlers
 */
export interface ToolContext {
  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Call ID for this invocation
   */
  callId: string;

  /**
   * Resolved secrets
   */
  secrets: Record<string, string>;

  /**
   * Abort signal for cancellation
   */
  signal: AbortSignal;
}

/**
 * Registered tool with validation
 */
interface RegisteredTool {
  definition: ToolDefinition;
  argsSchema: z.ZodType;
}

/**
 * Tool validation result
 */
export interface ToolValidationResult {
  success: boolean;
  error?: string;
  validatedArgs?: unknown;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  value?: T;
  error?: {
    code: string;
    message: string;
    data?: Record<string, unknown>;
  };
  durationMs: number;
}

/**
 * Tool Registry
 *
 * Manages tool definitions and provides:
 * - Tool registration with Zod schema validation
 * - Argument validation before execution
 * - Tool invocation with context
 */
export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;
  private readonly secretStore: Map<string, string>;

  constructor() {
    this.tools = new Map();
    this.secretStore = new Map();
  }

  /**
   * Register a tool
   *
   * @throws Error if tool with same name already exists
   */
  register<TArgs = unknown, TResult = unknown>(definition: ToolDefinition<TArgs, TResult>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }

    const argsSchema = definition.argsSchema ?? z.record(z.string(), z.unknown());

    this.tools.set(definition.name, {
      definition: definition as ToolDefinition,
      argsSchema,
    });
  }

  /**
   * Unregister a tool
   *
   * @returns true if tool was removed, false if not found
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool definition
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  /**
   * List all registered tool names
   */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool configurations for all registered tools
   */
  getConfigs(): Record<string, ToolConfig> {
    const configs: Record<string, ToolConfig> = {};
    for (const [name, tool] of this.tools) {
      if (tool.definition.config) {
        configs[name] = tool.definition.config;
      }
    }
    return configs;
  }

  /**
   * Validate tool arguments
   */
  validate(name: string, args: unknown): ToolValidationResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    const result = tool.argsSchema.safeParse(args);
    if (!result.success) {
      return {
        success: false,
        error: `Invalid arguments: ${result.error.message}`,
      };
    }

    return {
      success: true,
      validatedArgs: result.data,
    };
  }

  /**
   * Set a secret value
   */
  setSecret(key: string, value: string): void {
    this.secretStore.set(key, value);
  }

  /**
   * Remove a secret
   */
  removeSecret(key: string): boolean {
    return this.secretStore.delete(key);
  }

  /**
   * Check if a secret exists
   */
  hasSecret(key: string): boolean {
    return this.secretStore.has(key);
  }

  /**
   * Get required secrets for a tool
   */
  getRequiredSecrets(name: string): string[] {
    const tool = this.tools.get(name);
    return tool?.definition.secrets ?? [];
  }

  /**
   * Resolve secrets for a tool
   *
   * @throws Error if required secret is missing
   */
  private resolveSecrets(name: string): Record<string, string> {
    const requiredSecrets = this.getRequiredSecrets(name);
    const resolved: Record<string, string> = {};

    for (const key of requiredSecrets) {
      const value = this.secretStore.get(key);
      if (value === undefined) {
        throw new Error(`Missing required secret "${key}" for tool "${name}"`);
      }
      resolved[key] = value;
    }

    return resolved;
  }

  /**
   * Execute a tool
   */
  async execute<T = unknown>(
    name: string,
    args: unknown,
    context: Omit<ToolContext, 'secrets'>,
  ): Promise<ToolExecutionResult<T>> {
    const startTime = Date.now();

    // Validate tool exists
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_TOOL',
          message: `Unknown tool: ${name}`,
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Validate arguments
    const validation = this.validate(name, args);
    if (!validation.success) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: validation.error!,
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Resolve secrets
    let secrets: Record<string, string>;
    try {
      secrets = this.resolveSecrets(name);
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SECRET_ERROR',
          message: error instanceof Error ? error.message : 'Failed to resolve secrets',
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Execute handler
    try {
      const result = await tool.definition.handler(validation.validatedArgs, {
        ...context,
        secrets,
      });

      return {
        success: true,
        value: result as T,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const err = error as Error & { code?: string };
      return {
        success: false,
        error: {
          code: err.code ?? 'EXECUTION_ERROR',
          message: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Clear all secrets
   */
  clearSecrets(): void {
    this.secretStore.clear();
  }

  /**
   * Get count of registered tools
   */
  get size(): number {
    return this.tools.size;
  }
}

/**
 * Create a new tool registry
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
