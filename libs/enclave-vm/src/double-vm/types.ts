/**
 * Double VM Types and Interfaces
 *
 * Types for the double VM security layer that provides
 * enhanced isolation by running user code inside a nested VM.
 *
 * @packageDocumentation
 */

/**
 * Operation history entry for pattern detection
 *
 * Tracks operations (e.g., tool calls) for suspicious pattern analysis.
 */
export interface OperationHistory {
  /** Name of the operation that was executed */
  operationName: string;
  /** Timestamp when the operation was executed */
  timestamp: number;
  /** Keys of the arguments object (for pattern analysis) */
  argKeys: string[];
}

/**
 * Suspicious pattern detector
 *
 * Used to detect potentially malicious operation sequences
 * like data exfiltration (list -> send) or rapid enumeration.
 */
export interface SuspiciousPattern {
  /** Unique identifier for the pattern */
  id: string;
  /** Human-readable description of what this pattern detects */
  description: string;
  /**
   * Detection function
   *
   * @param operationName - The operation being executed
   * @param args - The arguments being passed
   * @param history - Previous operations in this execution
   * @returns true if the pattern is detected (suspicious)
   */
  detect: (operationName: string, args: unknown, history: OperationHistory[]) => boolean;
}

/**
 * Serializable version of SuspiciousPattern for passing to parent VM
 *
 * Since functions cannot be passed across VM boundaries, we serialize
 * the detection logic as a string that gets evaluated in the parent VM.
 */
export interface SerializableSuspiciousPattern {
  /** Unique identifier for the pattern */
  id: string;
  /** Human-readable description */
  description: string;
  /**
   * Detection function body as a string
   * Will be wrapped in: `function(operationName, args, history) { ... }`
   */
  detectBody: string;
}

/**
 * Parent VM validation configuration
 *
 * Controls enhanced validation performed by the parent VM
 * before forwarding operations to the host.
 */
export interface ParentValidationConfig {
  /**
   * Whether to validate operation names against patterns
   * @default true
   */
  validateOperationNames: boolean;

  /**
   * Optional whitelist regex pattern for operation names
   * If set, only operations matching this pattern are allowed
   */
  allowedOperationPattern?: RegExp;

  /**
   * Blacklist regex patterns for operation names
   * Operations matching any of these patterns are blocked
   */
  blockedOperationPatterns?: RegExp[];

  /**
   * Maximum operations per second (rate limiting)
   * Prevents rapid enumeration attacks
   * @default 100
   */
  maxOperationsPerSecond: number;

  /**
   * Whether to detect and block suspicious operation sequences
   * @default true
   */
  blockSuspiciousSequences: boolean;

  /**
   * Custom suspicious pattern detectors
   * Added to the default patterns
   */
  suspiciousPatterns: SuspiciousPattern[];
}

/**
 * Serializable version of ParentValidationConfig for passing to parent VM
 */
export interface SerializableParentValidationConfig {
  validateOperationNames: boolean;
  allowedOperationPatternSource?: string;
  allowedOperationPatternFlags?: string;
  blockedOperationPatternSources?: string[];
  blockedOperationPatternFlags?: string[];
  maxOperationsPerSecond: number;
  blockSuspiciousSequences: boolean;
  suspiciousPatterns: SerializableSuspiciousPattern[];
}

/**
 * Double VM configuration
 *
 * Controls the double VM security layer behavior.
 */
export interface DoubleVmConfig {
  /**
   * Whether double VM is enabled
   *
   * When disabled, a security warning is logged and user code
   * runs in a single VM with direct tool handler access.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * Extra timeout buffer for parent VM (ms)
   *
   * The parent VM timeout = inner VM timeout + this buffer.
   * This allows the parent VM to properly handle inner VM timeouts.
   *
   * @default 1000
   */
  parentTimeoutBuffer: number;

  /**
   * Parent VM validation configuration
   */
  parentValidation: ParentValidationConfig;
}

/**
 * Partial configuration for user input
 * (all fields optional, merged with defaults)
 */
export interface PartialDoubleVmConfig {
  enabled?: boolean;
  parentTimeoutBuffer?: number;
  parentValidation?: Partial<Omit<ParentValidationConfig, 'suspiciousPatterns'>> & {
    suspiciousPatterns?: SuspiciousPattern[];
  };
}

/**
 * Execution statistics from double VM
 */
export interface DoubleVmStats {
  /** Number of operations that passed validation */
  validatedOperations: number;
  /** Number of operations blocked by validation */
  blockedOperations: number;
  /** Patterns that were triggered (for logging/debugging) */
  triggeredPatterns: string[];
}
