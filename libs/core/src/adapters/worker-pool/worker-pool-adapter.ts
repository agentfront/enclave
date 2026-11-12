/**
 * Worker Pool Adapter
 *
 * Implements the SandboxAdapter interface using a pool of worker threads.
 * Provides OS-level memory isolation, hard halt capability, and full pool management.
 *
 * @packageDocumentation
 */

import crypto from 'crypto';
import type { SandboxAdapter, ExecutionContext, ExecutionResult, SecurityLevel } from '../../types';
import type { WorkerPoolConfig, WorkerPoolMetrics, ResourceUsage } from './config';
import { buildWorkerPoolConfig } from './config';
import type {
  WorkerToMainMessage,
  ExecutionResultMessage,
  ToolCallMessage,
  SerializedConfig,
  SerializedDoubleVmConfig,
} from './protocol';
import {
  isToolCallMessage,
  isExecutionResultMessage,
  isConsoleMessage,
  isWorkerIdleMessage,
  isMemoryReportResultMessage,
  isWorkerReadyMessage,
} from './protocol';
import { WorkerSlot } from './worker-slot';
import { ExecutionQueue } from './execution-queue';
import { MemoryMonitor, workerMemoryBytes } from './memory-monitor';
import { RateLimiter, createRateLimiter } from './rate-limiter';
import { sanitizeObject } from './safe-deserialize';
import { decodeResult } from './result-encoding';
import {
  WorkerPoolDisposedError,
  WorkerTimeoutError,
  WorkerMemoryError,
  TooManyPendingCallsError,
  QueueFullError,
  ExecutionAbortedError,
  MessageValidationError,
} from './errors';
import { sanitizeStackTrace } from '../../stack-trace';
import { createConsoleSink } from '../../console-handler';
import { createHostToolBridge, encodeToolBridgeFailure, encodeToolBridgeRequest } from '../../tool-bridge';
import { serializePatterns } from '../../double-vm/suspicious-patterns';
import type { DoubleVmConfig } from '../../double-vm/types';
import { DEFAULT_DOUBLE_VM_CONFIG } from '../../types';

/**
 * The double VM configuration in the form that can be sent to a worker: regular expressions as
 * source and flags, custom suspicious patterns as serialized detectors.
 */
function serializeDoubleVmConfig(config: DoubleVmConfig): SerializedDoubleVmConfig {
  const validation = config.parentValidation;
  return {
    enabled: config.enabled,
    parentTimeoutBuffer: config.parentTimeoutBuffer,
    parentValidation: {
      validateOperationNames: validation.validateOperationNames,
      allowedOperationPattern: validation.allowedOperationPattern
        ? { source: validation.allowedOperationPattern.source, flags: validation.allowedOperationPattern.flags }
        : undefined,
      blockedOperationPatterns: validation.blockedOperationPatterns?.map((pattern) => ({
        source: pattern.source,
        flags: pattern.flags,
      })),
      maxOperationsPerSecond: validation.maxOperationsPerSecond,
      blockSuspiciousSequences: validation.blockSuspiciousSequences,
      rapidEnumerationThreshold: validation.rapidEnumerationThreshold,
      rapidEnumerationOverrides: { ...validation.rapidEnumerationOverrides },
      suspiciousPatterns: serializePatterns(validation.suspiciousPatterns ?? []),
    },
  };
}

/**
 * How long a worker has, after it sent a result, to confirm that nothing of the script is left
 * in it (see WorkerIdleMessage). A worker that is free confirms within a turn of its event loop;
 * one second covers a loaded machine. A worker that does not confirm is terminated: the result
 * it sent stands, and the worker is not given to another execution.
 */
const IDLE_CONFIRMATION_TIMEOUT_MS = 1000;

/** A message that belongs to one execution: only a worker that is running that execution sends it */
function isExecutionMessage(msg: WorkerToMainMessage): boolean {
  return !isMemoryReportResultMessage(msg) && !isWorkerReadyMessage(msg);
}

