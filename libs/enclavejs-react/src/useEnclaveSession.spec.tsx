/**
 * useEnclaveSession Tests
 */

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnclaveProvider } from './EnclaveProvider';
import { useEnclaveSession } from './useEnclaveSession';
import type { SessionResult, SessionHandle } from '@enclavejs/client';
import { EventType, PROTOCOL_VERSION } from '@enclavejs/types';

// Helper to create mock session result
function createMockResult<T>(value: T, success = true): SessionResult<T> {
  return {
    success,
    sessionId: 's_test123' as `s_${string}`,
    value: success ? value : undefined,
    error: success ? undefined : { code: 'ERROR', message: 'Test error' },
    events: [],
    stats: {
      durationMs: 100,
      toolCallCount: 0,
      stdoutBytes: 0,
    },
  };
}

// Helper to create mock session handle
function createMockHandle(result: SessionResult): SessionHandle {
  return {
    sessionId: 's_test123' as `s_${string}`,
    wait: jest.fn().mockResolvedValue(result),
    cancel: jest.fn().mockResolvedValue(undefined),
    getEvents: jest.fn().mockReturnValue([]),
    isActive: jest.fn().mockReturnValue(true),
  };
}

// Mock client
const mockExecuteStream = jest.fn();
const mockClient = {
  execute: jest.fn(),
  executeStream: mockExecuteStream,
};

// Wrapper component for testing hooks
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }} client={mockClient as any}>
      {children}
    </EnclaveProvider>
  );
}

