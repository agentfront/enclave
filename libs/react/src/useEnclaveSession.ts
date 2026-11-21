/**
 * useEnclaveSession Hook
 *
 * React hook for executing code in the EnclaveJS runtime with state management.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { EnclaveClient, SessionResult, SessionHandle, StreamEvent, SessionId } from '@enclave-vm/client';
import { useEnclaveClient } from './EnclaveProvider.js';
import type { SessionState, UseEnclaveSessionOptions, UseEnclaveSessionReturn } from './types.js';

/**
 * useEnclaveSession hook
 *
 * Provides a stateful interface for executing code in the Enclave runtime.
 *
 * @example
 * ```tsx
 * function Calculator() {
 *   const { execute, isRunning, result, stdout } = useEnclaveSession({
 *     onStdout: (chunk) => console.log(chunk),
 *   });
 *
 *   const calculate = async () => {
 *     const result = await execute('return 1 + 1');
 *     console.log('Result:', result.value);
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={calculate} disabled={isRunning}>
 *         Calculate
 *       </button>
 *       {result && <p>Result: {JSON.stringify(result.value)}</p>}
 *       <pre>{stdout}</pre>
 *     </div>
 *   );
 * }
 * ```
 */
/**
 * What the state of the hook belongs to: one per client the provider hands out. A newer client
 * has a higher generation. The run counter and the cancellation handle are the owner's, so they
 * are never shared between clients and nothing has to be reset when the client changes.
 */
interface SessionOwner {
  client: EnclaveClient;
  generation: number;
  run: number;
  handle: SessionHandle | null;
}

/** The state of the hook, with the owner it belongs to. */
interface SessionSnapshot<T> {
  owner: SessionOwner;
  state: SessionState;
  sessionId: SessionId | null;
  result: SessionResult<T> | null;
  error: { code?: string; message: string } | null;
  stdout: string;
  events: StreamEvent[];
}

let ownerGenerations = 0;

function idleSnapshot<T>(owner: SessionOwner): SessionSnapshot<T> {
  return { owner, state: 'idle', sessionId: null, result: null, error: null, stdout: '', events: [] };
}

