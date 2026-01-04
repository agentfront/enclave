/**
 * Double VM Module
 *
 * Provides enhanced security isolation through nested VM architecture.
 *
 * @packageDocumentation
 */

// Types
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

// Wrapper
export { DoubleVmWrapper } from './double-vm-wrapper';
export { wrapWithDoubleVm, isDoubleVmEnabled } from './wrap-adapter';

// Patterns
export { DEFAULT_SUSPICIOUS_PATTERNS, serializePattern, serializePatterns } from './suspicious-patterns';

// Bootstrap (for testing)
export { generateParentVmBootstrap } from './parent-vm-bootstrap';
export type { ParentVmBootstrapOptions } from './parent-vm-bootstrap';
