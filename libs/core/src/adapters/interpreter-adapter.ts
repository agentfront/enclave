// file: libs/core/src/adapters/interpreter-adapter.ts
//
// `SandboxAdapter` backed by the dependency-free AgentScript interpreter — the
// runtime-agnostic, INDEPENDENT execute path (no QuickJS, no WASM, no node:vm).
// Runs unchanged on V8 isolates (Cloudflare Workers), Deno, Bun, and Node.
//
// Security is by construction (see `../interpreter/interpreter.ts`): the
// interpreter never exposes host globals or `eval`/`Function`, blocks the
// prototype-escape keys, and a step budget interrupts infinite loops. The AST
// guard still runs upstream (defense in depth) — this adapter receives
// already-transformed AgentScript whose `callTool` was rewritten to
// `__safe_callTool` and whose body is wrapped in `async function __ag_main()`.
//
// The adapter is the host side of that interpreter. It provides what transformed
// AgentScript refers to (the standard globals as frozen stand-ins, `__safe_concat`,
// `__safe_template`, `__safe_forOf`, `__safe_parallel`, `__maxIterations`, the console
// and the tool namespaces when the execution has them), and it treats what crosses to
// and from the host like every other adapter does: a tool call goes through the host
// tool bridge (JSON both ways, the tool-call limit, argument and result sanitization,
// sidecar references), the returned value is copied into plain host data, and what
// the script allocates is charged against a budget.

import * as acorn from 'acorn';
import type * as ESTree from 'estree';

import { createConsoleSink } from '../console-handler';
import {
  DeadlineError,
  Interpreter,
  MAX_JOIN_LENGTH,
  StepLimitError,
  isBlockedKey,
  isEngineCalledKey,
  isScriptError,
  takesArraysAsData,
} from '../interpreter/interpreter';
import { createSafeGlobals } from '../interpreter/safe-globals';
import { MemoryTracker } from '../memory-tracker';
import { isReferenceId } from '../sidecar/reference-config';
import { ReferenceResolver } from '../sidecar/reference-resolver';
import { sanitizeStackTrace } from '../stack-trace';
import { createHostToolBridge, encodeToolBridgeRequest } from '../tool-bridge';
import type { ExecutionContext, ExecutionError, ExecutionResult, ExecutionStats, SandboxAdapter } from '../types';
import { checkSerializedSize, sanitizeValue } from '../value-sanitizer';

const DEFAULT_MAX_STEPS = 5_000_000;
const DEFAULT_MAX_CALL_DEPTH = 256;

/**
 * What a script may allocate when the execution sets no `memoryLimit`, and the most it may
 * allocate whatever the execution sets. The interpreter runs in the host's own heap: there is no
 * engine limit to fall back on.
 */
const DEFAULT_MAX_ALLOCATION_BYTES = 64 * 1024 * 1024;

/** As in the other adapters */
const MAX_PARALLEL_ITEMS = 100;
const MAX_SERIALIZED_RESULT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CONSOLE_CALLS = 100;
const DEFAULT_MAX_CONSOLE_OUTPUT_BYTES = 64 * 1024;
/** The tool bridge's own default for the size of a request */
const DEFAULT_MAX_TOOL_PAYLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Whether a value is certain to serialize to more than `bytes`: judged by the size estimate,
 * which walks the value without building its text, and with room to spare, so that a value
 * the limit itself would accept is never refused here. What this refuses, the limit refuses too;
 * the difference is that the text is not built first.
 */
function certainlyLargerThan(value: unknown, bytes: number): boolean {
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  return !checkSerializedSize(value, bytes).ok;
}

/** What the runtime helpers know of the execution they belong to */
interface CallbackInvoker {
  /** How a helper calls a function a script handed it (see `Interpreter.call`) */
  call(fn: unknown, args: unknown[]): unknown;
  /** Set when the execution has returned: from then on a helper reaches nothing of the host */
  over?: boolean;
}

/** Thrown by a helper that is called for an execution that has returned */
function executionOver(): Error {
  return sandboxError('Execution ended');
}

export interface InterpreterAdapterOptions {
  /** Override the instruction budget (default 5,000,000). */
  maxSteps?: number;
  /**
   * How deep the calls of a script may nest (default 256). Counted along each chain of calls: a
   * callback is a call of the function that invokes it, and the tasks of a `parallel` batch each
   * continue the chain that started the batch, so a batch does not add up.
   */
  maxCallDepth?: number;
  /**
   * How many calls of an execution may be unfinished at once, running or waiting, over all its
   * chains (default 4096). It bounds what the waiting calls of nested `parallel` batches hold.
   */
  maxPendingCalls?: number;
  /**
   * The most a script may allocate, in bytes, as the interpreter estimates it (default 64 MB).
   * An execution's own `memoryLimit` applies when it is lower.
   */
  maxAllocationBytes?: number;
}

