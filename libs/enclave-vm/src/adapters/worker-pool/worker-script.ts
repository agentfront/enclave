/**
 * Worker Script
 *
 * This script runs inside a worker thread and provides a dual-layer sandbox:
 * 1. Worker thread isolation (OS-level)
 * 2. VM context isolation (prototype isolation)
 *
 * Tool calls are proxied to the main thread via message passing.
 *
 * @packageDocumentation
 */

import { parentPort } from 'worker_threads';
import vm from 'vm';
import crypto from 'crypto';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  ExecuteMessage,
  ToolResponseMessage,
  SerializedConfig,
  WorkerExecutionStats,
  SerializedError,
} from './protocol';
import { safeDeserialize, safeSerialize, sanitizeObject } from './safe-deserialize';

// ============================================================================
// SECURITY: Capture parentPort then remove dangerous globals
// ============================================================================

const port = parentPort;
if (!port) {
  throw new Error('worker-script.ts must run inside a worker thread');
}

/**
 * Globals that are dangerous and must be removed before any user code runs
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
  stats: WorkerExecutionStats;
  config: SerializedConfig;
}

let currentExecution: CurrentExecution | null = null;
const pendingToolCalls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
        console.error('Unknown message type:', (msg as { type: string }).type);
    }
  } catch (error) {
    console.error('Worker message handler error:', error);
  }
});

// ============================================================================
// Execute Handler
// ============================================================================

async function handleExecute(msg: ExecuteMessage): Promise<void> {
  const startTime = Date.now();

  currentExecution = {
    id: msg.requestId,
    aborted: false,
    config: msg.config,
    stats: {
      duration: 0,
      toolCallCount: 0,
      iterationCount: 0,
      startTime,
      endTime: 0,
    },
  };

  try {
    // Create VM context with safe runtime
    // codeGeneration.strings=false disables new Function() and eval() from strings
    // This prevents sandbox escape via constructor chain: [][c][c]('malicious code')
    const sandbox = createSandbox(msg.requestId, msg.config);
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // Wrap code in async IIFE to support top-level await
    // Must call __ag_main() if defined, as the enclave transforms code to wrap in async function __ag_main()
    const wrappedCode = `
      (async () => {
        ${msg.code}
        return typeof __ag_main === 'function' ? await __ag_main() : undefined;
      })();
    `;

    // Compile and run with timeout
    const script = new vm.Script(wrappedCode, {
      filename: 'agentscript.js',
    });

    const result = await script.runInContext(context, {
      timeout: msg.config.timeout,
      breakOnSigint: true,
    });

    // Update stats
    currentExecution.stats.endTime = Date.now();
    currentExecution.stats.duration = currentExecution.stats.endTime - startTime;

    // Send success result
    sendMessage({
      type: 'result',
      requestId: msg.requestId,
      success: true,
      value: sanitizeObject(result),
      stats: currentExecution.stats,
    });
  } catch (error) {
    // Update stats
    if (currentExecution) {
      currentExecution.stats.endTime = Date.now();
      currentExecution.stats.duration = currentExecution.stats.endTime - startTime;
    }

    // Send error result
    sendMessage({
      type: 'result',
      requestId: msg.requestId,
      success: false,
      error: serializeError(error as Error, msg.config.sanitizeStackTraces),
      stats: currentExecution?.stats ?? {
        duration: Date.now() - startTime,
        toolCallCount: 0,
        iterationCount: 0,
        startTime,
        endTime: Date.now(),
      },
    });
  } finally {
    // Clear pending tool calls for this execution
    // Use delimiter to avoid false positives (e.g., "req-1" matching "req-10-abc")
    for (const [callId, pending] of pendingToolCalls) {
      if (callId.startsWith(`${msg.requestId}-`)) {
        pending.reject(new Error('Execution ended'));
        pendingToolCalls.delete(callId);
      }
    }
    currentExecution = null;
  }
}

// ============================================================================
// Tool Response Handler
// ============================================================================

function handleToolResponse(msg: ToolResponseMessage): void {
  const pending = pendingToolCalls.get(msg.callId);
  if (!pending) {
    console.warn('Received response for unknown tool call:', msg.callId);
    return;
  }

  pendingToolCalls.delete(msg.callId);

  if (msg.error) {
    const error = new Error(msg.error.message);
    error.name = msg.error.name;
    pending.reject(error);
  } else {
    pending.resolve(sanitizeObject(msg.result));
  }
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
  if (currentExecution && currentExecution.id === requestId) {
    currentExecution.aborted = true;
  }

  // Reject all pending tool calls for this request
  // Use delimiter to avoid false positives (e.g., "req-1" matching "req-10-abc")
  for (const [callId, pending] of pendingToolCalls) {
    if (callId.startsWith(`${requestId}-`)) {
      pending.reject(new Error('Execution aborted'));
      pendingToolCalls.delete(callId);
    }
  }
}

// ============================================================================
// Terminate Handler
// ============================================================================

function handleTerminate(graceful: boolean): void {
  if (graceful && currentExecution) {
    // Mark as aborted and let it finish naturally
    currentExecution.aborted = true;
  } else {
    // Force exit
    process.exit(0);
  }
}

// ============================================================================
// Sandbox Creation - Security-Level-Aware
// ============================================================================

/**
 * Maps global names to their actual values.
 * This mapping is used by createSandbox to selectively expose globals
 * based on the security level.
 */
