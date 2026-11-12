/**
 * Worker Slot
 *
 * Manages a single worker thread with state tracking, lifecycle management,
 * and metrics collection.
 *
 * @packageDocumentation
 */

import { Worker, type WorkerOptions } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { DEFAULT_WORKER_POOL_CONFIG, type WorkerSlotStatus, type ResourceUsage } from './config';
import { workerToMainMessageSchema, type MainToWorkerMessage, type WorkerToMainMessage } from './protocol';
import { safeDeserialize, safeSerialize } from './safe-deserialize';
import { WorkerStartupError, WorkerCrashedError, MessageValidationError, WorkerMemoryError } from './errors';

/**
 * Events emitted by WorkerSlot
 */
export interface WorkerSlotEvents {
  /** Worker sent a message */
  message: [WorkerToMainMessage];
  /** Worker exited */
  exit: [number | null];
  /** Worker errored */
  error: [Error];
  /** Worker is ready */
  ready: [];
  /** State changed */
  stateChange: [WorkerSlotStatus, WorkerSlotStatus];
  /** The host-side heap check ended the running execution (bytes the worker held) */
  heapLimitExceeded: [number];
}

/**
 * Worker slot options
 */
export interface WorkerSlotOptions {
  /** Heap limit of the worker in MB (its old generation); 0 for no limit */
  memoryLimitMB: number;
  /** Startup timeout in milliseconds */
  startupTimeoutMs?: number;
  /**
   * Largest message the worker may send, in bytes of UTF-8. A larger one is refused before it is
   * parsed. Default: the pool's default `maxMessageSizeBytes`.
   */
  maxMessageSizeBytes?: number;
  /** How long an idle worker that was asked to leave gets before it is terminated. Default: 5000 */
  gracefulShutdownTimeoutMs?: number;
}

/** Where the build puts the worker script, relative to the package's output folder. */
const WORKER_SCRIPT_RELATIVE_PATH = path.join('src', 'adapters', 'worker-pool', 'worker-script.js');

const MB = 1024 * 1024;

/** How often this thread reads what an executing worker holds */
const HEAP_WATCHDOG_INTERVAL_MS = 100;

/** How long spawn() waits for a new worker's heap statistics before going on without them */
const HEAP_STATISTICS_TIMEOUT_MS = 2000;

/** Rounding slack when a worker's actual heap limit is compared with the one it was created with */
const HEAP_LIMIT_TOLERANCE_BYTES = 16 * MB;

/**
 * The young generation of a worker that has a memory limit, in MB.
 *
 * A worker thread shares the process. When a worker reaches the limit of its old generation,
 * Node.js ends the worker and raises the limit by 16 MB so that the engine can finish what it is
 * doing. One scavenge can move a whole semi-space, a third of the young generation, into the old
 * generation at once. Left to the engine, the young generation of a limited worker is 192 MB on
 * Node.js 24 (48 MB on Node.js 22): a burst of up to 64 MB against an allowance of 16, and when
 * the burst is larger than the allowance the engine ends the PROCESS with a fatal out-of-memory
 * error instead of the worker.
 *
 * Measured on Node.js 24.18 with a script that fills a 64 MB worker, each run a process of its
 * own: with the engine's default, 13 of 480 processes aborted at 12 in parallel, 3 of 380 at 6 to
 * 8 in parallel and 0 of 40 one at a time. With 24 MB (semi-spaces of 8 MB, half the allowance):
 * 0 of 480 at 12 in parallel. 24 is also a value the engine keeps as it is: it rounds a
 * semi-space up to a power of two, so asking for 16 gives 24 and asking for 32 gives 48.
 *
 * This bounds the burst of a scavenge. It does not make the limit a guarantee: one allocation
 * larger than the allowance still ends the process (see "The Worker Heap Limit" in the README).
 */
export const WORKER_YOUNG_GENERATION_MB = 24;

/**
 * Who stops a worker that outgrows its memory limit:
 *
 * - `engine`: V8, through the worker's `resourceLimits`. The normal case.
 * - `host`: this thread, by reading the worker's heap while it executes, because the engine does
 *   not apply the limit (see {@link isHeapLimitApplied}).
 * - `none`: nobody. No limit is configured, or the engine does not apply it and this Node.js
 *   version cannot read a worker's heap from outside.
 */
export type HeapLimitEnforcement = 'engine' | 'host' | 'none';