/** A failure the enclave reports to the script (or to the caller) with a name and a code. */
function sandboxError(message: string, name = 'Error', code?: string): Error {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) (error as Error & { code?: string }).code = code;
  return error;
}

function ignoreRejection(): void {
  // Deliberately empty: see observed
}

/**
 * A helper that returns a promise, as the script gets it: every promise it returns has a
 * rejection handler. Whoever awaits the promise still sees a rejection; the handler only keeps
 * a promise that nobody holds from becoming an unhandled rejection, which by default ends the
 * host process. The interpreter does the same for the functions of a script.
 */
function observed<A extends unknown[]>(helper: (...args: A) => Promise<unknown>): (...args: A) => Promise<unknown> {
  return (...args: A): Promise<unknown> => {
    const result = helper(...args);
    result.then(undefined, ignoreRejection);
    return result;
  };
}

function frozenRecord(members: Record<string, unknown>): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(members)) record[key] = members[key];
  return Object.freeze(record);
}

/** A custom global as the script gets it: a frozen copy of JSON data. */
function frozenDataCopy(name: string, value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  let json: string | undefined;
  try {
    json = typeof value === 'function' ? undefined : JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw sandboxError(
      `Custom global "${name}" cannot be given to the interpreter: it supports JSON data only (no functions)`,
      'TypeError',
    );
  }
  const freeze = (item: unknown): unknown => {
    if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(json));
}

/** One console argument as text, without running anything the script defined. */
function consoleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return '[Function]';
  if (value === null || typeof value !== 'object') return String(value);
  if (isScriptError(value)) {
    const error = value as { name: string; message: string };
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  try {
    return JSON.stringify(value) ?? '[object]';
  } catch {
    return '[object]';
  }
}

export class InterpreterAdapter implements SandboxAdapter {
  constructor(private readonly options: InterpreterAdapterOptions = {}) {}

