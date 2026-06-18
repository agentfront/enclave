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

import * as acorn from 'acorn';
import type * as ESTree from 'estree';

import { Interpreter, StepLimitError } from '../interpreter/interpreter';
import type { ExecutionContext, ExecutionError, ExecutionResult, SandboxAdapter } from '../types';

/**
 * Host globals exposed to sandboxed code. Deliberately minimal + escape-free:
 * `Math` and `JSON` have no path back to host intrinsics. The AST guard already
 * restricted which identifiers the code may reference; anything not provided
 * here throws at runtime (defense in depth).
 */
const SAFE_GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({ Math, JSON });

const DEFAULT_MAX_STEPS = 5_000_000;
const DEFAULT_MAX_CALL_DEPTH = 256;

export interface InterpreterAdapterOptions {
  /** Override the instruction budget (default 5,000,000). */
  maxSteps?: number;
  /** Override the max interpreter call depth (default 256). */
  maxCallDepth?: number;
}

export class InterpreterAdapter implements SandboxAdapter {
  constructor(private readonly options: InterpreterAdapterOptions = {}) {}

  async execute<T = unknown>(code: string, context: ExecutionContext): Promise<ExecutionResult<T>> {
    const startTime = Date.now();
    let toolCallCount = 0;

    const maxToolCalls = context.config.maxToolCalls ?? Number.POSITIVE_INFINITY;
    const toolHandler = context.toolHandler ?? context.config.toolHandler;

    // The tool bridge the transformed code calls as `await __safe_callTool(...)`.
    const __safe_callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (++toolCallCount > maxToolCalls) {
        throw new Error(`Tool call limit exceeded (${maxToolCalls})`);
      }
      if (typeof toolHandler !== 'function') {
        throw new Error('No toolHandler configured for the sandbox');
      }
      return toolHandler(name, args);
    };

    const globals: Record<string, unknown> = { ...SAFE_GLOBALS, __safe_callTool };

    let program: ESTree.Program;
    try {
      program = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as ESTree.Program;
    } catch (error) {
      return this.fail<T>(error, startTime, toolCallCount, 0, 'SyntaxError');
    }

    // Wall-clock timeout drives the AbortSignal the interpreter checks per step.
    const timeout = context.config.timeout;
    const timer =
      timeout && timeout > 0 ? setTimeout(() => context.abortController.abort(), timeout) : undefined;

    const interpreter = new Interpreter({
      globals,
      maxSteps: this.options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxCallDepth: this.options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
      signal: context.abortController.signal,
    });

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

    try {
      const run = interpreter.run(program) as Promise<T>;
      // Swallow a late rejection from the abandoned run after a timeout so it
      // can't surface as an unhandled rejection.
      run.catch(() => undefined);
      const outcome = deadline ? await Promise.race([run, deadline]) : await run;
      if (outcome === TIMED_OUT) {
        return this.fail<T>(
          new Error(`Execution timed out after ${timeout}ms`),
          startTime,
          toolCallCount,
          interpreter.stepCount,
          'TimeoutError',
          'EXECUTION_TIMEOUT',
        );
      }
      return {
        success: true,
        value: outcome as T,
        stats: this.stats(startTime, toolCallCount, interpreter.stepCount),
      };
    } catch (error) {
      const code2 = error instanceof StepLimitError ? 'STEP_LIMIT_EXCEEDED' : undefined;
      return this.fail<T>(error, startTime, toolCallCount, interpreter.stepCount, undefined, code2);
    } finally {
      if (timer) clearTimeout(timer);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  dispose(): void {
    // Stateless — nothing to release.
  }

  private stats(startTime: number, toolCallCount: number, iterationCount: number) {
    const endTime = Date.now();
    return { duration: endTime - startTime, toolCallCount, iterationCount, startTime, endTime };
  }

  private fail<T>(
    error: unknown,
    startTime: number,
    toolCallCount: number,
    iterationCount: number,
    name?: string,
    code?: string,
  ): ExecutionResult<T> {
    const err = error instanceof Error ? error : new Error(String(error));
    const execError: ExecutionError = {
      message: err.message,
      name: name ?? err.name,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(code ? { code } : {}),
    };
    return { success: false, error: execError, stats: this.stats(startTime, toolCallCount, iterationCount) };
  }
}