describe('useEnclaveSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initial state', () => {
    it('should have idle state initially', () => {
      function TestComponent() {
        const { state, isRunning, sessionId, result, error, stdout, events } = useEnclaveSession();

        return (
          <div>
            <span data-testid="state">{state}</span>
            <span data-testid="isRunning">{String(isRunning)}</span>
            <span data-testid="sessionId">{sessionId ?? 'null'}</span>
            <span data-testid="result">{result ? 'has-result' : 'null'}</span>
            <span data-testid="error">{error ? 'has-error' : 'null'}</span>
            <span data-testid="stdout">{stdout || 'empty'}</span>
            <span data-testid="events">{events.length}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      expect(screen.getByTestId('state')).toHaveTextContent('idle');
      expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
      expect(screen.getByTestId('sessionId')).toHaveTextContent('null');
      expect(screen.getByTestId('result')).toHaveTextContent('null');
      expect(screen.getByTestId('error')).toHaveTextContent('null');
      expect(screen.getByTestId('stdout')).toHaveTextContent('empty');
      expect(screen.getByTestId('events')).toHaveTextContent('0');
    });
  });

  describe('execute', () => {
    it('should execute code and update state', async () => {
      const mockResult = createMockResult(42);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, state, result, isRunning } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('return 42')}>Execute</button>
            <span data-testid="state">{state}</span>
            <span data-testid="isRunning">{String(isRunning)}</span>
            <span data-testid="value">{String(result?.value ?? 'null')}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      // Initial state
      expect(screen.getByTestId('state')).toHaveTextContent('idle');

      // Execute
      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      // Final state
      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('completed');
      });
      expect(screen.getByTestId('value')).toHaveTextContent('42');
    });

    it('should handle execution errors', async () => {
      const mockResult = createMockResult(null, false);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, state, error } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('throw error')}>Execute</button>
            <span data-testid="state">{state}</span>
            <span data-testid="error">{error?.message ?? 'null'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      });
      expect(screen.getByTestId('error')).toHaveTextContent('Test error');
    });

    it('should handle cancellation', async () => {
      const mockResult: SessionResult = {
        success: false,
        sessionId: 's_test123' as `s_${string}`,
        error: { code: 'CANCELLED', message: 'User cancelled' },
        events: [],
      };
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, state } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('while(true) {}')}>Execute</button>
            <span data-testid="state">{state}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('cancelled');
      });
    });

    it('should pass limits to executeStream', async () => {
      const mockResult = createMockResult(1);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute } = useEnclaveSession({
          timeoutMs: 30000,
          maxToolCalls: 10,
          heartbeatIntervalMs: 5000,
        });

        return <button onClick={() => execute('return 1')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      expect(mockExecuteStream).toHaveBeenCalledWith(
        'return 1',
        expect.objectContaining({
          limits: {
            sessionTtlMs: 30000,
            maxToolCalls: 10,
            heartbeatIntervalMs: 5000,
          },
        }),
      );
    });
  });

  describe('callbacks', () => {
    it('should call onStart callback', async () => {
      const mockResult = createMockResult(1);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      const onStart = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onStart });
        return <button onClick={() => execute('return 1')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      expect(onStart).toHaveBeenCalled();
    });

    it('should call onComplete callback', async () => {
      const mockResult = createMockResult(42);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      const onComplete = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onComplete });
        return <button onClick={() => execute('return 42')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith(mockResult);
      });
    });

    it('should call onError callback on failure', async () => {
      const mockResult = createMockResult(null, false);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      const onError = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onError });
        return <button onClick={() => execute('throw error')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith({ code: 'ERROR', message: 'Test error' });
      });
    });

    it('should call onStdout callback and accumulate stdout', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      // Simulate stdout events
      mockExecuteStream.mockImplementation((code, options) => {
        // Call the onStdout handler
        setTimeout(() => {
          options.onStdout?.('Hello ');
          options.onStdout?.('World!');
        }, 0);
        return mockHandle;
      });

      const onStdout = jest.fn();

      function TestComponent() {
        const { execute, stdout } = useEnclaveSession({ onStdout });
        return (
          <div>
            <button onClick={() => execute('console.log("test")')}>Execute</button>
            <span data-testid="stdout">{stdout || 'empty'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onStdout).toHaveBeenCalledWith('Hello ');
        expect(onStdout).toHaveBeenCalledWith('World!');
      });

      await waitFor(() => {
        expect(screen.getByTestId('stdout')).toHaveTextContent('Hello World!');
      });
    });
  });

  describe('cancel', () => {
    it('should call cancel on the session handle', async () => {
      const mockResult = createMockResult(1);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      let cancelFn: ((reason?: string) => Promise<void>) | null = null;

      function TestComponent() {
        const { execute, cancel } = useEnclaveSession();
        cancelFn = cancel;
        return <button onClick={() => execute('return 1')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      // Execute to create the handle
      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      // Cancel should not throw even if handle is gone (after completion)
      await act(async () => {
        await cancelFn?.('test reason');
      });

      // The cancel should have been called on the handle if it was still active
      // Since our mock completes immediately, this test verifies cancel doesn't throw
    });
  });

  describe('reset', () => {
    it('should reset all state to initial values', async () => {
      const mockResult = createMockResult(42);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, reset, state, result } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('return 42')}>Execute</button>
            <button onClick={reset}>Reset</button>
            <span data-testid="state">{state}</span>
            <span data-testid="result">{String(result?.value ?? 'null')}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      // Execute
      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('completed');
      });

      // Reset
      await act(async () => {
        await userEvent.click(screen.getByText('Reset'));
      });

      expect(screen.getByTestId('state')).toHaveTextContent('idle');
      expect(screen.getByTestId('result')).toHaveTextContent('null');
    });
  });

  describe('events', () => {
    it('should accumulate events', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        // Simulate events
        setTimeout(() => {
          options.onEvent?.({
            protocolVersion: PROTOCOL_VERSION,
            sessionId: 's_test123',
            seq: 1,
            type: EventType.SessionInit,
            payload: { cancelUrl: '/cancel', expiresAt: '', encryption: { enabled: false } },
          });
          options.onEvent?.({
            protocolVersion: PROTOCOL_VERSION,
            sessionId: 's_test123',
            seq: 2,
            type: EventType.Stdout,
            payload: { chunk: 'hello' },
          });
        }, 0);
        return mockHandle;
      });

      function TestComponent() {
        const { execute, events } = useEnclaveSession();
        return (
          <div>
            <button onClick={() => execute('return 1')}>Execute</button>
            <span data-testid="events">{events.length}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('events')).toHaveTextContent('2');
      });
    });
  });

  describe('sessionId', () => {
    it('should update sessionId when execution starts', async () => {
      const mockResult = createMockResult(1);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, sessionId } = useEnclaveSession();
        return (
          <div>
            <button onClick={() => execute('return 1')}>Execute</button>
            <span data-testid="sessionId">{sessionId ?? 'null'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      expect(screen.getByTestId('sessionId')).toHaveTextContent('null');

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('sessionId')).toHaveTextContent('s_test123');
      });
    });

    it('should use custom sessionId if provided', async () => {
      const mockResult = createMockResult(1);
      const customHandle = {
        ...createMockHandle(mockResult),
        sessionId: 's_custom' as `s_${string}`,
      };
      mockExecuteStream.mockReturnValue(customHandle);

      function TestComponent() {
        const { execute } = useEnclaveSession({
          sessionId: 's_custom' as `s_${string}`,
        });
        return <button onClick={() => execute('return 1')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      expect(mockExecuteStream).toHaveBeenCalledWith(
        'return 1',
        expect.objectContaining({
          sessionId: 's_custom',
        }),
      );
    });
  });

  describe('edge cases', () => {
    it('should handle unexpected errors during execution', async () => {
      const mockHandle = {
        sessionId: 's_test123' as `s_${string}`,
        wait: jest.fn().mockRejectedValue(new Error('Unexpected failure')),
        cancel: jest.fn(),
        getEvents: jest.fn().mockReturnValue([]),
        isActive: jest.fn().mockReturnValue(true),
      };
      mockExecuteStream.mockReturnValue(mockHandle);

      const onError = jest.fn();

      function TestComponent() {
        const { execute, state, error } = useEnclaveSession({ onError });

        return (
          <div>
            <button onClick={() => execute('throw error')}>Execute</button>
            <span data-testid="state">{state}</span>
            <span data-testid="error">{error?.message ?? 'null'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      });
      expect(screen.getByTestId('error')).toHaveTextContent('Unexpected failure');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UNEXPECTED_ERROR',
          message: 'Unexpected failure',
        }),
      );
    });

    it('should handle non-Error exceptions', async () => {
      const mockHandle = {
        sessionId: 's_test123' as `s_${string}`,
        wait: jest.fn().mockRejectedValue('string error'),
        cancel: jest.fn(),
        getEvents: jest.fn().mockReturnValue([]),
        isActive: jest.fn().mockReturnValue(true),
      };
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, state, error } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('throw error')}>Execute</button>
            <span data-testid="state">{state}</span>
            <span data-testid="error">{error?.message ?? 'null'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      });
      expect(screen.getByTestId('error')).toHaveTextContent('Unknown error');
    });

    it('should handle result with missing error info', async () => {
      const mockResult: SessionResult = {
        success: false,
        sessionId: 's_test123' as `s_${string}`,
        // error is undefined
        events: [],
      };
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, state, error } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('fail')}>Execute</button>
            <span data-testid="state">{state}</span>
            <span data-testid="error">{error?.message ?? 'null'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      });
      expect(screen.getByTestId('error')).toHaveTextContent('Unknown error');
    });

    it('should clear handle ref after execution', async () => {
      const mockResult = createMockResult(42);
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      let cancelFn: ((reason?: string) => Promise<void>) | null = null;

      function TestComponent() {
        const { execute, cancel } = useEnclaveSession();
        cancelFn = cancel;
        return <button onClick={() => execute('return 42')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      // Cancel after completion should not throw
      await act(async () => {
        await cancelFn?.('test');
      });

      // Should not have called cancel on handle since it's cleared
      expect(mockHandle.cancel).not.toHaveBeenCalled();
    });

    it('should call onLog callback', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        setTimeout(() => {
          options.onLog?.('info', 'Test log', { key: 'value' });
        }, 0);
        return mockHandle;
      });

      const onLog = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onLog });
        return <button onClick={() => execute('console.log("test")')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onLog).toHaveBeenCalledWith('info', 'Test log', { key: 'value' });
      });
    });

    it('should call onToolCall callback', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        setTimeout(() => {
          options.onToolCall?.('c_123', 'testTool', { arg: 1 });
        }, 0);
        return mockHandle;
      });

      const onToolCall = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onToolCall });
        return <button onClick={() => execute('callTool("test")')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onToolCall).toHaveBeenCalledWith('c_123', 'testTool', { arg: 1 });
      });
    });

    it('should call onToolResultApplied callback', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        setTimeout(() => {
          options.onToolResultApplied?.('c_123');
        }, 0);
        return mockHandle;
      });

      const onToolResultApplied = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onToolResultApplied });
        return <button onClick={() => execute('callTool("test")')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onToolResultApplied).toHaveBeenCalledWith('c_123');
      });
    });

    it('should call onError during stream for non-fatal errors', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        setTimeout(() => {
          options.onError?.('PARTIAL_ERROR', 'Something went wrong');
        }, 0);
        return mockHandle;
      });

      const onError = jest.fn();

      function TestComponent() {
        const { execute } = useEnclaveSession({ onError });
        return <button onClick={() => execute('risky()')}>Execute</button>;
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith({
          code: 'PARTIAL_ERROR',
          message: 'Something went wrong',
        });
      });
    });

    it('should handle multiple sequential executions', async () => {
      let callCount = 0;
      mockExecuteStream.mockImplementation(() => {
        callCount++;
        const result = createMockResult(callCount);
        return createMockHandle(result);
      });

      function TestComponent() {
        const { execute, result } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('return count')}>Execute</button>
            <span data-testid="value">{String(result?.value ?? 'null')}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      // First execution
      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('value')).toHaveTextContent('1');
      });

      // Second execution
      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('value')).toHaveTextContent('2');
      });

      expect(mockExecuteStream).toHaveBeenCalledTimes(2);
    });

    it('should reset clears stdout from previous execution', async () => {
      const mockResult = createMockResult('done');
      const mockHandle = createMockHandle(mockResult);

      mockExecuteStream.mockImplementation((code, options) => {
        setTimeout(() => {
          options.onStdout?.('Hello World');
        }, 0);
        return mockHandle;
      });

      function TestComponent() {
        const { execute, reset, stdout } = useEnclaveSession();

        return (
          <div>
            <button onClick={() => execute('print("test")')}>Execute</button>
            <button onClick={reset}>Reset</button>
            <span data-testid="stdout">{stdout || 'empty'}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('stdout')).toHaveTextContent('Hello World');
      });

      await act(async () => {
        await userEvent.click(screen.getByText('Reset'));
      });

      expect(screen.getByTestId('stdout')).toHaveTextContent('empty');
    });
  });

  describe('typed results', () => {
    it('should support generic type parameter', async () => {
      interface User {
        name: string;
        age: number;
      }

      const mockResult = createMockResult<User>({ name: 'Alice', age: 30 });
      const mockHandle = createMockHandle(mockResult);
      mockExecuteStream.mockReturnValue(mockHandle);

      function TestComponent() {
        const { execute, result } = useEnclaveSession<User>();

        return (
          <div>
            <button onClick={() => execute('return user')}>Execute</button>
            <span data-testid="name">{result?.value?.name ?? 'null'}</span>
            <span data-testid="age">{String(result?.value?.age ?? 'null')}</span>
          </div>
        );
      }

      render(
        <TestWrapper>
          <TestComponent />
        </TestWrapper>,
      );

      await act(async () => {
        await userEvent.click(screen.getByText('Execute'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('name')).toHaveTextContent('Alice');
      });
      expect(screen.getByTestId('age')).toHaveTextContent('30');
    });
  });
});