  async execute<T = unknown>(code: string, context: ExecutionContext): Promise<ExecutionResult<T>> {
    const startTime = Date.now();
    // Returned errors obey sanitizeStackTraces like every other adapter's.
    const sanitizeStacks = context.config.sanitizeStackTraces === true;

    // The tool bridge counts tool calls in the execution's statistics.
    const stats: ExecutionStats =
      context.stats ??
      ((context as { stats?: ExecutionStats }).stats = {
        duration: 0,
        toolCallCount: 0,
        iterationCount: 0,
        startTime,
      } as ExecutionStats);

    let program: ESTree.Program;
    try {
      program = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as ESTree.Program;
    } catch (error) {
      return this.fail<T>(error, startTime, stats.toolCallCount, 0, sanitizeStacks, 'SyntaxError');
    }

    const memoryLimit = context.config.memoryLimit;
    const adapterLimit = this.options.maxAllocationBytes ?? DEFAULT_MAX_ALLOCATION_BYTES;
    const allocationLimit =
      typeof memoryLimit === 'number' && memoryLimit > 0 ? Math.min(memoryLimit, adapterLimit) : adapterLimit;
    const tracker = new MemoryTracker({ memoryLimit: Number.isFinite(allocationLimit) ? allocationLimit : 0 });
    const charge = (bytes: number): void => tracker.track(bytes);
    // What a helper allocates is charged through the interpreter, which ends the run when the
    // budget refuses: charged directly, the refusal would be an error the script can catch.
    let chargeForHelper = (_bytes: number): void => {
      throw sandboxError('The interpreter is not running');
    };

    // The interpreter reads the clock itself while a script computes: a timer cannot fire then.
    const timeout = context.config.timeout;
    const deadlineAt = timeout && timeout > 0 ? Date.now() + timeout : undefined;

    let interpreter: Interpreter;
    // How a helper calls a function it was handed: through the interpreter, which applies the
    // checks of a call the script writes itself. Bound below, once the interpreter exists.
    const callbacks: CallbackInvoker = {
      call: () => {
        throw sandboxError('The interpreter is not running');
      },
    };
    try {
      const safe = createSafeGlobals();
      // The helpers, namespaces and custom globals of this execution; none of them replaces a
      // standard global.
      const runtime = this.runtimeGlobals(context, (bytes) => chargeForHelper(bytes), callbacks);
      for (const name of Object.keys(runtime)) {
        if (!Object.prototype.hasOwnProperty.call(safe.globals, name)) safe.globals[name] = runtime[name];
      }
      interpreter = new Interpreter({
        globals: safe.globals,
        constructors: safe.constructors,
        instanceChecks: safe.instanceChecks,
        maxSteps: this.options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxCallDepth: this.options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
        maxPendingCalls: this.options.maxPendingCalls,
        signal: context.abortController.signal,
        deadline: deadlineAt,
        charge,
      });
      const running = interpreter;
      callbacks.call = (fn, args) => running.call(fn, args);
      chargeForHelper = (bytes) => running.chargeAllocation(bytes);
    } catch (error) {
      return this.fail<T>(error, startTime, stats.toolCallCount, 0, sanitizeStacks);
    }

    // Wall-clock timeout drives the AbortSignal the interpreter checks per step.
    const timer = timeout && timeout > 0 ? setTimeout(() => context.abortController.abort(), timeout) : undefined;

    // The per-step signal check can't fire while the interpreter is parked on an
    // `await` (e.g. a tool call that never settles), so the step budget alone
    // can't bound wall-clock there. Race the run against a hard timeout so the
    // sandbox ALWAYS returns by the deadline regardless of what it's awaiting.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol('timeout');
    const deadline =
      timeout && timeout > 0
        ? new Promise<typeof TIMED_OUT>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(TIMED_OUT), timeout);
          })
        : undefined;
    const running = interpreter;
    const timedOut = (): ExecutionResult<T> =>
      this.fail<T>(
        new Error(`Execution timed out after ${timeout}ms`),
        startTime,
        stats.toolCallCount,
        running.stepCount,
        sanitizeStacks,
        'TimeoutError',
        'EXECUTION_TIMEOUT',
      );

    try {
      const run = interpreter.run(program) as Promise<T>;
      // Swallow a late rejection from the abandoned run after a timeout so it
      // can't surface as an unhandled rejection.
      run.catch(() => undefined);
      const outcome = deadline ? await Promise.race([run, deadline]) : await run;
      if (outcome === TIMED_OUT) return timedOut();
      return this.succeed<T>(outcome, context, startTime, stats.toolCallCount, interpreter.stepCount);
    } catch (error) {
      // The deadline, met while the script was computing: the same outcome as when it is met
      // while the script waits
      if (error instanceof DeadlineError) return timedOut();
      const code2 = error instanceof StepLimitError ? 'STEP_LIMIT_EXCEEDED' : undefined;
      return this.fail<T>(
        error,
        startTime,
        stats.toolCallCount,
        interpreter.stepCount,
        sanitizeStacks,
        undefined,
        code2,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // The execution is over: nothing of the script runs from here on, and nothing of it
      // reaches the host (a run that timed out while it waited for a tool and goes on when the
      // tool answers). The interpreter makes no further call; the helpers refuse by themselves.
      callbacks.over = true;
      interpreter.stop();
    }
  }

  dispose(): void {
    // Stateless — nothing to release.
  }

  /**
   * What transformed AgentScript refers to beyond the standard globals: the helpers the
   * transformer emits, and the console, tool namespaces and custom globals of this execution.
   */
  private runtimeGlobals(
    context: ExecutionContext,
    charge: (bytes: number) => void,
    callbacks: CallbackInvoker,
  ): Record<string, unknown> {
    const { config } = context;
    const callTool = observed(this.createCallTool(context, callbacks));
    const resolver =
      context.sidecar && context.referenceConfig
        ? new ReferenceResolver(context.sidecar, context.referenceConfig)
        : undefined;

    const joinReferences = (parts: string[]): unknown => {
      if (!resolver) {
        throw sandboxError(
          'Cannot concatenate reference IDs: reference system not configured. ' +
            'Pass references directly to callTool arguments instead.',
        );
      }
      return resolver.createComposite(parts);
    };

    // `a + b` as the transformer rewrites it. A reference id is a handle to data the host keeps:
    // it is never spliced into a string here, only combined by the reference system.
    const concat = (left: unknown, right: unknown): unknown => {
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      if ((typeof left === 'string' && isReferenceId(left)) || (typeof right === 'string' && isReferenceId(right))) {
        return joinReferences([String(left), String(right)]);
      }
      const result: unknown = (left as never as number) + (right as never as number);
      if (typeof result === 'string') {
        charge((result.length - (typeof left === 'string' ? left.length : 0)) * 2);
      }
      return result;
    };

    // A template literal as the transformer rewrites it: the literal pieces and the values.
    const template = (quasis: unknown, ...values: unknown[]): unknown => {
      if (!Array.isArray(quasis)) throw sandboxError('Template pieces must be an array', 'TypeError');
      const parts: string[] = [];
      let hasReference = false;
      let length = 0;
      // As long as a template literal may be in the interpreter itself
      const add = (part: string): void => {
        length += part.length;
        if (length > MAX_JOIN_LENGTH) {
          throw sandboxError(`A template literal cannot produce more than ${MAX_JOIN_LENGTH} chars`, 'RangeError');
        }
        parts.push(part);
      };
      for (let i = 0; i < quasis.length; i++) {
        add(String(quasis[i]));
        if (i < values.length) {
          const value = values[i];
          if (typeof value === 'string' && isReferenceId(value)) hasReference = true;
          add(String(value));
        }
      }
      if (hasReference) return joinReferences(parts.filter((part) => part !== ''));
      const result = parts.join('');
      charge(result.length * 2);
      return result;
    };

    const maxIterations = typeof config.maxIterations === 'number' ? config.maxIterations : Number.POSITIVE_INFINITY;
    const signal = context.abortController.signal;
    function* forOf(iterable: unknown): Generator<unknown> {
      let iterations = 0;
      for (const item of iterable as Iterable<unknown>) {
        if (signal.aborted) throw sandboxError('Execution aborted');
        if (++iterations > maxIterations) {
          throw sandboxError(
            `Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.`,
          );
        }
        yield item;
      }
    }

    // parallel(items, fn) and parallel([fn, fn, ...]): everything is started, all of it is
    // awaited, and the tool calls made on the way share the execution's tool-call limit.
    const parallel = observed(async (first: unknown, second?: unknown): Promise<unknown[]> => {
      // Every task is called through the interpreter: a task need not be a function of the
      // script (`parallel(items, String)`), and a built-in gets the checks of a direct call.
      let tasks: Array<() => unknown>;
      if (typeof second === 'function') {
        if (!Array.isArray(first)) throw sandboxError('parallel requires an array of items', 'TypeError');
        const items = first;
        tasks = items.map((item, index) => () => callbacks.call(second, [item, index, items]));
      } else {
        if (!Array.isArray(first) || !first.every((task) => typeof task === 'function')) {
          throw sandboxError('parallel requires an array of functions', 'TypeError');
        }
        tasks = first.map((task: unknown) => () => callbacks.call(task, []));
      }
      if (tasks.length > MAX_PARALLEL_ITEMS) {
        throw sandboxError(
          `Cannot execute more than ${MAX_PARALLEL_ITEMS} operations in parallel. Split into smaller batches.`,
        );
      }
      const settled = await Promise.allSettled(tasks.map(async (task) => task()));
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        const messages = failures.map((failure) => this.describe(failure.reason).message).join('\n');
        throw sandboxError(`${failures.length} of ${tasks.length} parallel operations failed:\n${messages}`);
      }
      return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value);
    });

    const globals: Record<string, unknown> = {
      __safe_callTool: callTool,
      __safe_concat: concat,
      __safe_template: template,
      // Both go through the items of an array they are given and never convert it to text, so
      // the interpreter does not measure it first (as it does for a built-in that might).
      __safe_forOf: takesArraysAsData(forOf),
      __safe_parallel: takesArraysAsData(parallel),
      __maxIterations: maxIterations,
    };

    if (typeof context.consoleHandler === 'function') {
      const maxConsoleCalls = config.maxConsoleCalls ?? DEFAULT_MAX_CONSOLE_CALLS;
      const maxConsoleOutputBytes = config.maxConsoleOutputBytes ?? DEFAULT_MAX_CONSOLE_OUTPUT_BYTES;
      const sink = createConsoleSink(context.consoleHandler, { maxConsoleCalls, maxConsoleOutputBytes });
      // The limits end the script with the same errors as the console of the VM adapters; the
      // sink applies them a second time, so a limit holds even where a script catches the error.
      let consoleCalls = 0;
      let consoleLength = 0;
      const write =
        (level: string) =>
        (...args: unknown[]): void => {
          if (callbacks.over) throw executionOver();
          consoleCalls++;
          if (consoleCalls > maxConsoleCalls) {
            throw sandboxError(
              `Console call limit exceeded (max: ${maxConsoleCalls}). This limit prevents I/O flood attacks.`,
            );
          }
          const outputLimit = (): Error =>
            sandboxError(
              `Console output size limit exceeded (max: ${maxConsoleOutputBytes} bytes). This limit prevents I/O flood attacks.`,
            );
          // An argument that cannot fit is refused before its text is built. The margin is
          // wide (the estimate is in bytes and also counts members the text leaves out): what
          // matters is that the text that is built is of the order of the limit, not of the value.
          const room = (maxConsoleOutputBytes - consoleLength) * 16 + 64 * 1024;
          for (const arg of args) {
            if (arg !== null && typeof arg === 'object' && certainlyLargerThan(arg, room)) throw outputLimit();
          }
          const line = args.map(consoleText).join(' ');
          consoleLength += line.length;
          if (consoleLength > maxConsoleOutputBytes) throw outputLimit();
          sink(level, line);
        };
      globals['__safe_console'] = frozenRecord({
        log: write('log'),
        info: write('info'),
        warn: write('warn'),
        error: write('error'),
      });
    }

    for (const namespace of context.toolNamespaces ?? []) {
      const methods: Record<string, unknown> = {};
      for (const method of namespace.methods) {
        // A namespace is a value a script holds: like its data, it has no function under a name
        // the engine calls by itself (a method named `then` would make every use of the
        // namespace wait for a tool call nobody made).
        if (isBlockedKey(method.name) || isEngineCalledKey(method.name)) continue;
        methods[method.name] = (args?: unknown, options?: unknown): Promise<unknown> =>
          callTool(method.toolName, args === undefined ? {} : args, options);
      }
      globals[namespace.name] = frozenRecord(methods);
    }

    const custom = (config as { globals?: Record<string, unknown> }).globals;
    if (custom && typeof custom === 'object') {
      for (const name of Object.keys(custom)) {
        // A custom global never replaces something the runtime provides.
        if (name.startsWith('__') || Object.prototype.hasOwnProperty.call(globals, name)) continue;
        globals[name] = frozenDataCopy(name, custom[name]);
      }
    }

    return globals;
  }

  /**
   * `callTool(name, args, options)` for the script, through the host tool bridge: the request
   * and the response cross as JSON, so the handler never receives a value of the script and the
   * script never receives an object of the handler.
   */
  private createCallTool(
    context: ExecutionContext,
    execution: CallbackInvoker,
  ): (toolName: unknown, args: unknown, options?: unknown) => Promise<unknown> {
    // Hosts that build the context by hand may keep the handler in the configuration.
    const configured = (context.config as { toolHandler?: ExecutionContext['toolHandler'] }).toolHandler;
    const bridgeContext =
      context.toolHandler === undefined && typeof configured === 'function'
        ? (Object.create(context, { toolHandler: { value: configured } }) as ExecutionContext)
        : context;
    const bridge = createHostToolBridge(bridgeContext, { updateStats: true });
    const maxPayloadBytes = context.config.toolBridge?.maxPayloadBytes ?? DEFAULT_MAX_TOOL_PAYLOAD_BYTES;

    return async (toolName: unknown, args: unknown, options?: unknown): Promise<unknown> => {
      if (execution.over) throw executionOver();
      // callTool options: only { throwOnError: false } changes behavior. Tool failures then
      // resolve to { success: false, error }; the enclave's own refusals still throw.
      let throwOnError = true;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object') throw sandboxError('callTool options must be an object', 'TypeError');
        throwOnError = (options as { throwOnError?: unknown }).throwOnError !== false;
      }
      if (typeof toolName !== 'string' || !toolName) {
        throw sandboxError('Tool name must be a non-empty string', 'TypeError');
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw sandboxError('Tool arguments must be an object', 'TypeError');
      }

      // Arguments the bridge is certain to refuse for their size are refused here, in the
      // bridge's words, before the request is built from them.
      if (certainlyLargerThan(args, maxPayloadBytes * 2 + 1024)) {
        throw sandboxError(
          `Tool request exceeds maximum size (${maxPayloadBytes} bytes)`,
          'ToolBridgeError',
          'TOOL_BRIDGE_REQUEST_TOO_LARGE',
        );
      }

      let requestJson: string;
      try {
        requestJson = encodeToolBridgeRequest(toolName, args as Record<string, unknown>);
      } catch {
        throw sandboxError('Tool arguments must be JSON-serializable', 'TypeError');
      }

      let response: unknown;
      try {
        response = JSON.parse(await bridge(requestJson));
      } catch {
        throw sandboxError('Tool bridge returned invalid JSON');
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw sandboxError('Tool bridge returned invalid response');
      }

      const reply = response as { ok?: unknown; value?: unknown; error?: Record<string, unknown> };
      if (reply.ok === true) {
        return throwOnError ? reply.value : { success: true, data: reply.value };
      }
      if (reply.ok === false && reply.error && typeof reply.error === 'object') {
        const message = typeof reply.error['message'] === 'string' ? reply.error['message'] : 'Tool call failed';
        const name = typeof reply.error['name'] === 'string' ? reply.error['name'] : 'Error';
        const code = typeof reply.error['code'] === 'string' ? reply.error['code'] : undefined;
        if (!throwOnError && reply.error['toolError'] === true) {
          return { success: false, error: { name, message, toolName, ...(code !== undefined ? { code } : {}) } };
        }
        throw sandboxError(message, name, code);
      }
      throw sandboxError('Tool bridge returned invalid response');
    };
  }

  /**
   * The value a script returned, as the caller gets it: plain host data, like from every other
   * adapter. A function, or a result that would serialize to more than the memory limit, fails
   * the execution.
   */
  private succeed<T>(
    value: unknown,
    context: ExecutionContext,
    startTime: number,
    toolCallCount: number,
    stepCount: number,
  ): ExecutionResult<T> {
    const { config } = context;
    const stats = this.stats(startTime, toolCallCount, stepCount);

    if (typeof config.memoryLimit === 'number' && config.memoryLimit > 0 && value !== undefined) {
      const sizeCheck = checkSerializedSize(value, Math.min(config.memoryLimit, MAX_SERIALIZED_RESULT_BYTES));
      if (!sizeCheck.ok) {
        return {
          success: false,
          error: {
            name: 'MemoryLimitError',
            message: `Return value serialization would exceed memory limit: ${sizeCheck.error}`,
            code: 'SERIALIZATION_LIMIT_EXCEEDED',
          },
          stats,
        };
      }
    }

    // The configured limits as they are, as in the double VM: a host that raised or lowered
    // them gets the same result from this adapter. A context that sets none (the adapter used
    // without an Enclave) gets the defaults of sanitizeValue, again as in the double VM.
    const maxDepth = config.maxSanitizeDepth;
    const maxProperties = config.maxSanitizeProperties;
    return {
      success: true,
      value: sanitizeValue(value, { maxDepth, maxProperties, allowDates: true, allowErrors: true }) as T,
      stats,
    };
  }

  private stats(startTime: number, toolCallCount: number, iterationCount: number) {
    const endTime = Date.now();
    return { duration: endTime - startTime, toolCallCount, iterationCount, startTime, endTime };
  }

  /**
   * What ended an execution, as a name and a message. A script can throw any value: a string is
   * the message, an object contributes its `name`, `message` and `code` when they are strings.
   */
  private describe(thrown: unknown): { name: string; message: string; code?: string; stack?: string } {
    if (thrown instanceof Error) {
      const code = (thrown as { code?: unknown }).code;
      return {
        name: thrown.name,
        message: thrown.message,
        stack: thrown.stack,
        ...(typeof code === 'string' ? { code } : {}),
      };
    }
    if (typeof thrown === 'string') return { name: 'Error', message: thrown };
    if (thrown !== null && typeof thrown === 'object') {
      const value = thrown as { name?: unknown; message?: unknown; code?: unknown };
      return {
        name: typeof value.name === 'string' ? value.name : 'Error',
        message: typeof value.message === 'string' ? value.message : 'The script threw a value that is not an error',
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
      };
    }
    return { name: 'Error', message: `The script threw ${String(thrown)}` };
  }

  private fail<T>(
    error: unknown,
    startTime: number,
    toolCallCount: number,
    iterationCount: number,
    sanitizeStacks: boolean,
    name?: string,
    code?: string,
  ): ExecutionResult<T> {
    const described = this.describe(error);
    const stack = sanitizeStackTrace(described.stack, sanitizeStacks);
    const errorCode = code ?? described.code;
    const execError: ExecutionError = {
      message: described.message,
      name: name ?? described.name,
      ...(stack ? { stack } : {}),
      ...(errorCode ? { code: errorCode } : {}),
    };
    return { success: false, error: execError, stats: this.stats(startTime, toolCallCount, iterationCount) };
  }
}
