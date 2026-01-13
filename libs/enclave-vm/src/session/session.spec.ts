import { EventType, generateCallId } from '@enclavejs/types';
import type { StreamEvent, CallId } from '@enclavejs/types';
import { Session, createSession } from './session';
import { SessionEmitter, createSessionEmitter } from './session-emitter';
import { SessionStateMachine, createSessionStateMachine } from './session-state-machine';
import type { ToolResult } from '../session-types';

describe('Session Module', () => {
  describe('SessionStateMachine', () => {
    it('should start in starting state by default', () => {
      const machine = createSessionStateMachine();
      expect(machine.getState()).toBe('starting');
    });

    it('should transition from starting to running', () => {
      const machine = createSessionStateMachine();
      machine.transition({ type: 'running' });
      expect(machine.getState()).toBe('running');
    });

    it('should transition from running to waiting_for_tool', () => {
      const machine = createSessionStateMachine('running');
      machine.transition({ type: 'tool_call', callId: 'c_test', toolName: 'test' });
      expect(machine.getState()).toBe('waiting_for_tool');
      expect(machine.getPendingCallId()).toBe('c_test');
    });

    it('should transition from waiting_for_tool to running', () => {
      const machine = createSessionStateMachine('waiting_for_tool');
      machine.transition({ type: 'tool_result', callId: 'c_test' });
      expect(machine.getState()).toBe('running');
      expect(machine.getPendingCallId()).toBeNull();
    });

    it('should transition to completed state', () => {
      const machine = createSessionStateMachine('running');
      machine.transition({ type: 'complete', value: 42 });
      expect(machine.getState()).toBe('completed');
      expect(machine.getCompletionValue()).toBe(42);
      expect(machine.isTerminal()).toBe(true);
    });

    it('should transition to failed state', () => {
      const machine = createSessionStateMachine('running');
      const error = new Error('Test error');
      machine.transition({ type: 'error', error });
      expect(machine.getState()).toBe('failed');
      expect(machine.getError()).toBe(error);
      expect(machine.isTerminal()).toBe(true);
    });

    it('should transition to cancelled state', () => {
      const machine = createSessionStateMachine('running');
      machine.transition({ type: 'cancel', reason: 'User cancelled' });
      expect(machine.getState()).toBe('cancelled');
      expect(machine.getCancelReason()).toBe('User cancelled');
      expect(machine.isTerminal()).toBe(true);
    });

    it('should throw on invalid transitions', () => {
      const machine = createSessionStateMachine('completed');
      expect(() => machine.transition({ type: 'running' })).toThrow('Invalid state transition');
    });

    it('should notify handlers on transition', () => {
      const machine = createSessionStateMachine();
      const handler = jest.fn();
      machine.onTransition(handler);

      machine.transition({ type: 'running' });

      expect(handler).toHaveBeenCalledWith('starting', 'running', { type: 'running' });
    });

    it('should allow unsubscribing from transitions', () => {
      const machine = createSessionStateMachine();
      const handler = jest.fn();
      const unsubscribe = machine.onTransition(handler);

      unsubscribe();
      machine.transition({ type: 'running' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should reset correctly', () => {
      const machine = createSessionStateMachine();
      machine.transition({ type: 'running' });
      machine.transition({ type: 'complete', value: 42 });

      machine.reset();

      expect(machine.getState()).toBe('starting');
      expect(machine.getCompletionValue()).toBeUndefined();
      expect(machine.isTerminal()).toBe(false);
    });
  });

  describe('SessionEmitter', () => {
    const sessionId = 's_test123' as `s_${string}`;

    it('should emit session_init event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitSessionInit();

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.SessionInit);
      expect(events[0]?.sessionId).toBe(sessionId);
      expect(events[0]?.seq).toBe(1);
    });

    it('should emit stdout event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitStdout('Hello, World!');

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Stdout);
      if (events[0]?.type === EventType.Stdout) {
        expect(events[0].payload.chunk).toBe('Hello, World!');
      }
    });

    it('should emit log events', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitLog('info', 'Test message', { key: 'value' });

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Log);
      if (events[0]?.type === EventType.Log) {
        expect(events[0].payload.level).toBe('info');
        expect(events[0].payload.message).toBe('Test message');
        expect(events[0].payload.data).toEqual({ key: 'value' });
      }
    });

    it('should emit tool_call event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      const callId = 'c_call123' as CallId;
      emitter.emitToolCall(callId, 'myTool', { arg1: 'value1' });

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.ToolCall);
      if (events[0]?.type === EventType.ToolCall) {
        expect(events[0].payload.callId).toBe(callId);
        expect(events[0].payload.toolName).toBe('myTool');
        expect(events[0].payload.args).toEqual({ arg1: 'value1' });
      }
    });

    it('should emit final success event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitFinalSuccess(
        { result: 'success' },
        {
          durationMs: 1000,
          toolCallCount: 2,
          stdoutBytes: 100,
        },
      );

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Final);
      if (events[0]?.type === EventType.Final) {
        expect(events[0].payload.ok).toBe(true);
        expect(events[0].payload.result).toEqual({ result: 'success' });
      }
    });

    it('should emit final error event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitFinalError(
        { code: 'TEST_ERROR', message: 'Test failed' },
        { durationMs: 500, toolCallCount: 1, stdoutBytes: 50 },
      );

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Final);
      if (events[0]?.type === EventType.Final) {
        expect(events[0].payload.ok).toBe(false);
        expect(events[0].payload.error?.message).toBe('Test failed');
      }
    });

    it('should emit heartbeat event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitHeartbeat();

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Heartbeat);
    });

    it('should emit error event', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitError('CONNECTION_LOST', 'Connection lost', true);

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe(EventType.Error);
      if (events[0]?.type === EventType.Error) {
        expect(events[0].payload.code).toBe('CONNECTION_LOST');
        expect(events[0].payload.recoverable).toBe(true);
      }
    });

    it('should increment sequence numbers', () => {
      const emitter = createSessionEmitter(sessionId);
      const events: StreamEvent[] = [];
      emitter.on((e) => events.push(e));

      emitter.emitStdout('1');
      emitter.emitStdout('2');
      emitter.emitStdout('3');

      expect(events[0]?.seq).toBe(1);
      expect(events[1]?.seq).toBe(2);
      expect(events[2]?.seq).toBe(3);
    });

    it('should track emitted events', () => {
      const emitter = createSessionEmitter(sessionId);
      emitter.emitStdout('1');
      emitter.emitStdout('2');

      const events = emitter.getEmittedEvents();
      expect(events.length).toBe(2);
    });

    it('should allow multiple handlers', () => {
      const emitter = createSessionEmitter(sessionId);
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      emitter.on(handler1);
      emitter.on(handler2);
      emitter.emitStdout('test');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should allow unsubscribing', () => {
      const emitter = createSessionEmitter(sessionId);
      const handler = jest.fn();
      const unsubscribe = emitter.on(handler);

      unsubscribe();
      emitter.emitStdout('test');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Session', () => {
    it('should create a session with generated ID', () => {
      const session = createSession();
      expect(session.sessionId).toMatch(/^s_/);
      expect(session.state).toBe('starting');
    });

    it('should create a session with provided ID', () => {
      const sessionId = 's_custom123' as `s_${string}`;
      const session = createSession({ sessionId });
      expect(session.sessionId).toBe(sessionId);
    });

    it('should start and emit session_init', () => {
      const session = createSession();
      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.start();

      expect(session.state).toBe('running');
      expect(events.some((e) => e.type === EventType.SessionInit)).toBe(true);
    });

    it('should emit stdout and track bytes', () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.emitStdout('Hello');

      expect(events.some((e) => e.type === EventType.Stdout)).toBe(true);
    });

    it('should emit log events', () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.emitLog('info', 'Test log');

      expect(events.some((e) => e.type === EventType.Log)).toBe(true);
    });

    it('should request tool call and wait for result', async () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      // Start the tool call (don't await yet)
      const toolPromise = session.requestToolCall('myTool', { arg: 'value' });

      expect(session.state).toBe('waiting_for_tool');
      expect(session.pendingToolCall).toBeDefined();
      expect(session.pendingToolCall?.toolName).toBe('myTool');
      expect(events.some((e) => e.type === EventType.ToolCall)).toBe(true);

      // Submit the result
      const result: ToolResult = {
        callId: session.pendingToolCall!.callId,
        success: true,
        value: { result: 'done' },
      };
      await session.submitToolResult(result);

      expect(session.state).toBe('running');
      expect(session.pendingToolCall).toBeNull();

      // The tool promise should resolve
      const toolResult = await toolPromise;
      expect(toolResult).toEqual({ result: 'done' });
    });

    it('should handle tool call error', async () => {
      const session = createSession();
      session.start();

      const toolPromise = session.requestToolCall('failingTool', {});

      const result: ToolResult = {
        callId: session.pendingToolCall!.callId,
        success: false,
        error: { message: 'Tool failed', code: 'TOOL_ERROR' },
      };
      await session.submitToolResult(result);

      await expect(toolPromise).rejects.toThrow('Tool failed');
    });

    it('should throw when submitting result for wrong call ID', async () => {
      const session = createSession();
      session.start();

      // Start tool call but don't await (it will hang waiting for result)
      const toolPromise = session.requestToolCall('myTool', {});

      const result: ToolResult = {
        callId: 'c_wrong' as CallId,
        success: true,
        value: 'result',
      };

      await expect(session.submitToolResult(result)).rejects.toThrow('Tool result callId mismatch');

      // Clean up - cancel the session to resolve the hanging promise
      await session.cancel();
      await toolPromise.catch(() => {}); // Ignore rejection
    });

    it('should complete session successfully', async () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.complete({ result: 'success' });

      expect(session.state).toBe('completed');
      expect(events.some((e) => e.type === EventType.Final)).toBe(true);

      const waitResult = await session.wait();
      expect(waitResult.success).toBe(true);
      expect(waitResult.value).toEqual({ result: 'success' });
      expect(waitResult.finalState).toBe('completed');
    });

    it('should fail session with error', async () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.fail(new Error('Test error'));

      expect(session.state).toBe('failed');

      const waitResult = await session.wait();
      expect(waitResult.success).toBe(false);
      expect(waitResult.error?.message).toBe('Test error');
      expect(waitResult.finalState).toBe('failed');
    });

    it('should cancel session', async () => {
      const session = createSession();
      session.start();

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      await session.cancel('User cancelled');

      expect(session.state).toBe('cancelled');

      const waitResult = await session.wait();
      expect(waitResult.success).toBe(false);
      expect(waitResult.finalState).toBe('cancelled');
    });

    it('should reject pending tool call on cancel', async () => {
      const session = createSession();
      session.start();

      const toolPromise = session.requestToolCall('myTool', {});
      await session.cancel();

      await expect(toolPromise).rejects.toThrow('Session cancelled');
    });

    it('should get stats', () => {
      const session = createSession();
      session.start();

      const stats = session.getStats();
      expect(stats.toolCallCount).toBe(0);
      expect(stats.duration).toBeGreaterThanOrEqual(0);
    });

    it('should increment tool call count', async () => {
      const session = createSession();
      session.start();

      // Start a tool call
      session.requestToolCall('tool1', {}).catch(() => {});
      await session.submitToolResult({
        callId: session.pendingToolCall!.callId,
        success: true,
        value: null,
      });

      const stats = session.getStats();
      expect(stats.toolCallCount).toBe(1);
    });

    it('should not emit events after terminal state', () => {
      const session = createSession();
      session.start();
      session.complete('done');

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.emitStdout('should not appear');
      session.emitLog('info', 'should not appear');

      // Filter out any events that might have been emitted before
      const postCompleteEvents = events.filter((e) => e.type === EventType.Stdout || e.type === EventType.Log);
      expect(postCompleteEvents.length).toBe(0);
    });

    it('should call async tool handler', async () => {
      const toolHandler = jest.fn();
      const session = createSession({ toolHandler });
      session.start();

      session.requestToolCall('myTool', { arg: 'value' }).catch(() => {});

      expect(toolHandler).toHaveBeenCalledWith(expect.stringMatching(/^c_/), 'myTool', { arg: 'value' });
    });

    it('should have heartbeat functionality', () => {
      jest.useFakeTimers();

      const session = createSession({
        config: { heartbeatIntervalMs: 1000 },
      });

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.start();

      // Fast-forward time
      jest.advanceTimersByTime(3500);

      const heartbeats = events.filter((e) => e.type === EventType.Heartbeat);
      expect(heartbeats.length).toBe(3);

      session.complete('done');

      jest.useRealTimers();
    });

    it('should stop heartbeat on completion', () => {
      jest.useFakeTimers();

      const session = createSession({
        config: { heartbeatIntervalMs: 1000 },
      });

      const events: StreamEvent[] = [];
      session.events.on((e) => events.push(e));

      session.start();
      session.complete('done');

      // Clear existing events
      const countBefore = events.filter((e) => e.type === EventType.Heartbeat).length;

      // Fast-forward time - no more heartbeats should be emitted
      jest.advanceTimersByTime(5000);

      const countAfter = events.filter((e) => e.type === EventType.Heartbeat).length;
      expect(countAfter).toBe(countBefore);

      jest.useRealTimers();
    });
  });
});
