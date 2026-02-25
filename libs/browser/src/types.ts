/**
 * Browser Enclave Types
 *
 * Configuration types for the browser-based sandbox using double iframe isolation.
 *
 * @packageDocumentation
 */

/**
 * Security levels (mirrored from @enclave-vm/core for browser independence)
 */
export type SecurityLevel = 'STRICT' | 'SECURE' | 'STANDARD' | 'PERMISSIVE';

/**
 * AST validation preset
 */
export type AstPreset = 'agentscript' | 'strict' | 'secure' | 'standard' | 'permissive';

/**
 * Tool call handler function
 */
export type ToolHandler = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Execution result from the browser sandbox
 */
export interface ExecutionResult<T = unknown> {
  success: boolean;
  value?: T;
  error?: ExecutionError;
  stats: ExecutionStats;
}

/**
 * Execution error details
 */
export interface ExecutionError {
  message: string;
  name: string;
  stack?: string;
  code?: string;
  data?: Record<string, unknown>;
}

/**
 * Execution statistics
 */
export interface ExecutionStats {
  duration: number;
  toolCallCount: number;
  iterationCount: number;
  startTime: number;
  endTime: number;
}

/**
 * Secure proxy configuration
 */
export interface SecureProxyLevelConfig {
  blockConstructor: boolean;
  blockPrototype: boolean;
  blockLegacyAccessors: boolean;
  proxyMaxDepth: number;
  throwOnBlocked: boolean;
}

/**
 * Security level configuration
 */
export interface SecurityLevelConfig {
  timeout: number;
  maxIterations: number;
  maxToolCalls: number;
  maxSanitizeDepth: number;
  maxSanitizeProperties: number;
  sanitizeStackTraces: boolean;
  blockTimingAPIs: boolean;
  allowUnboundedLoops: boolean;
  unicodeSecurityCheck: boolean;
  allowFunctionsInGlobals: boolean;
  maxConsoleOutputBytes: number;
  maxConsoleCalls: number;
  secureProxy: SecureProxyLevelConfig;
}

/**
 * Pre-defined security level configurations (mirrored from core)
 */
export const SECURITY_LEVEL_CONFIGS: Record<SecurityLevel, SecurityLevelConfig> = {
  STRICT: {
    timeout: 5000,
    maxIterations: 1000,
    maxToolCalls: 10,
    maxSanitizeDepth: 5,
    maxSanitizeProperties: 50,
    sanitizeStackTraces: true,
    blockTimingAPIs: true,
    allowUnboundedLoops: false,
    unicodeSecurityCheck: true,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 64 * 1024,
    maxConsoleCalls: 100,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 5,
      throwOnBlocked: true,
    },
  },
  SECURE: {
    timeout: 15000,
    maxIterations: 5000,
    maxToolCalls: 50,
    maxSanitizeDepth: 10,
    maxSanitizeProperties: 100,
    sanitizeStackTraces: true,
    blockTimingAPIs: false,
    allowUnboundedLoops: false,
    unicodeSecurityCheck: true,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 256 * 1024,
    maxConsoleCalls: 500,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 10,
      throwOnBlocked: true,
    },
  },
  STANDARD: {
    timeout: 30000,
    maxIterations: 10000,
    maxToolCalls: 100,
    maxSanitizeDepth: 20,
    maxSanitizeProperties: 500,
    sanitizeStackTraces: false,
    blockTimingAPIs: false,
    allowUnboundedLoops: true,
    unicodeSecurityCheck: false,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 1024 * 1024,
    maxConsoleCalls: 1000,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 15,
      throwOnBlocked: true,
    },
  },
  PERMISSIVE: {
    timeout: 60000,
    maxIterations: 100000,
    maxToolCalls: 1000,
    maxSanitizeDepth: 50,
    maxSanitizeProperties: 1000,
    sanitizeStackTraces: false,
    blockTimingAPIs: false,
    allowUnboundedLoops: true,
    unicodeSecurityCheck: false,
    allowFunctionsInGlobals: true,
    maxConsoleOutputBytes: 10 * 1024 * 1024,
    maxConsoleCalls: 10000,
    secureProxy: {
      blockConstructor: false,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 20,
      throwOnBlocked: false,
    },
  },
};

