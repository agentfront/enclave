/**
 * Worker Script
 *
 * Runs inside a worker thread of the pool.
 *
 * What a worker adds to an execution: a heap limit that the engine enforces, and a way for the
 * host to stop the execution whatever the script is doing (`worker.terminate()`).
 *
 * What it does NOT add is a sandbox. A worker thread has the whole Node.js API (`process`,
 * `require`, the file system), and a `vm` context created here from this thread's own objects
 * hands the script this thread's `Function` constructor one property read away. So the script
 * runs here in the SAME sandbox as an in-process execution: the double VM (parent realm with the
 * membrane and the tool gate, inner realm for the script), or a single VM when the double VM is
 * disabled. The worker is a layer around that sandbox.
 *
 * Tool calls leave the sandbox through the string tool bridge, are sent to the host thread as
 * messages, and are answered there by the host's tool bridge (see ../../tool-bridge): the same
 * checks, sidecar handling and sanitization as for an in-process tool call.
 *
 * @packageDocumentation
 */

import { parentPort } from 'worker_threads';
import crypto from 'crypto';
import { TOOL_NAMESPACE_TOOL_NAME_PATTERN } from '@enclave-vm/ast';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  ExecuteMessage,
  ToolResponseMessage,
  SerializedConfig,
  SerializedDoubleVmConfig,
  SerializedError,
} from './protocol';
import { safeDeserialize, safeSerialize, sanitizeObject } from './safe-deserialize';
import { encodeResult } from './result-encoding';
import { DoubleVmWrapper } from '../../double-vm/double-vm-wrapper';
import { VmAdapter } from '../vm-adapter';
import { decodeToolBridgeRequest, encodeToolBridgeFailure } from '../../tool-bridge';
import type { DoubleVmConfig } from '../../double-vm/types';
import type { ConsoleLevel } from '../../console-handler';
import {
  DEFAULT_DOUBLE_VM_CONFIG,
  type ExecutionContext,
  type ExecutionError,
  type ExecutionStats,
  type SandboxAdapter,
} from '../../types';

// ============================================================================
// SECURITY: Capture parentPort then remove dangerous globals
// ============================================================================

const port = parentPort;
if (!port) {
  throw new Error('worker-script.ts must run inside a worker thread');
}

/** This thread's own way to wait for the next turn of its event loop (see confirmIdle) */
const nextEventLoopTurn = setImmediate;

/**
 * Globals of this thread that nothing here needs after startup. Defense in depth: the script
 * never runs in this realm, but a value that is not here cannot be reached from it either.
 */
const DANGEROUS_GLOBALS = [
  'parentPort',
  'workerData',
  'threadId',
  'isMainThread',
  'MessagePort',
  'MessageChannel',
  'BroadcastChannel',
  'Worker',
  'SharedArrayBuffer',
  'Atomics',
];

for (const name of DANGEROUS_GLOBALS) {
  try {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // Some may already be undefined or not configurable
  }
}

// ============================================================================
// Execution State
// ============================================================================

interface CurrentExecution {
  id: string;
  aborted: boolean;
  stats: ExecutionStats;
  abortController: AbortController;
  /** Tool calls of this execution that the host has not answered yet, by call id */
  pendingToolCalls: Map<string, (responseJson: string) => void>;
  maxPayloadBytes: number;
}

let currentExecution: CurrentExecution | null = null;

const DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

// Limits of the result message schema (see ./protocol): a longer field would make the host
// reject the whole message.
const MAX_ERROR_NAME_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 10000;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_ERROR_STACK_LENGTH = 10000;
const MAX_CONSOLE_ARGS = 100;

// ============================================================================
// Console
// ============================================================================

/**
 * This thread's console writes to the host thread while an execution is running: the sandbox
 * adapters write a script's console output (without a consoleHandler) to `console`, and the host
 * prints it. Outside an execution the original methods are used.
 */