/** The fields of `worker.getHeapStatistics()` used here */
interface WorkerHeapStatistics {
  used_heap_size: number;
  heap_size_limit: number;
  external_memory: number;
}

/**
 * Whether the engine applies the heap limit a worker was created with.
 *
 * `resourceLimits.maxOldGenerationSizeMb` does nothing when the process itself runs with
 * `--max-old-space-size` (on the command line or in `NODE_OPTIONS`): the flag is process-wide,
 * every worker gets its value, and `worker.resourceLimits` goes on reporting what was asked for.
 * What tells the two cases apart is the worker's actual heap size limit: with the limit applied
 * it is the old generation that was asked for plus the young generation.
 *
 * @param heapSizeLimitBytes `heap_size_limit` from the worker's heap statistics
 * @param budgetBytes The limit the worker was created with plus its young generation
 */
export function isHeapLimitApplied(heapSizeLimitBytes: number, budgetBytes: number): boolean {
  return heapSizeLimitBytes <= budgetBytes + HEAP_LIMIT_TOLERANCE_BYTES;
}

/**
 * Whether the process was started with a V8 old-space flag, as far as its arguments tell. Only
 * consulted where a worker's heap cannot be read (Node.js before 22.16), to say that the limit
 * is not enforced.
 */
export function hasProcessHeapFlag(execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  return /--max[-_]old[-_]space[-_]size\b/.test(`${execArgv.join(' ')} ${nodeOptions ?? ''}`);
}

type HeapStatisticsReader = () => Promise<WorkerHeapStatistics>;

function heapStatisticsReader(worker: Worker): HeapStatisticsReader | undefined {
  const read = (worker as unknown as { getHeapStatistics?: HeapStatisticsReader }).getHeapStatistics;
  return typeof read === 'function' ? read.bind(worker) : undefined;
}

/**
 * A worker's heap statistics, read from this thread (`worker.getHeapStatistics()`, Node.js 22.16
 * and later). The worker answers from an interrupt, so also while a script keeps it busy; only
 * one long native call delays the answer. Resolves to undefined when they cannot be read: an
 * older Node.js, a worker that is gone, or no answer within `timeoutMs`.
 */