/**
 * Suspicious pattern detector
 */
export interface SuspiciousPattern {
  id: string;
  description: string;
  detect: (operationName: string, args: unknown, history: OperationHistory[]) => boolean;
}

/**
 * Serializable suspicious pattern for passing to iframe
 */
export interface SerializableSuspiciousPattern {
  id: string;
  description: string;
  detectBody: string;
}

/**
 * Operation history entry for pattern detection
 */
export interface OperationHistory {
  operationName: string;
  timestamp: number;
  argKeys: string[];
}

/**
 * Parent validation configuration
 */
export interface ParentValidationConfig {
  validateOperationNames: boolean;
  allowedOperationPattern?: RegExp;
  blockedOperationPatterns?: RegExp[];
  maxOperationsPerSecond: number;
  blockSuspiciousSequences: boolean;
  rapidEnumerationThreshold: number;
  rapidEnumerationOverrides: Record<string, number>;
  suspiciousPatterns: SuspiciousPattern[];
}

/**
 * Double iframe configuration
 */
export interface DoubleIframeConfig {
  enabled: boolean;
  parentTimeoutBuffer: number;
  parentValidation: ParentValidationConfig;
}

/**
 * Options for creating a BrowserEnclave instance
 */
export interface BrowserEnclaveOptions {
  /**
   * Security level preset
   * @default 'STANDARD'
   */
  securityLevel?: SecurityLevel;

  /**
   * AST validation preset
   * @default 'agentscript'
   */
  preset?: AstPreset;

  /**
   * Maximum execution time in milliseconds
   */
  timeout?: number;

  /**
   * Maximum number of tool calls allowed
   */
  maxToolCalls?: number;

  /**
   * Maximum number of loop iterations (per loop)
   */
  maxIterations?: number;

  /**
   * Maximum memory limit in bytes (soft tracking only in browser)
   */
  memoryLimit?: number;

  /**
   * Custom globals to inject into the sandbox
   */
  globals?: Record<string, unknown>;

  /**
   * Tool call handler
   */
  toolHandler?: ToolHandler;

  /**
   * Whether to validate code before execution
   * @default true
   */
  validate?: boolean;

  /**
   * Whether to transform code before execution
   * @default true
   */
  transform?: boolean;

  /**
   * Whether to allow functions in custom globals
   */
  allowFunctionsInGlobals?: boolean;

  /**
   * Secure proxy configuration override
   */
  secureProxyConfig?: Partial<SecureProxyLevelConfig>;

  /**
   * Double iframe configuration
   */
  doubleIframe?: Partial<DoubleIframeConfig>;

  /**
   * Custom serializable suspicious patterns for the outer iframe validation layer.
   * These are string-based (SerializableSuspiciousPattern[]) and are injected directly
   * into the outer iframe script. For function-based patterns (SuspiciousPattern[]),
   * use doubleIframe.parentValidation.suspiciousPatterns instead.
   */
  customSerializablePatterns?: SerializableSuspiciousPattern[];

  /**
   * Maximum console output bytes
   */
  maxConsoleOutputBytes?: number;

  /**
   * Maximum console calls
   */
  maxConsoleCalls?: number;
}

/**
 * Serialized config sent to iframes (no functions)
 */
export interface SerializedIframeConfig {
  timeout: number;
  maxIterations: number;
  maxToolCalls: number;
  maxConsoleOutputBytes: number;
  maxConsoleCalls: number;
  sanitizeStackTraces: boolean;
  maxSanitizeDepth: number;
  maxSanitizeProperties: number;
  securityLevel: SecurityLevel;
  memoryLimit: number;
  blockedProperties: string[];
  throwOnBlocked: boolean;
  allowComposites: boolean;
  globals?: Record<string, unknown>;
}

/**
 * Default double iframe configuration
 */
export const DEFAULT_DOUBLE_IFRAME_CONFIG: DoubleIframeConfig = {
  enabled: true,
  parentTimeoutBuffer: 1000,
  parentValidation: {
    validateOperationNames: true,
    maxOperationsPerSecond: 100,
    blockSuspiciousSequences: true,
    rapidEnumerationThreshold: 30,
    rapidEnumerationOverrides: {},
    suspiciousPatterns: [],
  },
};
