/**
 * Worker Pool Adapter
 *
 * Provides a worker thread-based sandbox adapter with:
 * - OS-level memory isolation
 * - Hard halt capability via worker.terminate()
 * - Pool management with min/max workers
 * - Memory monitoring and enforcement
 * - Rate limiting for message flood protection
 *
 * @packageDocumentation
 */

/**
 * Main worker pool adapter class
 */
export { WorkerPoolAdapter } from './worker-pool-adapter';

/**
 * Configuration types and defaults for worker pool
 */
export {
  WorkerPoolConfig,
  WorkerSlotStatus,
  ResourceUsage,
  WorkerPoolMetrics,
  DEFAULT_WORKER_POOL_CONFIG,
  WORKER_POOL_PRESETS,
  buildWorkerPoolConfig,
} from './config';

/**
 * Error classes for worker pool operations
 */
export {
  WorkerPoolError,
  WorkerTimeoutError,
  WorkerMemoryError,
  WorkerCrashedError,
  WorkerPoolDisposedError,
  QueueFullError,
  QueueTimeoutError,
  ExecutionAbortedError,
  MessageFloodError,
  MessageValidationError,
  MessageSizeError,
  WorkerStartupError,
  TooManyPendingCallsError,
} from './errors';

/**
 * Protocol types for main thread to worker communication
 */
export type {
  SerializedError,
  SerializedConfig,
  WorkerExecutionStats,
  MainToWorkerMessage,
  WorkerToMainMessage,
  ExecuteMessage,
  ToolCallMessage,
  ExecutionResultMessage,
  ToolResponseMessage,
} from './protocol';

/**
 * Worker slot management for advanced usage
 */
export { WorkerSlot } from './worker-slot';

/**
 * Execution queue for request management
 */
export { ExecutionQueue, QueueStats } from './execution-queue';

/**
 * Memory monitoring utilities
 */
export { MemoryMonitor, MemoryMonitorStats } from './memory-monitor';

/**
 * Rate limiting utilities
 */
export { RateLimiter, createRateLimiter } from './rate-limiter';

/**
 * Safe serialization utilities for cross-thread communication
 */
export { safeDeserialize, safeSerialize, sanitizeObject } from './safe-deserialize';