const FORWARDED_CONSOLE_LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
for (const level of FORWARDED_CONSOLE_LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    const execution = currentExecution;
    if (!execution) {
      original(...args);
      return;
    }
    try {
      sendMessage({
        type: 'console',
        requestId: execution.id,
        level,
        args: args.slice(0, MAX_CONSOLE_ARGS).map((arg) => (typeof arg === 'string' ? arg : String(arg))),
      });
    } catch {
      // Console output is best effort
    }
  };
}

// ============================================================================
// Message Handling
// ============================================================================

port.on('message', async (raw: string) => {
  try {
    const msg = safeDeserialize(raw) as MainToWorkerMessage;

    switch (msg.type) {
      case 'execute':
        await handleExecute(msg as ExecuteMessage);
        break;

      case 'tool-response':
        handleToolResponse(msg as ToolResponseMessage);
        break;

      case 'memory-report':
        handleMemoryReport();
        break;

      case 'abort':
        handleAbort((msg as { requestId: string }).requestId);
        break;

      case 'terminate':
        handleTerminate((msg as { graceful: boolean }).graceful);
        break;

      default:
        process.stderr.write(`Unknown message type: ${String((msg as { type: unknown }).type)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Worker message handler error: ${String((error as Error)?.message ?? error)}\n`);
  }
});

// ============================================================================
// Execute Handler
// ============================================================================

/**
 * Runs one script in the sandbox the configuration asks for and posts its result (or error) to
 * the host.
 */
async function handleExecute(msg: ExecuteMessage): Promise<void> {
  const startTime = Date.now();
  // One execution at a time. The pool does not send a script to a worker that has not finished
  // the last one; if one arrives all the same it is refused, not started on top of the other.
  // (No idle confirmation follows: this worker is not idle.)
  if (currentExecution) {
    sendMessage({
      type: 'result',
      requestId: msg.requestId,
      success: false,
      error: { name: 'WorkerBusyError', message: 'The worker is still running another execution' },
      stats: resultStats({ duration: 0, toolCallCount: 0, iterationCount: 0, startTime, endTime: startTime }),
    });
    return;
  }
  const config = msg.config;
  const stats: ExecutionStats = {
    duration: 0,
    toolCallCount: 0,
    iterationCount: 0,
    startTime,
    endTime: 0,
  };
  const execution: CurrentExecution = {
    id: msg.requestId,
    aborted: false,
    stats,
    abortController: new AbortController(),
    pendingToolCalls: new Map(),
    maxPayloadBytes: config.toolBridgeMaxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  };
  currentExecution = execution;

  // The same deadline rule as an in-process execution: a timer sets the flag, and the flag also
  // reads the clock, because a timer cannot fire while the script keeps the thread busy.
  const deadline = startTime + config.timeout;
  const timeoutId = setTimeout(() => {
    execution.aborted = true;
    execution.abortController.abort();
  }, config.timeout);

  let adapter: SandboxAdapter | undefined;
  try {
    const context: ExecutionContext = {
      config: buildAdapterConfig(config),
      stats,
      abortController: execution.abortController,
      get aborted(): boolean {
        return execution.aborted || Date.now() >= deadline;
      },
      set aborted(value: boolean) {
        execution.aborted = value;
      },
      hostToolBridge: (requestJson) => relayToolRequest(execution, requestJson),
      consoleHandler: config.hasConsoleHandler
        ? (level, text) => {
            // What a script prints after its execution has ended reaches nobody
            if (currentExecution !== execution) return;
            sendMessage({ type: 'console', requestId: execution.id, level, args: [text] });
          }
        : undefined,
      secureProxyConfig: config.secureProxyConfig,
      toolNamespaces: config.toolNamespaces,
      realmGlobalAllowlist: config.realmGlobalAllowlist,
      referenceConfig: config.referenceConfig,
    };

    adapter = createSandboxAdapter(config);
    const result = await adapter.execute(msg.code, context);

    stats.endTime = Date.now();
    stats.duration = stats.endTime - startTime;

    if (result.success) {
      // The adapter has sanitized the value (limits, '[Circular]', errors); what JSON cannot
      // carry (Dates, NaN, ...) travels in a side list.
      const { value, specialValues } = encodeResult(result.value);
      sendMessage({
        type: 'result',
        requestId: msg.requestId,
        success: true,
        value,
        ...(specialValues.length > 0 ? { specialValues } : {}),
        stats: resultStats(stats),
      });
    } else {
      sendMessage({
        type: 'result',
        requestId: msg.requestId,
        success: false,
        error: serializeExecutionError(result.error),
        stats: resultStats(stats),
      });
    }
  } catch (error) {
    stats.endTime = Date.now();
    stats.duration = stats.endTime - startTime;
    try {
      sendMessage({
        type: 'result',
        requestId: msg.requestId,
        success: false,
        error: serializeThrown(error, config.sanitizeStackTraces),
        stats: resultStats(stats),
      });
    } catch {
      // Nothing more can be reported; the host's watchdog ends the execution.
    }
  } finally {
    clearTimeout(timeoutId);
    // The result has been sent. A callback the script left behind stops at its next check
    // instead of running on until the deadline, in a worker that may be given the next script.
    execution.aborted = true;
    execution.abortController.abort();
    try {
      adapter?.dispose();
    } catch {
      // Disposal is best effort
    }
    // Tool calls nobody will answer any more
    for (const [callId, resolve] of execution.pendingToolCalls) {
      execution.pendingToolCalls.delete(callId);
      resolve(encodeToolBridgeFailure('AbortError', 'Execution ended', 'EXECUTION_ABORTED', execution.maxPayloadBytes));
    }
    if (currentExecution === execution) {
      currentExecution = null;
    }
    confirmIdle(msg.requestId);
  }
}

/**
 * Tell the pool that nothing of an execution is left in this worker.
 *
 * The result alone does not say that: a script can return and leave callbacks behind, and as
 * long as they keep running, this thread cannot start the next script. The confirmation is sent
 * from the next turn of the event loop, which is only reached when every job the script queued
 * has run and queued nothing more. The pool gives this worker to nobody before it arrives, and
 * ends the worker when it does not.
 */
function confirmIdle(requestId: string): void {
  nextEventLoopTurn(() => {
    try {
      sendMessage({ type: 'idle', requestId });
    } catch {
      // Without the confirmation the pool replaces this worker
    }
  });
}

/**
 * The sandbox for this execution: the double VM unless the host disabled it, in which case a
 * single VM (the host has already logged the security warning for that choice).
 */
function createSandboxAdapter(config: SerializedConfig): SandboxAdapter {
  const doubleVm = config.doubleVm;
  if (doubleVm && doubleVm.enabled === false) {
    return new VmAdapter(config.securityLevel);
  }
  if (!doubleVm) {
    return new DoubleVmWrapper(DEFAULT_DOUBLE_VM_CONFIG, config.securityLevel);
  }
  return new DoubleVmWrapper(
    deserializeDoubleVmConfig(doubleVm),
    config.securityLevel,
    doubleVm.parentValidation.suspiciousPatterns,
  );
}

function deserializeDoubleVmConfig(doubleVm: SerializedDoubleVmConfig): DoubleVmConfig {
  const validation = doubleVm.parentValidation;
  return {
    enabled: true,
    parentTimeoutBuffer: doubleVm.parentTimeoutBuffer,
    parentValidation: {
      validateOperationNames: validation.validateOperationNames,
      allowedOperationPattern: validation.allowedOperationPattern
        ? new RegExp(validation.allowedOperationPattern.source, validation.allowedOperationPattern.flags)
        : undefined,
      blockedOperationPatterns: validation.blockedOperationPatterns?.map(
        (pattern) => new RegExp(pattern.source, pattern.flags),
      ),
      maxOperationsPerSecond: validation.maxOperationsPerSecond,
      blockSuspiciousSequences: validation.blockSuspiciousSequences,
      rapidEnumerationThreshold: validation.rapidEnumerationThreshold,
      rapidEnumerationOverrides: { ...validation.rapidEnumerationOverrides },
      // The custom patterns arrive serialized and are passed to the wrapper in that form.
      suspiciousPatterns: [],
    },
  };
}

/**
 * The configuration an adapter reads from its execution context.
 *
 * Custom globals arrive as JSON data: a function does not cross the thread boundary, so the
 * worker adapter never passes a host function into the sandbox.
 */
function buildAdapterConfig(config: SerializedConfig): ExecutionContext['config'] {
  return {
    timeout: config.timeout,
    memoryLimit: config.memoryLimit ?? 0,
    maxToolCalls: config.maxToolCalls,
    maxIterations: config.maxIterations,
    adapter: 'vm',
    allowBuiltins: false,
    globals: config.globals ? (sanitizeObject(config.globals) as Record<string, unknown>) : {},
    // Tool calls always travel as strings from a worker: an object cannot be handed across.
    toolBridge: {
      mode: 'string',
      maxPayloadBytes: config.toolBridgeMaxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    },
    maxConsoleOutputBytes: config.maxConsoleOutputBytes,
    maxConsoleCalls: config.maxConsoleCalls,
    sanitizeStackTraces: config.sanitizeStackTraces,
    maxSanitizeDepth: config.maxSanitizeDepth,
    maxSanitizeProperties: config.maxSanitizeProperties,
    maxGlobalFunctionCalls: config.maxGlobalFunctionCalls,
  } as ExecutionContext['config'];
}

// ============================================================================
// Tool Calls
// ============================================================================

/**
 * Carry one tool request to the host thread and resolve with the host's response. Both are in
 * the string tool-bridge format; this side only moves them.
 */
function relayToolRequest(execution: CurrentExecution, requestJson: string): Promise<string> {
  const refuse = (message: string, code: string): Promise<string> =>
    Promise.resolve(encodeToolBridgeFailure('ToolBridgeError', message, code, execution.maxPayloadBytes));

  const decoded = decodeToolBridgeRequest(requestJson);
  if (!decoded.ok) {
    return refuse(decoded.error, 'TOOL_BRIDGE_BAD_REQUEST');
  }
  // The host validates every message against the protocol schema, and a message it rejects ends
  // the execution. A tool name the protocol cannot carry is refused here instead, so the script
  // gets an ordinary error for that one call.
  if (decoded.tool.length > 256 || !TOOL_NAMESPACE_TOOL_NAME_PATTERN.test(decoded.tool)) {
    return refuse(
      `Tool name "${decoded.tool.slice(0, 80)}" cannot be used with the worker_threads adapter: ` +
        `it must start with a letter and contain only letters, digits, ':', '.', '_' and '-'.`,
      'INVALID_TOOL_NAME',
    );
  }
  if (currentExecution !== execution) {
    return refuse('Execution ended', 'EXECUTION_ABORTED');
  }

  const callId = crypto.randomUUID();
  return new Promise<string>((resolve) => {
    execution.pendingToolCalls.set(callId, resolve);
    try {
      sendMessage({
        type: 'tool-call',
        requestId: execution.id,
        callId,
        toolName: decoded.tool,
        args: sanitizeObject(decoded.args) as Record<string, unknown>,
      });
    } catch (error) {
      execution.pendingToolCalls.delete(callId);
      resolve(
        encodeToolBridgeFailure(
          'ToolBridgeError',
          `Tool request could not be sent: ${String((error as Error)?.message ?? error)}`,
          'TOOL_BRIDGE_FAILURE',
          execution.maxPayloadBytes,
        ),
      );
    }
  });
}

function handleToolResponse(msg: ToolResponseMessage): void {
  const execution = currentExecution;
  if (!execution || execution.id !== msg.requestId) {
    return;
  }
  const resolve = execution.pendingToolCalls.get(msg.callId);
  if (!resolve) {
    return;
  }
  execution.pendingToolCalls.delete(msg.callId);
  resolve(
    typeof msg.response === 'string'
      ? msg.response
      : encodeToolBridgeFailure(
          'ToolBridgeError',
          'Malformed tool response',
          'TOOL_BRIDGE_FAILURE',
          execution.maxPayloadBytes,
        ),
  );
}

// ============================================================================
// Memory Report Handler
// ============================================================================

function handleMemoryReport(): void {
  const usage = process.memoryUsage();
  sendMessage({
    type: 'memory-report-result',
    usage: {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    },
  });
}

// ============================================================================
// Abort Handler
// ============================================================================

function handleAbort(requestId: string): void {
  const execution = currentExecution;
  if (!execution || execution.id !== requestId) {
    return;
  }
  execution.aborted = true;
  execution.abortController.abort();

  // A tool call that is still waiting for the host will not be answered in time.
  for (const [callId, resolve] of execution.pendingToolCalls) {
    execution.pendingToolCalls.delete(callId);
    resolve(encodeToolBridgeFailure('AbortError', 'Execution aborted', 'EXECUTION_ABORTED', execution.maxPayloadBytes));
  }
}

// ============================================================================
// Terminate Handler
// ============================================================================

function handleTerminate(graceful: boolean): void {
  if (graceful && currentExecution) {
    // Mark as aborted and let it finish naturally
    currentExecution.aborted = true;
    currentExecution.abortController.abort();
  } else {
    // Force exit
    process.exit(0);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function sendMessage(msg: WorkerToMainMessage): void {
  if (!port) {
    throw new Error('Worker port not initialized');
  }
  port.postMessage(safeSerialize(msg));
}

function resultStats(stats: ExecutionStats): {
  duration: number;
  toolCallCount: number;
  iterationCount: number;
  startTime: number;
  endTime: number;
} {
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    duration: count(stats.duration),
    toolCallCount: count(stats.toolCallCount),
    iterationCount: count(stats.iterationCount),
    startTime: count(stats.startTime),
    endTime: count(stats.endTime),
  };
}

function truncate(value: unknown, maxLength: number, fallback: string): string {
  const text = typeof value === 'string' && value ? value : fallback;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** The error of a failed execution, as the adapter reported it. */
function serializeExecutionError(error: ExecutionError | undefined): SerializedError {
  const serialized: SerializedError = {
    name: truncate(error?.name, MAX_ERROR_NAME_LENGTH, 'Error'),
    message: truncate(error?.message, MAX_ERROR_MESSAGE_LENGTH, 'Unknown error'),
  };
  if (typeof error?.code === 'string' && error.code) {
    serialized.code = truncate(error.code, MAX_ERROR_CODE_LENGTH, '');
  }
  if (typeof error?.stack === 'string' && error.stack) {
    serialized.stack = truncate(error.stack, MAX_ERROR_STACK_LENGTH, '');
  }
  if (error?.data && typeof error.data === 'object') {
    try {
      // Through JSON: only data crosses the thread boundary
      serialized.data = sanitizeObject(JSON.parse(JSON.stringify(error.data))) as Record<string, unknown>;
    } catch {
      // Details that cannot be serialized are left out
    }
  }
  return serialized;
}

/** Something thrown by this script itself (not by the sandbox, which reports errors as results). */
function serializeThrown(error: unknown, sanitizeStackTraces: boolean): SerializedError {
  if (typeof error === 'string') {
    return { name: 'Error', message: truncate(error, MAX_ERROR_MESSAGE_LENGTH, 'Unknown error') };
  }
  const err = (error ?? {}) as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
  const serialized: SerializedError = {
    name: truncate(err.name, MAX_ERROR_NAME_LENGTH, 'Error'),
    message: truncate(err.message, MAX_ERROR_MESSAGE_LENGTH, 'Unknown error'),
  };
  if (typeof err.code === 'string' && err.code) {
    serialized.code = truncate(err.code, MAX_ERROR_CODE_LENGTH, '');
  }
  if (typeof err.stack === 'string' && err.stack && !sanitizeStackTraces) {
    serialized.stack = truncate(err.stack, MAX_ERROR_STACK_LENGTH, '');
  }
  return serialized;
}

// ============================================================================
// Signal Ready
// ============================================================================

sendMessage({ type: 'ready' });