export function useEnclaveSession<T = unknown>(options: UseEnclaveSessionOptions = {}): UseEnclaveSessionReturn<T> {
  const client = useEnclaveClient();

  // The owner of this client. Made while rendering but nothing is changed there: a render React
  // discards leaves the owner that is shown, its runs and its handle as they were.
  const owner = useMemo<SessionOwner>(
    () => ({ client, generation: ++ownerGenerations, run: 0, handle: null }),
    [client],
  );

  // The owner the last commit showed. A run's callbacks are called while its owner is that one or
  // a newer one (a run an effect of the same commit started).
  const committedOwnerRef = useRef<SessionOwner>(owner);
  useEffect(() => {
    committedOwnerRef.current = owner;
  }, [owner]);

  // The state, tagged with its owner. The state of another owner (the client before) is not shown
  // under this one; an owner's runs write only while the state is theirs, and an older owner
  // never takes it from a newer one.
  const [snapshot, setSnapshot] = useState<SessionSnapshot<T>>(() => idleSnapshot<T>(owner));
  const idle = useMemo(() => idleSnapshot<T>(owner), [owner]);
  const shown = snapshot.owner === owner ? snapshot : idle;

  /**
   * Reset the hook state
   */
  const reset = useCallback(() => {
    owner.handle = null;
    // Only the owner's own state: a reset kept from an earlier client leaves a newer one's alone
    setSnapshot((current) => (current.owner === owner ? idleSnapshot<T>(owner) : current));
  }, [owner]);

  /**
   * Execute code in the enclave
   */
  const execute = useCallback(
    async (code: string): Promise<SessionResult<T>> => {
      const run = ++owner.run;
      // The latest run of its owner, and the state is its owner's
      const update = (change: (current: SessionSnapshot<T>) => Partial<SessionSnapshot<T>>): void => {
        setSnapshot((current) =>
          owner.run === run && current.owner === owner ? { ...current, ...change(current) } : current,
        );
      };
      const callbacksApply = (): boolean => owner.generation >= committedOwnerRef.current.generation;

      // Reset state for new execution: the state becomes this owner's, unless a newer owner has it
      setSnapshot((current) =>
        current.owner.generation > owner.generation ? current : { ...idleSnapshot<T>(owner), state: 'running' },
      );

      // Call onStart callback
      options.onStart?.();

      // Build limits from options
      const limits: Record<string, number> = {};
      if (options.timeoutMs !== undefined) {
        limits.sessionTtlMs = options.timeoutMs;
      }
      if (options.maxToolCalls !== undefined) {
        limits.maxToolCalls = options.maxToolCalls;
      }
      if (options.heartbeatIntervalMs !== undefined) {
        limits.heartbeatIntervalMs = options.heartbeatIntervalMs;
      }

      // Start streaming execution
      const handle = owner.client.executeStream(code, {
        sessionId: options.sessionId,
        limits: Object.keys(limits).length > 0 ? limits : undefined,
        onEvent: (event) => {
          update((current) => ({ events: [...current.events, event] }));
        },
        onStdout: (chunk) => {
          update((current) => ({ stdout: current.stdout + chunk }));
          if (callbacksApply()) options.onStdout?.(chunk);
        },
        onLog: (level, message, data) => {
          if (callbacksApply()) options.onLog?.(level, message, data);
        },
        onToolCall: (callId, toolName, args) => {
          if (callbacksApply()) options.onToolCall?.(callId, toolName, args);
        },
        onToolResultApplied: (callId) => {
          if (callbacksApply()) options.onToolResultApplied?.(callId);
        },
        onError: (code, message) => {
          if (callbacksApply()) options.onError?.({ code, message });
        },
      });

      owner.handle = handle;
      update(() => ({ sessionId: handle.sessionId }));

      try {
        // Wait for completion
        const sessionResult = (await handle.wait()) as SessionResult<T>;

        // Update state based on result
        if (sessionResult.success) {
          update(() => ({ state: 'completed', result: sessionResult }));
        } else if (sessionResult.error?.code === 'CANCELLED') {
          update(() => ({ state: 'cancelled', result: sessionResult }));
        } else {
          update(() => ({
            state: 'error',
            result: sessionResult,
            error: sessionResult.error ?? { message: 'Unknown error' },
          }));
        }
        if (callbacksApply()) {
          if (!sessionResult.success && sessionResult.error?.code !== 'CANCELLED') {
            options.onError?.(sessionResult.error ?? { message: 'Unknown error' });
          }
          // Call onComplete callback
          options.onComplete?.(sessionResult);
        }

        return sessionResult;
      } catch (err) {
        // Handle unexpected errors
        const errorInfo = {
          code: 'UNEXPECTED_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        };

        // Return error result
        const errorResult: SessionResult<T> = {
          success: false,
          sessionId: handle.sessionId,
          error: errorInfo,
          events: handle.getEvents(),
        };

        update(() => ({ state: 'error', error: errorInfo, result: errorResult }));
        if (callbacksApply()) {
          options.onError?.(errorInfo);
          options.onComplete?.(errorResult);
        }

        return errorResult;
      } finally {
        // Only the handle of this run: a later run's handle stays, so cancel() still reaches it
        if (owner.handle === handle) owner.handle = null;
      }
    },
    [owner, options],
  );

  /**
   * Cancel the current session
   */
  const cancel = useCallback(
    async (reason?: string): Promise<void> => {
      if (owner.handle) {
        await owner.handle.cancel(reason);
      }
    },
    [owner],
  );

  return {
    execute,
    cancel,
    state: shown.state,
    isRunning: shown.state === 'running',
    sessionId: shown.sessionId,
    result: shown.result,
    error: shown.error,
    stdout: shown.stdout,
    events: shown.events,
    reset,
  };
}
