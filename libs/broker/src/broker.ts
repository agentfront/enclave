/**
 * Broker
 *
 * Main entry point for the EnclaveJS tool broker.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits } from '@enclave-vm/types';
import type { CreateEnclaveOptions, SessionFinalResult } from '@enclave-vm/core';
import { ToolRegistry, createToolRegistry } from './tool-registry';
import type { ToolDefinition } from './tool-registry';
import { SessionManager, createSessionManager } from './session-manager';
import type { SessionManagerConfig, SessionInfo } from './session-manager';
import { BrokerSession } from './broker-session';
import type { BrokerSessionConfig } from './broker-session';

/**
 * Broker configuration
 */
export interface BrokerConfig {
  /**
   * Session manager configuration
   */
  sessions?: SessionManagerConfig;

  /**
   * Default Enclave configuration
   */
  enclave?: CreateEnclaveOptions;

  /**
   * Default session limits
   */
  limits?: Partial<SessionLimits>;
}

/**
 * Quick execution options
 */
export interface ExecuteOptions {
  /**
   * Session configuration overrides
   */
  session?: BrokerSessionConfig;

  /**
   * Event handler for streaming events
   */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Broker
 *
 * The main orchestrator for EnclaveJS streaming sessions.
 * Provides a simple API for:
 * - Registering tools with Zod validation
 * - Managing secrets securely
 * - Creating and managing sessions
 * - Executing code with tool access
 *
 * @example
 * ```typescript
 * const broker = new Broker();
 *
 * // Register a tool
 * broker.tool('greet', {
 *   argsSchema: z.object({ name: z.string() }),
 *   handler: async ({ name }) => `Hello, ${name}!`,
 * });
 *
 * // Execute code
 * const result = await broker.execute(`
 *   const greeting = await callTool('greet', { name: 'World' });
 *   return greeting;
 * `);
 *
 * console.log(result.value); // "Hello, World!"
 * ```
 */
export class Broker {
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionManager: SessionManager;
  private readonly config: BrokerConfig;
  private disposed = false;

  constructor(config: BrokerConfig = {}) {
    this.config = config;
    this.toolRegistry = createToolRegistry();
    this.sessionManager = createSessionManager(this.toolRegistry, {
      ...config.sessions,
      defaultSessionConfig: {
        limits: config.limits,
        enclaveConfig: config.enclave,
      },
    });
  }

  // ============================================================================
  // Tool Registration
  // ============================================================================

  /**
   * Register a tool with the broker
   *
   * @param name - Tool name
   * @param definition - Tool definition (handler, schema, secrets)
   *
   * @example
   * ```typescript
   * broker.tool('fetchUrl', {
   *   argsSchema: z.object({ url: z.string().url() }),
   *   secrets: ['API_KEY'],
   *   handler: async ({ url }, { secrets }) => {
   *     const response = await fetch(url, {
   *       headers: { Authorization: secrets.API_KEY },
   *     });
   *     return response.json();
   *   },
   * });
   * ```
   */
  tool<TArgs = unknown, TResult = unknown>(
    name: string,
    definition: Omit<ToolDefinition<TArgs, TResult>, 'name'>,
  ): this {
    this.toolRegistry.register({
      name,
      ...definition,
    });
    return this;
  }

  /**
   * Register multiple tools at once
   */
  tools(definitions: Record<string, Omit<ToolDefinition, 'name'>>): this {
    for (const [name, def] of Object.entries(definitions)) {
      this.tool(name, def);
    }
    return this;
  }

  /**
   * Check if a tool is registered
   */
  hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  /**
   * List all registered tool names
   */
  listTools(): string[] {
    return this.toolRegistry.list();
  }

  /**
   * Unregister a tool
   */
  removeTool(name: string): boolean {
    return this.toolRegistry.unregister(name);
  }

  // ============================================================================
  // Secret Management
  // ============================================================================

  /**
   * Set a secret value
   *
   * @param key - Secret key
   * @param value - Secret value
   *
   * @example
   * ```typescript
   * broker.secret('API_KEY', process.env.API_KEY!);
   * broker.secret('DATABASE_URL', process.env.DATABASE_URL!);
   * ```
   */
  secret(key: string, value: string): this {
    this.toolRegistry.setSecret(key, value);
    return this;
  }

  /**
   * Set multiple secrets at once
   */
  secrets(values: Record<string, string>): this {
    for (const [key, value] of Object.entries(values)) {
      this.secret(key, value);
    }
    return this;
  }

  /**
   * Check if a secret exists
   */
  hasSecret(key: string): boolean {
    return this.toolRegistry.hasSecret(key);
  }

  /**
   * Remove a secret
   */
  removeSecret(key: string): boolean {
    return this.toolRegistry.removeSecret(key);
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Create a new session
   *
   * @param config - Session configuration
   * @returns The created session
   *
   * @example
   * ```typescript
   * const session = broker.createSession({
   *   limits: { sessionTtlMs: 60000 },
   * });
   *
   * session.onEvent((event) => {
   *   console.log('Event:', event.type);
   * });
   *
   * const result = await session.execute('return await callTool("greet", { name: "World" })');
   * ```
   */
  createSession(config?: BrokerSessionConfig): BrokerSession {
    this.ensureNotDisposed();
    return this.sessionManager.create(config).session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: SessionId): BrokerSession | undefined {
    return this.sessionManager.get(sessionId);
  }

  /**
   * List all sessions
   */
  listSessions(): SessionInfo[] {
    return this.sessionManager.list();
  }

  /**
   * List active (non-terminal) sessions
   */
  listActiveSessions(): SessionInfo[] {
    return this.sessionManager.listActive();
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: SessionId, reason?: string): Promise<boolean> {
    return this.sessionManager.terminate(sessionId, reason);
  }

  // ============================================================================
  // Quick Execution
  // ============================================================================

  /**
   * Execute code and wait for result
   *
   * This is a convenience method that creates a session, executes code,
   * streams events, and returns the final result.
   *
   * @param code - Code to execute
   * @param options - Execution options
   * @returns Final execution result
   *
   * @example
   * ```typescript
   * const result = await broker.execute(`
   *   const data = await callTool('fetchData', { id: 123 });
   *   return data.processed;
   * `, {
   *   onEvent: (event) => console.log(event.type),
   * });
   *
   * if (result.success) {
   *   console.log('Result:', result.value);
   * }
   * ```
   */
  async execute(code: string, options: ExecuteOptions = {}): Promise<SessionFinalResult> {
    this.ensureNotDisposed();
    return this.sessionManager.executeAndWait(code, options.session, options.onEvent);
  }

  // ============================================================================
  // Statistics & Lifecycle
  // ============================================================================

  /**
   * Get broker statistics
   */
  stats(): {
    tools: number;
    activeSessions: number;
    totalSessions: number;
  } {
    return {
      tools: this.toolRegistry.size,
      activeSessions: this.sessionManager.activeCount,
      totalSessions: this.sessionManager.totalCount,
    };
  }

  /**
   * Clean up expired and completed sessions
   */
  cleanup(): number {
    return this.sessionManager.cleanup();
  }

  /**
   * Dispose of the broker and all resources
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.sessionManager.dispose();
    this.toolRegistry.clear();
    this.toolRegistry.clearSecrets();
  }

  /**
   * Check if broker is disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Ensure broker is not disposed
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Broker is disposed');
    }
  }
}

/**
 * Create a new broker instance
 */
export function createBroker(config?: BrokerConfig): Broker {
  return new Broker(config);
}
