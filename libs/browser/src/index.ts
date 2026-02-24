/**
 * @enclave-vm/browser - Browser-based Safe AgentScript Execution
 *
 * Provides sandboxed execution for AgentScript code in the browser using
 * double iframe isolation:
 * - Outer iframe: Security barrier with validation, rate limiting, pattern detection
 * - Inner iframe: User code execution with safe runtime and frozen globals
 *
 * Both iframes use sandbox="allow-scripts" (no allow-same-origin) with CSP
 * meta tags that block eval, Function constructor, and all network access.
 *
 * @packageDocumentation
 */

// Main BrowserEnclave class
export { BrowserEnclave } from './browser-enclave';

// Types
export type {
  BrowserEnclaveOptions,
  SecurityLevel,
  AstPreset,
  ToolHandler,
  ExecutionResult,
  ExecutionError,
  ExecutionStats,
  SecurityLevelConfig,
  SecureProxyLevelConfig,
  DoubleIframeConfig,
  ParentValidationConfig,
  SuspiciousPattern,
  SerializableSuspiciousPattern,
  OperationHistory,
  SerializedIframeConfig,
} from './types';

// Security level configurations
export { SECURITY_LEVEL_CONFIGS, DEFAULT_DOUBLE_IFRAME_CONFIG } from './types';

// Iframe adapter (for advanced usage)
export { IframeAdapter } from './adapters/iframe-adapter';
export type { IframeExecutionContext } from './adapters/iframe-adapter';

// Protocol types (for advanced usage)
export type {
  HostToOuterMessage,
  OuterToHostMessage,
  InnerToOuterMessage,
  OuterToInnerMessage,
  ToolCallMessage,
  ResultMessage,
  ConsoleMessage,
  ReadyMessage,
  SerializedError,
  WorkerExecutionStats,
} from './adapters/iframe-protocol';
export {
  isEnclaveMessage,
  isToolCallMessage,
  isResultMessage,
  isConsoleMessage,
  isReadyMessage,
  generateId,
} from './adapters/iframe-protocol';

// Utilities
export { utf8ByteLength } from './utils/utf8-byte-length';