function getGlobalValue(name: string, requestId: string, config: SerializedConfig): unknown {
  // Runtime-injected safe functions (created dynamically)
  switch (name) {
    case '__safe_callTool':
    case 'callTool': // Both are mapped to the safe version
      return createProxiedCallTool(requestId, config);
    case '__safe_forOf':
      return createSafeForOf();
    case '__safe_for':
      return createSafeFor();
    case '__safe_while':
    case '__safe_doWhile':
      return createSafeWhile();
    case '__maxIterations':
      return config.maxIterations ?? 10000;
    case 'console':
    case '__safe_console':
      return createSafeConsole(requestId, config);

    // Core built-in objects (always safe)
    case 'Math':
      return Math;
    case 'JSON':
      return JSON;
    case 'Object':
      return Object;
    case 'Array':
      return Array;
    case 'String':
      return String;
    case 'Number':
      return Number;
    case 'Date':
      return Date;

    // Safe standard globals
    case 'undefined':
      return undefined;
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;

    // Utility functions (STANDARD level and above)
    case 'parseInt':
      return parseInt;
    case 'parseFloat':
      return parseFloat;
    case 'isNaN':
      return isNaN;
    case 'isFinite':
      return isFinite;
    case 'encodeURI':
      return encodeURI;
    case 'decodeURI':
      return decodeURI;
    case 'encodeURIComponent':
      return encodeURIComponent;
    case 'decodeURIComponent':
      return decodeURIComponent;

    default:
      return undefined;
  }
}

/**
 * Get allowed globals based on security level.
 * This mirrors the AST guard's getAgentScriptGlobals for defense-in-depth.
 */
function getAllowedGlobalsForSecurityLevel(securityLevel: string): readonly string[] {
  // STRICT globals - absolute minimum
  const strictGlobals = [
    'callTool',
    '__safe_callTool',
    'Math',
    'JSON',
    'Array',
    'Object',
    'String',
    'Number',
    'Date',
    'undefined',
    'NaN',
    'Infinity',
    '__safe_forOf',
    '__safe_for',
    '__safe_while',
    '__safe_doWhile',
    '__maxIterations',
  ] as const;

  // SECURE globals - adds safe utility functions (pure, no side effects)
  const secureGlobals = [
    ...strictGlobals,
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'encodeURI',
    'decodeURI',
    'encodeURIComponent',
    'decodeURIComponent',
  ] as const;

  // STANDARD globals - same as SECURE (room for future expansion)
  const standardGlobals = [...secureGlobals] as const;

  // PERMISSIVE globals - adds console for debugging
  const permissiveGlobals = [...standardGlobals, 'console', '__safe_console'] as const;

  switch (securityLevel) {
    case 'PERMISSIVE':
      return permissiveGlobals;
    case 'STANDARD':
      return standardGlobals;
    case 'SECURE':
      return secureGlobals;
    case 'STRICT':
    default:
      return strictGlobals;
  }
}

/**
 * Create a security-level-aware sandbox for code execution.
 *
 * IMPORTANT: This function enforces the same allowed globals as the AST guard
 * for defense-in-depth. If code bypasses AST validation, the sandbox still
 * blocks access to dangerous globals.
 */
function createSandbox(requestId: string, config: SerializedConfig): Record<string, unknown> {
  const sandbox: Record<string, unknown> = Object.create(null);

  // Get allowed globals based on security level
  const allowedGlobals = getAllowedGlobalsForSecurityLevel(config.securityLevel);

  // Only add globals that are in the allowed list
  for (const name of allowedGlobals) {
    const value = getGlobalValue(name, requestId, config);
    if (value !== undefined || name === 'undefined') {
      sandbox[name] = value;
    }
  }

  // Add custom globals if provided (these are assumed to be validated by AST guard)
  if (config.globals) {
    for (const [key, value] of Object.entries(config.globals)) {
      // Only allow serializable values (functions are not allowed)
      if (typeof value !== 'function') {
        sandbox[key] = sanitizeObject(value);
      }
    }
  }

  return sandbox;
}

// ============================================================================
// Safe Runtime Functions
// ============================================================================

