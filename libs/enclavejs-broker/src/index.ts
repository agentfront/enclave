/**
 * @enclavejs/broker
 *
 * Tool broker and session management for the EnclaveJS streaming runtime.
 *
 * @packageDocumentation
 */

// Main Broker
export { Broker, createBroker } from './broker';
export type { BrokerConfig, ExecuteOptions } from './broker';

// Tool Registry
export { ToolRegistry, createToolRegistry } from './tool-registry';
export type {
  ToolDefinition,
  ToolHandler,
  ToolContext,
  ToolValidationResult,
  ToolExecutionResult,
} from './tool-registry';

// Broker Session
export { BrokerSession, createBrokerSession } from './broker-session';
export type { BrokerSessionConfig } from './broker-session';

// Session Manager
export { SessionManager, createSessionManager } from './session-manager';
export type { SessionManagerConfig, SessionInfo, CreateSessionResult } from './session-manager';

// HTTP API
export { SessionHandler, createSessionHandler, registerExpressRoutes, createExpressRouter } from './http';
export type {
  SessionHandlerConfig,
  RouteHandler,
  BrokerRequest,
  BrokerResponse,
  CreateSessionRequest,
  SessionInfoResponse,
  ListSessionsResponse,
  ErrorResponse,
  StreamOptions,
} from './http';
