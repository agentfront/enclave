/**
 * useEnclaveSession Hook
 *
 * React hook for executing code in the EnclaveJS runtime with state management.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useRef } from 'react';
import type { SessionResult, SessionHandle, StreamEvent, SessionId } from '@enclavejs/client';
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
export function useEnclaveSession<T = unknown>(options: UseEnclaveSessionOptions = {}): UseEnclaveSessionReturn<T> {
  const client = useEnclaveClient();

  // State
  const [state, setState] = useState<SessionState>('idle');
  const [sessionId, setSessionId] = useState<SessionId | null>(null);
  const [result, setResult] = useState<SessionResult<T> | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [stdout, setStdout] = useState<string>('');
  const [events, setEvents] = useState<StreamEvent[]>([]);

  // Refs for current session handle
  const handleRef = useRef<SessionHandle | null>(null);

  /**
   * Reset the hook state
   */
  const reset = useCallback(() => {
    setState('idle');
    setSessionId(null);
    setResult(null);
    setError(null);
    setStdout('');
    setEvents([]);
    handleRef.current = null;
  }, []);

  /**
   * Execute code in the enclave
   */
  const execute = useCallback(
    async (code: string): Promise<SessionResult<T>> => {
      // Reset state for new execution
      setState('running');
      setResult(null);
      setError(null);
      setStdout('');
      setEvents([]);

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
      const handle = client.executeStream(code, {
        sessionId: options.sessionId,
        limits: Object.keys(limits).length > 0 ? limits : undefined,
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
        },
        onStdout: (chunk) => {
          setStdout((prev) => prev + chunk);
          options.onStdout?.(chunk);
        },
        onLog: (level, message, data) => {
          options.onLog?.(level, message, data);
        },
        onToolCall: (callId, toolName, args) => {
          options.onToolCall?.(callId, toolName, args);
        },
        onToolResultApplied: (callId) => {
          options.onToolResultApplied?.(callId);
        },
        onError: (code, message) => {
          options.onError?.({ code, message });
        },
      });

      handleRef.current = handle;
      setSessionId(handle.sessionId);

      try {
        // Wait for completion
        const sessionResult = (await handle.wait()) as SessionResult<T>;

        // Update state based on result
        if (sessionResult.success) {
          setState('completed');
          setResult(sessionResult);
        } else if (sessionResult.error?.code === 'CANCELLED') {
          setState('cancelled');
          setResult(sessionResult);
        } else {
          setState('error');
          setResult(sessionResult);
          setError(sessionResult.error ?? { message: 'Unknown error' });
          options.onError?.(sessionResult.error ?? { message: 'Unknown error' });
        }

        // Call onComplete callback
        options.onComplete?.(sessionResult);

        return sessionResult;
      } catch (err) {
        // Handle unexpected errors
        const errorInfo = {
          code: 'UNEXPECTED_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        };

        setState('error');
        setError(errorInfo);
        options.onError?.(errorInfo);

        // Return error result
        const errorResult: SessionResult<T> = {
          success: false,
          sessionId: handle.sessionId,
          error: errorInfo,
          events: handle.getEvents(),
        };

        setResult(errorResult);
        options.onComplete?.(errorResult);

        return errorResult;
      } finally {
        handleRef.current = null;
      }
    },
    [client, options],
  );

  /**
   * Cancel the current session
   */
  const cancel = useCallback(async (reason?: string): Promise<void> => {
    if (handleRef.current) {
      await handleRef.current.cancel(reason);
    }
  }, []);

  return {
    execute,
    cancel,
    state,
    isRunning: state === 'running',
    sessionId,
    result,
    error,
    stdout,
    events,
    reset,
  };
}