function readHeapStatistics(worker: Worker, timeoutMs?: number): Promise<WorkerHeapStatistics | undefined> {
  const read = heapStatisticsReader(worker);
  if (!read) {
    return Promise.resolve(undefined);
  }

  let statistics: Promise<WorkerHeapStatistics | undefined>;
  try {
    statistics = read().then(
      (value) => value,
      () => undefined,
    );
  } catch {
    return Promise.resolve(undefined);
  }
  if (timeoutMs === undefined) {
    return statistics;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    // Waiting for an answer must not keep the host process alive
    timer.unref();
    void statistics.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** The warning below is about the process, so it is given once per process, not per worker */
let heapLimitWarningGiven = false;

function warnHeapLimitNotApplied(limitMB: number, enforcement: HeapLimitEnforcement): void {
  if (heapLimitWarningGiven) {
    return;
  }
  heapLimitWarningGiven = true;
  console.warn(
    `[enclave-vm] A worker thread can grow beyond its heap limit (${limitMB} MB plus the young generation): ` +
      'a V8 heap flag of this process (--max-old-space-size or --max-semi-space-size) overrides the resource ' +
      'limits of every worker thread. ' +
      (enforcement === 'host'
        ? 'The worker pool enforces the limit itself by reading the heap of each executing worker; it is approximate.'
        : 'This Node.js version cannot read the heap of a worker from outside (22.16 and later can), ' +
          'so the limit is NOT enforced.'),
  );
}

/**
 * Find the compiled worker script (worker threads need JavaScript, built by the
 * `build-worker-script` target) from the directory of the module that spawns the worker.
 *
 * That module is in a different place in each form the package runs in:
 *
 * - the CommonJS bundle `dist/index.js`: the script is at `dist/src/adapters/worker-pool/`;
 * - the ES module bundle `dist/esm/index.mjs`: one level up from there;
 * - the TypeScript sources under ts-jest (`src/adapters/worker-pool/`): in the `dist` folder
 *   next to `src`;
 * - an unbundled build: next to this module.
 *
 * @param moduleDir Directory of the calling module
 * @param exists File existence check (a test passes its own)
 * @throws Error naming every location tried when the script is in none of them
 */
export function resolveWorkerScriptPath(moduleDir: string, exists: (file: string) => boolean = fs.existsSync): string {
  const candidates = [
    path.join(moduleDir, 'worker-script.js'),
    path.join(moduleDir, WORKER_SCRIPT_RELATIVE_PATH),
    path.join(moduleDir, '..', WORKER_SCRIPT_RELATIVE_PATH),
  ];
  const sourceMarker = `${path.sep}src${path.sep}`;
  const sourceIndex = moduleDir.lastIndexOf(sourceMarker);
  if (sourceIndex !== -1) {
    candidates.push(
      path.join(
        moduleDir.slice(0, sourceIndex),
        'dist',
        'src',
        moduleDir.slice(sourceIndex + sourceMarker.length),
        'worker-script.js',
      ),
    );
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  throw new WorkerStartupError(
    `Worker script not found. Build @enclave-vm/core first (nx build core). Looked in: ${candidates.join(', ')}`,
  );
}

/**
 * Manages a single worker thread
 */
export class WorkerSlot extends EventEmitter {
  /** Unique slot identifier */
  readonly id: string;

  /** The underlying worker thread */
  private _worker: Worker | null = null;

  /** Current status */
  private _status: WorkerSlotStatus = 'created';

  /** Number of executions completed */
  private _executionCount = 0;

  /** Creation timestamp */
  readonly createdAt: number;

  /** Last activity timestamp */
  private _lastActiveAt: number;

  /** Current execution request ID (if executing) */
  private _currentExecutionId: string | null = null;

  /** Last memory report */
  private _memoryUsage: ResourceUsage | null = null;

  /** Who enforces this worker's memory limit; decided when the worker has started */
  private _heapLimitEnforcement: HeapLimitEnforcement = 'none';

  /** What this worker may hold: its limit plus the young generation, in bytes. 0 without a limit. */
  private _memoryBudgetBytes = 0;

  /** The host-side memory check of the running execution */
  private heapWatchdog: ReturnType<typeof setInterval> | null = null;

  /** Largest message the worker may send right now, in bytes (see limitMessageSize) */
  private messageSizeLimitBytes: number;

  /** The worker sent something the protocol does not allow: it is ended, not asked to leave */
  private protocolViolated = false;

  /** Memory reports asked for and not answered yet: each entry ends its request */
  private readonly pendingMemoryReports = new Set<(error: Error) => void>();

  /** Configuration */
  private readonly options: Required<WorkerSlotOptions>;

  /** Message handler bound to this instance */
  private readonly boundMessageHandler: (raw: unknown) => void;

  /** Error handler bound to this instance */
  private readonly boundErrorHandler: (error: Error) => void;

  /** Exit handler bound to this instance */
  private readonly boundExitHandler: (code: number | null) => void;

  constructor(id: string, options: WorkerSlotOptions) {
    super();
    this.id = id;
    this.createdAt = Date.now();
    this._lastActiveAt = this.createdAt;
    this.options = {
      memoryLimitMB: options.memoryLimitMB,
      startupTimeoutMs: options.startupTimeoutMs ?? 10000,
      maxMessageSizeBytes: options.maxMessageSizeBytes ?? DEFAULT_WORKER_POOL_CONFIG.maxMessageSizeBytes,
      gracefulShutdownTimeoutMs:
        options.gracefulShutdownTimeoutMs ?? DEFAULT_WORKER_POOL_CONFIG.gracefulShutdownTimeoutMs,
    };
    this.messageSizeLimitBytes = this.options.maxMessageSizeBytes;

    this.boundMessageHandler = this.handleMessage.bind(this);
    this.boundErrorHandler = this.handleError.bind(this);
    this.boundExitHandler = this.handleExit.bind(this);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  get worker(): Worker | null {
    return this._worker;
  }

  get status(): WorkerSlotStatus {
    return this._status;
  }

  get executionCount(): number {
    return this._executionCount;
  }

  get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  get currentExecutionId(): string | null {
    return this._currentExecutionId;
  }

  get memoryUsage(): ResourceUsage | null {
    return this._memoryUsage;
  }

  get heapLimitEnforcement(): HeapLimitEnforcement {
    return this._heapLimitEnforcement;
  }

  get memoryBudgetBytes(): number {
    return this._memoryBudgetBytes;
  }

  get isIdle(): boolean {
    return this._status === 'idle';
  }

  get isExecuting(): boolean {
    return this._status === 'executing';
  }

  get isTerminated(): boolean {
    return this._status === 'terminated' || this._status === 'terminating';
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Spawn the worker thread
   */
  async spawn(): Promise<void> {
    if (this._worker) {
      throw new Error(`Worker slot ${this.id} already has a worker`);
    }

    const workerScriptPath = this.getWorkerScriptPath();

    // The worker's heap limit is a resource limit of the worker itself. (It used to be passed as
    // `execArgv: ['--max-old-space-size=N']`, which Node.js refuses for a worker with
    // ERR_WORKER_INVALID_EXEC_ARGV: with any default memory limit no worker could be started.)
    // A worker that reaches the limit is terminated by the engine and reported through 'error'.
    const options: WorkerOptions = {};
    if (this.options.memoryLimitMB > 0) {
      options.resourceLimits = {
        maxOldGenerationSizeMb: this.options.memoryLimitMB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB,
      };
    }

    this._worker = new Worker(workerScriptPath, options);

    // Set up event handlers
    this._worker.on('message', this.boundMessageHandler);
    this._worker.on('error', this.boundErrorHandler);
    this._worker.on('exit', this.boundExitHandler);

    // Wait for ready message
    await this.waitForReady();

    await this.resolveHeapLimitEnforcement();

    // The worker may have exited while its heap limit was being read
    if (!this._worker || this.isTerminated) {
      throw new WorkerStartupError(`Worker ${this.id} exited while starting`);
    }

    this.setStatus('idle');
  }

  /**
   * Work out what this worker may hold and who stops it when it holds more (see
   * {@link HeapLimitEnforcement}). Asking for a limit is not enough to have one: a process-wide
   * heap flag silently replaces it, so the worker's actual limit is read back.
   */
  private async resolveHeapLimitEnforcement(): Promise<void> {
    const worker = this._worker;
    const limitBytes = this.options.memoryLimitMB * MB;
    if (!worker || limitBytes <= 0) {
      return;
    }

    // The engine's limit is on the old generation; the young generation comes on top of it.
    const youngGenerationMB = worker.resourceLimits?.maxYoungGenerationSizeMb ?? 0;
    this._memoryBudgetBytes = limitBytes + youngGenerationMB * MB;
    this._heapLimitEnforcement = 'engine';

    const statistics = await readHeapStatistics(worker, HEAP_STATISTICS_TIMEOUT_MS);
    const flagged = hasProcessHeapFlag(process.execArgv, process.env['NODE_OPTIONS']);
    if (statistics) {
      if (!isHeapLimitApplied(statistics.heap_size_limit, this._memoryBudgetBytes)) {
        this._heapLimitEnforcement = 'host';
        warnHeapLimitNotApplied(this.options.memoryLimitMB, 'host');
      }
    } else if (heapStatisticsReader(worker)) {
      // The worker did not say what its limit is (no answer in time). Not knowing is not the same
      // as the engine applying it, so the host watches this worker: a heap read every 100 ms,
      // which changes nothing when the engine does enforce the limit.
      this._heapLimitEnforcement = 'host';
      if (flagged) {
        warnHeapLimitNotApplied(this.options.memoryLimitMB, 'host');
      }
    } else if (flagged) {
      this._heapLimitEnforcement = 'none';
      warnHeapLimitNotApplied(this.options.memoryLimitMB, 'none');
    }
  }

  /**
   * Read what the worker holds while it executes (its heap plus its external memory), and end
   * the execution when that is more than the worker's budget.
   *
   * With `host` enforcement this is the heap limit itself: the engine would have ended the worker
   * at the old generation limit; from outside only the total is visible, so the young generation
   * is part of the budget and the limit is approximate (a script can also allocate between two
   * reads).
   *
   * With `engine` enforcement the engine bounds the heap, and this bounds what the engine does
   * not count: memory outside the heap. The memory monitor counts it too, but it asks the worker
   * by message, and a worker answers messages only when its script lets it. This read needs no
   * answer from the script.
   *
   * Not on a Node.js that cannot read a worker's heap from outside (before 22.16).
   */
  private startHeapWatchdog(): void {
    if (this.heapWatchdog || this._memoryBudgetBytes <= 0 || !this._worker || !heapStatisticsReader(this._worker)) {
      return;
    }

    let reading = false;
    this.heapWatchdog = setInterval(() => {
      const worker = this._worker;
      if (!worker || reading || this._status !== 'executing') {
        return;
      }
      reading = true;
      void readHeapStatistics(worker).then((statistics) => {
        reading = false;
        if (!statistics || this._worker !== worker || this._status !== 'executing') {
          return;
        }
        const used = statistics.used_heap_size + statistics.external_memory;
        if (used > this._memoryBudgetBytes) {
          this.emit('heapLimitExceeded', used);
          this.failExecution(new WorkerMemoryError(used, this.options.memoryLimitMB * MB));
        }
      });
    }, HEAP_WATCHDOG_INTERVAL_MS);
    // The check alone must not keep the host process alive
    this.heapWatchdog.unref();
  }

  private stopHeapWatchdog(): void {
    if (this.heapWatchdog) {
      clearInterval(this.heapWatchdog);
      this.heapWatchdog = null;
    }
  }

  /**
   * End the execution that is running in this worker with `error`, and the worker with it. The
   * waiting execution is told first: a worker that is being terminated reports nothing itself,
   * and the execution would wait for its timeout.
   */
  failExecution(error: Error): void {
    if (this.isTerminated) {
      return;
    }
    this.emit('error', error);
    this.terminate(false).catch(() => {
      // The worker is already gone
    });
  }

  /**
   * Get the path to the worker script
   */
  private getWorkerScriptPath(): string {
    return resolveWorkerScriptPath(__dirname);
  }

  /**
   * Wait for the worker to send ready message
   */
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timeout);
        this.off('ready', onReady);
        this.off('error', onError);
      };
      const onReady = () => {
        settle();
        resolve();
      };
      // A worker that fails while starting (its script throws, or it exits) reports why, instead
      // of leaving the caller to wait for the startup timeout.
      const onError = (error: Error) => {
        settle();
        reject(new WorkerStartupError(`Worker ${this.id} failed to start: ${error.message}`, error));
      };

      const timeout = setTimeout(() => {
        settle();
        reject(new WorkerStartupError(`Worker ${this.id} startup timeout`));
      }, this.options.startupTimeoutMs);

      this.once('ready', onReady);
      this.once('error', onError);
    });
  }

  /**
   * Acquire this slot for execution
   */
  acquire(executionId: string): void {
    if (this._status !== 'idle') {
      throw new Error(`Cannot acquire worker slot ${this.id} in state ${this._status}`);
    }

    this._currentExecutionId = executionId;
    this._lastActiveAt = Date.now();
    this.setStatus('executing');
    this.startHeapWatchdog();
  }

  /**
   * The largest message the worker may send while it runs the next execution, in bytes. The pool
   * sets it per execution, because what one message may legitimately carry depends on the
   * limits of the enclave the script belongs to. release() puts the slot's own limit back.
   */
  limitMessageSize(maxBytes: number): void {
    this.messageSizeLimitBytes = maxBytes;
  }

  /**
   * Release this slot after execution
   */
  release(): void {
    this.stopHeapWatchdog();
    this.messageSizeLimitBytes = this.options.maxMessageSizeBytes;
    if (this._status !== 'executing') {
      return;
    }

    this._currentExecutionId = null;
    this._executionCount++;
    this._lastActiveAt = Date.now();
    this.setStatus('idle');
  }

  /**
   * Mark this slot for recycling
   */
  markForRecycle(): void {
    if (this._status === 'terminated' || this._status === 'terminating') {
      return;
    }

    this.setStatus('recycling');
  }

  /**
   * Terminate the worker
   */
  async terminate(graceful = true): Promise<void> {
    if (!this._worker || this._status === 'terminated') {
      return;
    }

    // Only a worker with nothing to run is asked to leave. One that was given a script and has
    // not been released, or that broke the protocol, is ended: asked, it would go on running the
    // script until the grace period was over.
    const ask = graceful && this._currentExecutionId === null && !this.protocolViolated;

    this.setStatus('terminating');
    const worker = this._worker; // Capture reference to avoid race condition

    if (ask) {
      // Send terminate message and wait
      this.sendMessage({ type: 'terminate', graceful: true });

      // Wait for graceful exit (with timeout). The timer is cleared when the worker exits first:
      // left pending, it kept the host process alive for five seconds after every recycled worker.
      let gracePeriod: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          if (worker) {
            worker.once('exit', () => resolve());
          } else {
            resolve();
          }
        }),
        new Promise<void>((resolve) => {
          gracePeriod = setTimeout(resolve, this.options.gracefulShutdownTimeoutMs);
        }),
      ]);
      clearTimeout(gracePeriod);
    }

    // Force terminate if still running
    if (this._worker) {
      try {
        await this._worker.terminate();
      } catch {
        // Worker already exited
      }
    }

    this.cleanup();
    this.setStatus('terminated');
  }

  /**
   * Send a message to the worker
   */
  sendMessage(msg: MainToWorkerMessage): void {
    if (!this._worker) {
      throw new Error(`Worker slot ${this.id} has no worker`);
    }

    this._worker.postMessage(safeSerialize(msg));
  }

  /**
   * Request memory report from worker
   */
  async requestMemoryReport(timeoutMs = 1000): Promise<ResourceUsage> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timeout);
        this.off('message', handler);
        this.pendingMemoryReports.delete(abandon);
      };
      const handler = (msg: WorkerToMainMessage) => {
        if (msg.type === 'memory-report-result') {
          settle();
          this._memoryUsage = msg.usage;
          resolve(msg.usage);
        }
      };
      // The request ends without an answer: no answer in time, the request could not be sent,
      // or the worker is gone (see cleanup). A worker whose script keeps it busy answers nothing.
      const abandon = (error: Error) => {
        settle();
        reject(error);
      };

      const timeout = setTimeout(() => abandon(new Error('Memory report timeout')), timeoutMs);
      // Waiting for an answer must not keep the host process alive
      timeout.unref();

      this.pendingMemoryReports.add(abandon);
      this.on('message', handler);
      try {
        this.sendMessage({ type: 'memory-report' });
      } catch (error) {
        abandon(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  private handleMessage(raw: unknown): void {
    let msg: WorkerToMainMessage;
    try {
      // The worker is the less trusted side of this boundary: if a script ever gets out of the
      // sandbox inside it, the worker's messages are the script's. A message is text, no larger
      // than the limit: anything else is refused before this thread does any work on it. Then it
      // is parsed without prototype pollution and checked against the protocol schema (shape,
      // types, identifier and tool-name patterns, size limits) before anything here acts on it.
      if (typeof raw !== 'string') {
        throw new MessageValidationError('worker message is not text');
      }
      const parsed = workerToMainMessageSchema.safeParse(safeDeserialize(raw, this.messageSizeLimitBytes));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new MessageValidationError(
          `worker message rejected by the protocol schema${issue ? ` (${issue.path.join('.') || 'message'}: ${issue.message})` : ''}`,
        );
      }
      msg = parsed.data as WorkerToMainMessage;
    } catch (error) {
      // The execution that is waiting on this worker fails now, and the worker is replaced:
      // ended at once (see terminate), whatever it is running.
      this.protocolViolated = true;
      this.emit('error', error instanceof Error ? error : new MessageValidationError(String(error)));
      this.markForRecycle();
      return;
    }

    if (msg.type === 'ready') {
      this.emit('ready');
    } else if (msg.type === 'memory-report-result') {
      this._memoryUsage = msg.usage;
    }

    this.emit('message', msg);
  }

  private handleError(error: Error): void {
    this.emit('error', error);

    // Mark for recycling on error
    if (this._status !== 'terminated' && this._status !== 'terminating') {
      this.markForRecycle();
    }
  }

  private handleExit(code: number | null): void {
    this.emit('exit', code);

    if (this._status !== 'terminating' && this._status !== 'terminated') {
      // Unexpected exit
      this.cleanup();
      this.setStatus('terminated');
      this.emit('error', new WorkerCrashedError(`Worker ${this.id} exited unexpectedly`, code ?? undefined));
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private setStatus(newStatus: WorkerSlotStatus): void {
    const oldStatus = this._status;
    this._status = newStatus;
    this.emit('stateChange', newStatus, oldStatus);
  }

  private cleanup(): void {
    this.stopHeapWatchdog();
    // Nobody will answer these any more. Left alone, each would wait out its own timeout.
    for (const abandon of [...this.pendingMemoryReports]) {
      abandon(new Error('Memory report abandoned: the worker is gone'));
    }
    if (this._worker) {
      this._worker.off('message', this.boundMessageHandler);
      this._worker.off('error', this.boundErrorHandler);
      this._worker.off('exit', this.boundExitHandler);
      this._worker = null;
    }
    this._currentExecutionId = null;
  }
}