/**
 * Worker Pool Adapter
 *
 * Provides a worker thread-based sandbox adapter with:
 * - A heap limit per worker, enforced by the engine (by the pool when a heap flag of the process
 *   overrides it, see WorkerSlot)
 * - Hard halt capability via worker.terminate()
 * - Pool management with min/max workers
 * - Memory monitoring and enforcement
 * - Rate limiting for message flood protection
 *
 * Inside the worker the script runs in the same sandbox as an in-process execution: the double VM
 * by default (or a single VM when the double VM is disabled). The worker thread is an additional
 * layer around that sandbox, not a replacement for it. Tool calls come back to this thread and
 * go through the same tool bridge as in-process tool calls.
 *
 * A worker runs one execution at a time. It goes back into the pool only when it has confirmed,
 * after its result, that nothing of the script is left in it; in every other case (no
 * confirmation in time, an execution this side ended, a message the protocol does not allow)
 * the worker is terminated and the pool goes on with a new one.
 */
export class WorkerPoolAdapter implements SandboxAdapter {
  private readonly config: Required<WorkerPoolConfig>;
  private readonly securityLevel: SecurityLevel;
  private readonly doubleVm: SerializedDoubleVmConfig;
  private readonly slots = new Map<string, WorkerSlot>();
  /**
   * Workers that are starting. A worker is in `slots` only once it is ready, so everything that
   * compares the pool with its size has to count these as well: a burst of executions that each
   * found "room" started a worker each, however small `maxWorkers` was.
   */
  private startingWorkers = 0;
  private readonly executionQueue: ExecutionQueue;
  private readonly memoryMonitor: MemoryMonitor;
  private readonly rateLimiter: RateLimiter;
  private disposed = false;
  private initialized = false;
  /** The initialization in progress: concurrent callers share it */
  private initialization: Promise<void> | null = null;

  // Bound event handler for proper cleanup
  private readonly boundMemoryExceededHandler = this.handleMemoryExceeded.bind(this);

  // Metrics
  private _totalExecutions = 0;
  private _successfulExecutions = 0;
  private _failedExecutions = 0;
  private _timeoutExecutions = 0;
  private _workerRecycles = 0;
  private _forcedTerminations = 0;
  private _heapLimitKills = 0;
  /** Workers already counted as a memory kill (by the memory monitor or as a heap-limit kill) */
  private readonly memoryKilledSlots = new WeakSet<WorkerSlot>();
  /**
   * Workers that sent a message for an execution other than the one they are running. Such a
   * worker is not in the state the pool believes: it is not given another execution.
   */
  private readonly distrustedSlots = new WeakSet<WorkerSlot>();

  /**
   * @param config Worker pool configuration
   * @param securityLevel Security level of the enclave
   * @param doubleVmConfig How the script is isolated inside each worker. Default: the double VM
   *   with its default validation.
   */
  constructor(
    config: Partial<WorkerPoolConfig> = {},
    securityLevel: SecurityLevel = 'STANDARD',
    doubleVmConfig: DoubleVmConfig = DEFAULT_DOUBLE_VM_CONFIG,
  ) {
    this.securityLevel = securityLevel;
    this.config = buildWorkerPoolConfig(securityLevel, config);
    this.doubleVm = serializeDoubleVmConfig(doubleVmConfig);
    this.executionQueue = new ExecutionQueue({
      maxQueueSize: this.config.maxQueueSize,
      queueTimeoutMs: this.config.queueTimeoutMs,
    });
    this.memoryMonitor = new MemoryMonitor(
      {
        memoryLimitPerWorker: this.config.memoryLimitPerWorker,
        memoryCheckIntervalMs: this.config.memoryCheckIntervalMs,
      },
      this.slots,
    );
    this.rateLimiter = createRateLimiter(this.config.maxMessagesPerSecond);

    // Set up memory monitor events
    this.memoryMonitor.on('memoryExceeded', this.boundMemoryExceededHandler);
  }