function createProxiedCallTool(requestId: string, config: SerializedConfig) {
  return async function __safe_callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Check if aborted
    if (currentExecution?.aborted) {
      throw new Error('Execution aborted');
    }

    // Increment tool call count
    if (currentExecution) {
      currentExecution.stats.toolCallCount++;
    }

    // Check tool call limit
    if (currentExecution && currentExecution.stats.toolCallCount > config.maxToolCalls) {
      throw new Error(
        `Maximum tool call limit exceeded (${config.maxToolCalls}). ` + `This limit prevents runaway script execution.`,
      );
    }

    // Validate inputs
    if (typeof toolName !== 'string' || !toolName) {
      throw new TypeError('Tool name must be a non-empty string');
    }

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new TypeError('Tool arguments must be an object');
    }

    // Generate unique call ID
    const callId = `${requestId}-${Date.now()}-${crypto.randomUUID()}`;

    return new Promise((resolve, reject) => {
      pendingToolCalls.set(callId, { resolve, reject });

      sendMessage({
        type: 'tool-call',
        requestId,
        callId,
        toolName,
        args: sanitizeObject(args) as Record<string, unknown>,
      });
    });
  };
}

function createSafeForOf() {
  return function* __safe_forOf<T>(iterable: Iterable<T>): Iterable<T> {
    let iterations = 0;

    for (const item of iterable) {
      // Check if aborted
      if (currentExecution?.aborted) {
        throw new Error('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      if (currentExecution) {
        currentExecution.stats.iterationCount++;
      }

      // Check iteration limit
      const maxIterations = currentExecution?.config.maxIterations ?? 10000;
      if (iterations > maxIterations) {
        throw new Error(
          `Maximum iteration limit exceeded (${maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      yield item;
    }
  };
}

function createSafeFor() {
  return function __safe_for(init: () => void, test: () => boolean, update: () => void, body: () => void): void {
    let iterations = 0;

    init();

    while (test()) {
      // Check if aborted
      if (currentExecution?.aborted) {
        throw new Error('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      if (currentExecution) {
        currentExecution.stats.iterationCount++;
      }

      // Check iteration limit
      const maxIterations = currentExecution?.config.maxIterations ?? 10000;
      if (iterations > maxIterations) {
        throw new Error(
          `Maximum iteration limit exceeded (${maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      body();
      update();
    }
  };
}

function createSafeWhile() {
  return function __safe_while(test: () => boolean, body: () => void): void {
    let iterations = 0;

    while (test()) {
      // Check if aborted
      if (currentExecution?.aborted) {
        throw new Error('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      if (currentExecution) {
        currentExecution.stats.iterationCount++;
      }

      // Check iteration limit
      const maxIterations = currentExecution?.config.maxIterations ?? 10000;
      if (iterations > maxIterations) {
        throw new Error(
          `Maximum iteration limit exceeded (${maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      body();
    }
  };
}

function createSafeConsole(requestId: string, config: SerializedConfig) {
  let totalBytes = 0;
  let callCount = 0;

  function safeLog(level: 'log' | 'warn' | 'error' | 'info', args: unknown[]): void {
    // Check call limit
    callCount++;
    if (callCount > config.maxConsoleCalls) {
      throw new Error(`Console call limit exceeded (${config.maxConsoleCalls})`);
    }

    // Serialize and check size
    const serialized = args.map((a) => {
      try {
        return JSON.stringify(sanitizeObject(a));
      } catch {
        return String(a);
      }
    });

    const bytes = serialized.reduce((sum, s) => sum + (s?.length ?? 0), 0);
    totalBytes += bytes;

    if (totalBytes > config.maxConsoleOutputBytes) {
      throw new Error(`Console output limit exceeded (${config.maxConsoleOutputBytes} bytes)`);
    }

    // Send to main thread
    sendMessage({
      type: 'console',
      requestId,
      level,
      args: serialized,
    });
  }

  return {
    log: (...args: unknown[]) => safeLog('log', args),
    warn: (...args: unknown[]) => safeLog('warn', args),
    error: (...args: unknown[]) => safeLog('error', args),
    info: (...args: unknown[]) => safeLog('info', args),
  };
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

function serializeError(error: Error | unknown, sanitizeStackTraces: boolean): SerializedError {
  // Handle thrown strings (from iteration limit checks in transformed loops)
  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  const err = error as Error;
  const serialized: SerializedError = {
    name: err.name || 'Error',
    message: err.message || 'Unknown error',
  };

  if ((err as NodeJS.ErrnoException).code) {
    serialized.code = (err as NodeJS.ErrnoException).code;
  }

  if (err.stack && !sanitizeStackTraces) {
    serialized.stack = err.stack;
  } else if (err.stack && sanitizeStackTraces) {
    // Basic sanitization - remove file paths
    serialized.stack = err.stack
      .split('\n')
      .slice(0, 5)
      .map((line) => line.replace(/\(.*?:\d+:\d+\)/g, '(...)'))
      .join('\n');
  }

  return serialized;
}

// ============================================================================
// Signal Ready
// ============================================================================

sendMessage({ type: 'ready' });
