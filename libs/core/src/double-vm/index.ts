/**
 * Double VM Module
 *
 * Provides enhanced security isolation through nested VM architecture.
 *
 * @packageDocumentation
 */

/**
 * Type exports for double VM configuration and runtime
 */
export type {
  DoubleVmConfig,
  PartialDoubleVmConfig,
  ParentValidationConfig,
  SuspiciousPattern,
  SerializableSuspiciousPattern,
  SerializableParentValidationConfig,
  OperationHistory,
  DoubleVmStats,
} from './types';

/**
 * Core wrapper class for double VM execution
 */
export { DoubleVmWrapper } from './double-vm-wrapper';

/**
 * Utility functions for adapter wrapping
 */
export { wrapWithDoubleVm, isDoubleVmEnabled } from './wrap-adapter';

/**
 * Suspicious pattern detection exports
 */
export { DEFAULT_SUSPICIOUS_PATTERNS, serializePattern, serializePatterns } from './suspicious-patterns';

/**
 * Bootstrap generation for parent VM (primarily for testing)
 */
export { generateParentVmBootstrap } from './parent-vm-bootstrap';

/**
 * Bootstrap options type
 */
export type { ParentVmBootstrapOptions } from './parent-vm-bootstrap';
