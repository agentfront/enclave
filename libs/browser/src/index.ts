/**
 * @enclave-vm/browser - Browser-based Safe AgentScript Execution
 *
 * Provides sandboxed execution for AgentScript code in the browser using
 * double iframe isolation:
 * - Outer iframe: Security barrier with validation, rate limiting, pattern detection
 * - Inner iframe: User code execution with safe runtime and frozen globals
 *
 * Both iframes use sandbox="allow-scripts" (no allow-same-origin) with CSP
 * meta tags that block eval and the Function constructor, allow no script but
 * the one this package wrote into each document, and allow no request source
 * the policy governs. The names that open a connection the policy does not
 * govern are removed from the inner frame, and its document is closed: it
 * holds nothing and nothing can be added to it.
 *
 * What keeps a script from the document it runs in is the validator; a script
 * that never yields is ended at the timeout only where the browser runs the
 * frames in another process than the page. See the security architecture page.
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
  CallToolOptions,
  ToolCallResult,
  ToolCallErrorInfo,
  ToolNamespaces,
  NormalizedToolNamespace,
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