  /**
   * Initialize the worker pool
   * Must be called before execute()
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // execute() initializes the pool when it has to. Executions that start at once share one
    // initialization: each used to warm the pool again, with `minWorkers` workers of its own.
    if (!this.initialization) {
      this.initialization = this.warmUp().finally(() => {
        this.initialization = null;
      });
    }
    return this.initialization;
  }

  private async warmUp(): Promise<void> {
    if (this.config.warmOnInit) {
      // Spawn minimum workers
      const spawnPromises: Promise<WorkerSlot>[] = [];
      for (let i = 0; i < this.config.minWorkers; i++) {
        spawnPromises.push(this.createAndAddSlot());
      }
      // Every attempt is waited for, also after one has failed: a worker that finishes starting
      // later would be added to a pool nobody keeps, and run on.
      const attempts = await Promise.allSettled(spawnPromises);
      const failure = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
      if (failure) {
        // Clean up the workers that did start
        await Promise.all(
          Array.from(this.slots.values()).map((slot) =>
            slot.terminate(false).catch(() => {
              /* empty */
            }),
          ),
        );
        this.slots.clear();
        throw failure.reason;
      }
    }

    // Start memory monitoring
    this.memoryMonitor.start();

    this.initialized = true;
  }

  /**
   * Execute code in a worker
   */
  async execute<T = unknown>(code: string, context: ExecutionContext): Promise<ExecutionResult<T>> {
    if (this.disposed) {
      throw new WorkerPoolDisposedError();
    }

    // Ensure initialized
    if (!this.initialized) {
      await this.initialize();
    }

    this._totalExecutions++;

    // Acquire a worker slot
    const slot = await this.acquireSlot(context.abortController?.signal);

    try {
      const result = await this.executeInSlot<T>(slot, code, context);
      this._successfulExecutions++;
      return result;
    } catch (error) {
      this._failedExecutions++;
      if (error instanceof WorkerTimeoutError) {
        this._timeoutExecutions++;
      }
      throw error;
    } finally {
      this.releaseSlot(slot);
    }
  }

  /**
   * Dispose the adapter and all workers
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    // Remove event listener before stopping to prevent memory leaks
    this.memoryMonitor.off('memoryExceeded', this.boundMemoryExceededHandler);
    this.memoryMonitor.stop();
    this.executionQueue.clear();

    // Terminate all workers. An execution that is in flight is told first: a worker that is
    // being terminated reports nothing, and the execution would be left to its watchdog, with
    // its timers keeping the host process alive until then.
    const terminatePromises: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.isExecuting) {
        slot.emit('error', new ExecutionAbortedError('Execution aborted: the worker pool was disposed'));
      }
      terminatePromises.push(slot.terminate(false));
    }

    // Don't await - just trigger termination and log any failures
    Promise.allSettled(terminatePromises).then((results) => {
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        console.error(`${failures.length} worker(s) failed to terminate during disposal`);
      }
    });

    this.slots.clear();
    this.rateLimiter.clear();
  }

  // ============================================================================
  // Pool Management
  // ============================================================================

  /** Workers the pool has, or is about to have */
  private get workerCount(): number {
    return this.slots.size + this.startingWorkers;
  }

  /**
   * Start a worker and add it to the pool.
   *
   * @param executionId When given, the new worker is acquired for this execution before anyone
   *   else can see it idle (the caller asked for a worker because none was free).
   */
  private async createAndAddSlot(executionId?: string): Promise<WorkerSlot> {
    const slotId = `worker-${Date.now()}-${crypto.randomUUID()}`;
    const slot = new WorkerSlot(slotId, {
      memoryLimitMB: Math.round(this.config.memoryLimitPerWorker / 1024 / 1024),
      gracefulShutdownTimeoutMs: this.config.gracefulShutdownTimeoutMs,
    });

    // Set up slot event handlers
    slot.on('stateChange', (newState) => {
      if (newState === 'recycling') {
        this.handleSlotRecycling(slot);
      }
    });

    // A worker can fail while no execution is listening: an idle worker that exits, or one that
    // sends a message the protocol rejects. An 'error' event without a listener is thrown as an
    // uncaught exception in the host process, so the pool always listens, and keeps its books:
    // a worker that is gone no longer counts against the pool size.
    slot.on('error', (error) => {
      // The engine ended the worker at its heap limit (the default enforcement): a memory kill
      // like the ones the host's own checks count where they act.
      if ((error as { code?: unknown } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        this.countHeapLimitKill(slot);
      }
      if (slot.status === 'terminated') {
        this.removeDeadSlot(slot);
      }
    });

    // The slot's own heap check (used when the engine does not apply the worker's heap limit)
    // ended an execution: the slot fails it and terminates the worker; the pool keeps count.
    slot.on('heapLimitExceeded', () => {
      this.countHeapLimitKill(slot);
      this._forcedTerminations++;
    });

    // An idle worker has nothing to say about an execution. One that does is not idle, whatever
    // the pool's books say: it is replaced before anybody is given it.
    slot.on('message', (msg) => {
      if (slot.isIdle && isExecutionMessage(msg)) {
        this.retireSlot(slot);
      }
    });

    let started = false;
    this.startingWorkers++;
    try {
      try {
        await slot.spawn();
      } catch (error) {
        // A worker that did not start properly is not in the pool's books; it must not stay alive
        await slot.terminate(false).catch(() => undefined);
        throw error;
      }

      // The pool may have been disposed while this worker was starting. dispose() terminates the
      // workers it knows of; one added afterwards would never be terminated, and a running worker
      // thread keeps the host process from exiting.
      if (this.disposed) {
        await slot.terminate(false).catch(() => undefined);
        throw new WorkerPoolDisposedError();
      }
      started = true;
    } finally {
      this.startingWorkers--;
      // A worker that did not start gives its place back. An execution that queued because the
      // pool was full while this worker was starting is told: it finds the pool below its size
      // and starts a worker of its own. Nothing else would tell it before its time in the queue
      // ran out.
      if (!started && !this.disposed) {
        this.executionQueue.notifySlotAvailable(slotId);
      }
    }

    this.slots.set(slotId, slot);
    if (executionId !== undefined) {
      slot.acquire(executionId);
    }
    return slot;
  }

  /** One worker ended at its memory limit is one memory kill, whichever check saw it */
  private countHeapLimitKill(slot: WorkerSlot): void {
    if (this.memoryKilledSlots.has(slot)) {
      return;
    }
    this.memoryKilledSlots.add(slot);
    this._heapLimitKills++;
  }

  private async acquireSlot(signal?: AbortSignal, retryCount = 0): Promise<WorkerSlot> {
    // Guard against infinite recursion in rapid slot recycling scenarios
    const MAX_ACQUIRE_RETRIES = 3;
    if (retryCount >= MAX_ACQUIRE_RETRIES) {
      throw new QueueFullError(this.executionQueue.getStats().length, this.config.maxQueueSize);
    }

    // Try to find an idle slot
    for (const slot of this.slots.values()) {
      if (slot.isIdle) {
        slot.acquire(`exec-${Date.now()}`);
        return slot;
      }
    }

    // Try to create a new slot if under limit
    if (this.workerCount < this.config.maxWorkers) {
      return this.createAndAddSlot(`exec-${Date.now()}`);
    }

    // Queue the request
    const slotId = await this.executionQueue.enqueue(signal);

    // Double check slot is still available
    const slot = this.slots.get(slotId);
    if (!slot || !slot.isIdle) {
      // Slot was removed/recycled, try again with incremented retry count
      return this.acquireSlot(signal, retryCount + 1);
    }

    slot.acquire(`exec-${Date.now()}`);
    return slot;
  }

  /**
   * Take a worker that is gone (terminated by the watchdog, by the memory monitor, or by itself)
   * out of the pool, and let a queued execution proceed: it finds the pool below its size and
   * gets a new worker. A dead slot that stayed in the pool would count against `maxWorkers`
   * forever, and with one worker every later execution would wait in the queue until it timed out.
   */
  private removeDeadSlot(slot: WorkerSlot): void {
    if (this.slots.get(slot.id) !== slot) {
      return;
    }
    this.slots.delete(slot.id);
    this.rateLimiter.reset(slot.id);
    if (!this.disposed) {
      this.executionQueue.notifySlotAvailable(slot.id);
    }
  }

  /**
   * End a worker that is alive but cannot be trusted to be free, and take it out of the pool.
   * The next execution finds the pool below its size and gets a new worker.
   */
  private retireSlot(slot: WorkerSlot): void {
    if (slot.isTerminated) {
      return;
    }
    this._forcedTerminations++;
    slot.terminate(false).catch((error) => {
      console.error(`Failed to terminate worker ${slot.id}:`, error);
    });
    this.removeDeadSlot(slot);
  }

  private releaseSlot(slot: WorkerSlot): void {
    if (slot.status === 'terminated' || slot.status === 'terminating') {
      this.removeDeadSlot(slot);
      return;
    }

    // A recycling slot is replaced by handleSlotRecycling
    if (slot.status === 'recycling') {
      return;
    }

    if (this.distrustedSlots.has(slot)) {
      this.retireSlot(slot);
      return;
    }

    // Check if slot needs recycling
    if (slot.executionCount >= this.config.maxExecutionsPerWorker) {
      slot.markForRecycle();
      return;
    }

    // Release the slot
    slot.release();

    // Notify queue that slot is available
    if (!this.executionQueue.notifySlotAvailable(slot.id)) {
      // No queued requests, slot stays idle
      this.checkIdleSlots();
    }
  }

  private async handleSlotRecycling(slot: WorkerSlot): Promise<void> {
    this._workerRecycles++;
    const slotId = slot.id;

    // Terminate the old worker
    await slot.terminate(true);
    this.slots.delete(slotId);
    this.rateLimiter.reset(slotId);

    // Create a replacement if needed
    let replacement: WorkerSlot | undefined;
    if (this.workerCount < this.config.minWorkers && !this.disposed) {
      try {
        replacement = await this.createAndAddSlot();
      } catch (error) {
        // Disposal while the replacement was starting is not a failure to report
        if (!(error instanceof WorkerPoolDisposedError)) {
          console.error('Failed to create replacement worker:', error);
        }
      }
    }

    // An execution may be waiting in the queue for exactly this: the replacement, or room for a
    // worker of its own. Nothing else tells it (a recycled worker is not "released"), and it
    // would wait until its time in the queue ran out.
    if (!this.disposed && (replacement?.isIdle || this.workerCount < this.config.maxWorkers)) {
      this.executionQueue.notifySlotAvailable(replacement?.id ?? slotId);
    }
  }

  private handleMemoryExceeded(slotId: string, usage: ResourceUsage): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;

    // If slot is executing, we need to force terminate
    if (slot.isExecuting) {
      this._forcedTerminations++;
      // Counted by the memory monitor; an engine error for the same worker is not a second kill
      this.memoryKilledSlots.add(slot);
      // The execution that is waiting on this worker is told why it ends. A worker that is being
      // terminated reports nothing, so the execution would otherwise go on until its next tool
      // response failed to send ("has no worker") or its timeout expired.
      slot.emit('error', new WorkerMemoryError(workerMemoryBytes(usage), this.config.memoryLimitPerWorker));
      // The failed execution releases the slot, which takes it out of the pool and tells the
      // queue. removeDeadSlot does both once, whoever gets there first: a second notification
      // would wake a waiting execution for nothing and cost it one of its acquire retries.
      slot
        .terminate(false)
        .then(() => {
          this.removeDeadSlot(slot);
        })
        .catch((error) => {
          console.error('Failed to terminate memory-exceeded worker:', error);
          this.removeDeadSlot(slot);
        });
    }
  }

  private checkIdleSlots(): void {
    // Remove excess idle workers
    const now = Date.now();
    const idleSlots: WorkerSlot[] = [];

    for (const slot of this.slots.values()) {
      if (slot.isIdle) {
        idleSlots.push(slot);
      }
    }

    // Keep at least minWorkers
    const excessCount = idleSlots.length - this.config.minWorkers;
    if (excessCount <= 0) return;

    // Sort by last active time (oldest first)
    idleSlots.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    // Remove oldest excess workers that have been idle too long
    for (let i = 0; i < excessCount; i++) {
      const slot = idleSlots[i];
      if (now - slot.lastActiveAt > this.config.idleTimeoutMs) {
        slot.terminate(true).catch((error) => {
          console.error(`Failed to terminate idle worker ${slot.id}:`, error);
        });
        this.slots.delete(slot.id);
      }
    }
  }

  // ============================================================================
  // Execution
  // ============================================================================

  private async executeInSlot<T>(
    slot: WorkerSlot,
    code: string,
    context: ExecutionContext,
  ): Promise<ExecutionResult<T>> {
    // The execution was aborted while it waited for a worker (the pool was starting one, or the
    // enclave's timeout passed). An abort event is not repeated for a listener added afterwards,
    // so the worker would run the script with a deadline of its own, after the host's.
    if (context.abortController?.signal.aborted) {
      throw new ExecutionAbortedError('Execution aborted before it started');
    }

    const requestId = `exec-${Date.now()}-${crypto.randomUUID()}`;
    const startTime = Date.now();

    const consoleSink = context.consoleHandler ? createConsoleSink(context.consoleHandler, context.config) : undefined;

    // Serialize config (includes security level for defense-in-depth)
    const serializedConfig: SerializedConfig = {
      timeout: context.config.timeout,
      maxIterations: context.config.maxIterations,
      maxToolCalls: context.config.maxToolCalls,
      maxConsoleOutputBytes: context.config.maxConsoleOutputBytes,
      maxConsoleCalls: context.config.maxConsoleCalls,
      sanitizeStackTraces: context.config.sanitizeStackTraces,
      maxSanitizeDepth: context.config.maxSanitizeDepth,
      maxSanitizeProperties: context.config.maxSanitizeProperties,
      globals: context.config.globals,
      // Security level determines which globals are available in sandbox
      // This mirrors AST guard's allowed globals for defense-in-depth
      securityLevel: this.securityLevel,
      toolNamespaces: context.toolNamespaces ? [...context.toolNamespaces] : undefined,
      hasConsoleHandler: consoleSink !== undefined,
      memoryLimit: context.config.memoryLimit,
      toolBridgeMaxPayloadBytes: context.config.toolBridge?.maxPayloadBytes,
      secureProxyConfig: context.secureProxyConfig,
      maxGlobalFunctionCalls: context.config.maxGlobalFunctionCalls,
      realmGlobalAllowlist: context.realmGlobalAllowlist ? [...context.realmGlobalAllowlist] : undefined,
      referenceConfig: context.referenceConfig,
      doubleVm: this.doubleVm,
    };

    // Tool calls of the worker are answered by the same bridge as in-process tool calls: abort
    // check, tool-call limit, argument sanitization, sidecar references, result sanitization.
    const toolBridge = createHostToolBridge(context, { updateStats: true });

    // The message rate is the execution's: what an earlier execution sent from this worker is
    // not held against this one.
    this.rateLimiter.reset(slot.id);

    return new Promise<ExecutionResult<T>>((resolve, reject) => {
      // Pending tool calls for this execution
      const pendingToolCalls = new Map<string, boolean>();

      /**
       * The script's result, once the worker has sent it. The execution is not over then: the
       * script may have left work behind that keeps the worker's thread. It is over when the
       * worker has confirmed that it is free, or has been terminated because it did not.
       */
      let outcome: ExecutionResult<T> | undefined;
      /** The execution has ended on this side: nothing below acts for it any more */
      let over = false;
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let idleCheckId: ReturnType<typeof setImmediate> | undefined;

      // An abort on this side (the enclave's timeout, or the caller) is passed on to the worker,
      // whose sandbox then refuses further tool calls and loop iterations.
      const abortSignal = context.abortController?.signal;
      const abortHandler = () => {
        try {
          slot.sendMessage({ type: 'abort', requestId });
        } catch {
          // The worker is already gone
        }
      };

      // Cleanup function to remove handlers
      const cleanup = () => {
        clearTimeout(watchdogId);
        clearTimeout(idleTimeoutId);
        clearImmediate(idleCheckId);
        slot.off('message', messageHandler);
        slot.off('error', errorHandler);
        abortSignal?.removeEventListener('abort', abortHandler);
      };

      // The one way out: with the script's result when the worker delivered one, else with `error`
      const end = (error?: Error) => {
        if (over) {
          return;
        }
        over = true;
        cleanup();
        if (outcome !== undefined) {
          resolve(outcome);
        } else {
          reject(error ?? new ExecutionAbortedError());
        }
      };

      // This side ends the execution (too many messages, too many tool calls in flight, a message
      // it cannot use). The worker was told nothing and the script may be running in it: the
      // worker ends with the execution. It is never released into the pool.
      const endWithWorker = (error: Error) => {
        if (over) {
          return;
        }
        if (!slot.isTerminated) {
          this._forcedTerminations++;
        }
        slot.failExecution(error);
        end(error);
      };

      // The worker has sent its result. It gets a moment to say that it is free; one that does
      // not is terminated. Either way the result stands.
      const awaitIdleConfirmation = () => {
        // The execution has its result: it can no longer time out or be aborted
        clearTimeout(watchdogId);
        abortSignal?.removeEventListener('abort', abortHandler);
        idleTimeoutId = setTimeout(() => {
          // When this thread was busy for the whole time, the confirmation may be waiting in its
          // queue: messages are delivered before an immediate runs.
          idleCheckId = setImmediate(() => {
            if (over) {
              return;
            }
            if (!slot.isTerminated) {
              this._forcedTerminations++;
            }
            slot.terminate(false).catch((error) => {
              console.error('Termination of a worker that did not become idle failed:', error);
            });
            end();
          });
        }, IDLE_CONFIRMATION_TIMEOUT_MS);
      };

      // Message handler
      const messageHandler: (msg: WorkerToMainMessage) => Promise<void> = async (msg: WorkerToMainMessage) => {
        // The answers to the pool's own memory requests are not messages of the script
        if (over || isMemoryReportResultMessage(msg)) {
          return;
        }
        try {
          if (outcome !== undefined) {
            // The result is in; what is awaited is the worker's word that it is free. Whatever
            // else it sends now reaches nobody, and is counted.
            if (isWorkerIdleMessage(msg) && msg.requestId === requestId) {
              end();
              return;
            }
            this.rateLimiter.checkLimit(slot.id);
            return;
          }

          if (isExecutionResultMessage(msg) && msg.requestId === requestId) {
            // One result per execution: the protocol's own message, not counted against the script
            const duration = Date.now() - startTime;
            outcome = this.buildResult<T>(msg, duration, context.config.sanitizeStackTraces);
            awaitIdleConfirmation();
            return;
          }

          // Rate limiting: everything else a worker sends while it runs a script
          this.rateLimiter.checkLimit(slot.id);

          if (!('requestId' in msg) || msg.requestId !== requestId) {
            // Not a message of this execution. It is not acted on, and this execution is not
            // failed for it, but a worker that sends one is not given to anybody afterwards.
            this.distrustedSlots.add(slot);
          } else if (isToolCallMessage(msg)) {
            await this.handleToolCall(slot, msg, toolBridge, context, pendingToolCalls);
          } else if (isConsoleMessage(msg)) {
            if (consoleSink) {
              consoleSink(msg.level, msg.args[0]);
            } else {
              this.handleConsoleMessage(msg);
            }
          } else if (isWorkerIdleMessage(msg)) {
            throw new MessageValidationError('worker reported idle before it sent a result');
          }
        } catch (error) {
          endWithWorker(error as Error);
        }
      };

      // Handle slot error. Whoever reports it also ends the worker.
      const errorHandler: (error: Error) => void = (error: Error) => {
        end(error);
      };

      // Set up watchdog timeout (VM timeout + buffer)
      const watchdogTimeout = context.config.timeout + 5000;
      const watchdogId: ReturnType<typeof setTimeout> = setTimeout(() => {
        this._forcedTerminations++;
        slot.terminate(false).catch((error) => {
          console.error('Watchdog termination failed:', error);
        });
        end(new WorkerTimeoutError());
      }, watchdogTimeout);

      slot.on('message', messageHandler);
      slot.once('error', errorHandler);
      abortSignal?.addEventListener('abort', abortHandler, { once: true });

      // Send execute message
      try {
        slot.sendMessage({
          type: 'execute',
          requestId,
          code,
          config: serializedConfig,
        });
      } catch (error) {
        // The script was not sent: nothing of it is in the worker
        end(error as Error);
      }
    });
  }

  private async handleToolCall(
    slot: WorkerSlot,
    msg: ToolCallMessage,
    toolBridge: (requestJson: string) => Promise<string>,
    context: ExecutionContext,
    pendingToolCalls: Map<string, boolean>,
  ): Promise<void> {
    // Check pending tool call limit
    if (pendingToolCalls.size >= this.config.maxPendingToolCalls) {
      throw new TooManyPendingCallsError(pendingToolCalls.size, this.config.maxPendingToolCalls);
    }

    pendingToolCalls.set(msg.callId, true);

    let response: string;
    try {
      // The message was validated against the protocol schema (tool name, argument shape); the
      // arguments are stripped of prototype-pollution keys before they are used.
      const args = sanitizeObject(msg.args) as Record<string, unknown>;
      response = await toolBridge(encodeToolBridgeRequest(msg.toolName, args));
    } catch (e) {
      // The bridge reports failures in its response; this is only reached if a request could not
      // even be built. It is a refusal by the host, not a failure of the tool.
      response = encodeToolBridgeFailure(
        'ToolBridgeError',
        (e as Error)?.message || 'Tool bridge failure',
        'TOOL_BRIDGE_FAILURE',
        context.config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024,
      );
    } finally {
      pendingToolCalls.delete(msg.callId);
    }

    // Send response
    slot.sendMessage({
      type: 'tool-response',
      requestId: msg.requestId,
      callId: msg.callId,
      response,
    });
  }

  private handleConsoleMessage(msg: { level: string; args: unknown[] }): void {
    // Forward to console
    const level = msg.level as 'log' | 'warn' | 'error' | 'info';
    if (console[level]) {
      console[level]('[Worker]', ...msg.args);
    }
  }

  /**
   * Build result from worker message.
   *
   * Note: The `as T` assertion is inherent to cross-thread serialization boundaries. The
   * worker sanitizes the result with sanitizeValue() and sends the values JSON cannot carry
   * (Dates, NaN, ...) separately; decodeResult() puts them back and refuses a malformed list.
   */
  private buildResult<T>(msg: ExecutionResultMessage, duration: number, sanitizeStacks: boolean): ExecutionResult<T> {
    if (msg.success) {
      return {
        success: true,
        value: decodeResult(msg.value, msg.specialValues) as T,
        stats: {
          duration,
          toolCallCount: msg.stats.toolCallCount,
          iterationCount: msg.stats.iterationCount,
          startTime: msg.stats.startTime,
          endTime: msg.stats.endTime,
        },
      };
    } else {
      const error = msg.error ?? { name: 'Error', message: 'Unknown error' };
      return {
        success: false,
        error: {
          name: error.name,
          message: error.message,
          code: error.code,
          // The worker trims its stack; sanitize it here too so the result obeys the option.
          stack: sanitizeStackTrace(error.stack, sanitizeStacks),
          ...(error.data ? { data: sanitizeObject(error.data) as Record<string, unknown> } : {}),
        },
        stats: {
          duration,
          toolCallCount: msg.stats.toolCallCount,
          iterationCount: msg.stats.iterationCount,
          startTime: msg.stats.startTime,
          endTime: msg.stats.endTime,
        },
      };
    }
  }

  // ============================================================================
  // Metrics
  // ============================================================================

  /**
   * Get pool metrics
   */
  getMetrics(): WorkerPoolMetrics {
    let idleSlots = 0;
    let executingSlots = 0;
    let recyclingSlots = 0;

    for (const slot of this.slots.values()) {
      if (slot.isIdle) idleSlots++;
      else if (slot.isExecuting) executingSlots++;
      else if (slot.status === 'recycling') recyclingSlots++;
    }

    const memoryStats = this.memoryMonitor.getCurrentUsageSummary();
    const queueStats = this.executionQueue.getStats();

    return {
      timestamp: Date.now(),
      totalSlots: this.slots.size,
      idleSlots,
      executingSlots,
      recyclingSlots,
      queuedRequests: queueStats.length,
      totalExecutions: this._totalExecutions,
      successfulExecutions: this._successfulExecutions,
      failedExecutions: this._failedExecutions,
      timeoutExecutions: this._timeoutExecutions,
      memoryKills: this.memoryMonitor.getStats().memoryExceededCount + this._heapLimitKills,
      forcedTerminations: this._forcedTerminations,
      workerRecycles: this._workerRecycles,
      avgExecutionTimeMs: 0, // Would need additional tracking
      avgWorkerMemory: memoryStats.avgWorkerBytes,
      maxWorkerMemory: memoryStats.maxWorkerBytes,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<WorkerPoolConfig> {
    return { ...this.config };
  }

  /**
   * Check if adapter is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if adapter is disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}
