/**
 * Session State Machine
 *
 * Manages state transitions for execution sessions.
 *
 * @packageDocumentation
 */

import type { SessionStateValue } from '../session-types';

/**
 * State transition event types
 */
export type StateTransitionEvent =
  | { type: 'start' }
  | { type: 'running' }
  | { type: 'tool_call'; callId: string; toolName: string }
  | { type: 'tool_result'; callId: string }
  | { type: 'complete'; value?: unknown }
  | { type: 'cancel'; reason?: string }
  | { type: 'error'; error: Error };

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<SessionStateValue, SessionStateValue[]> = {
  starting: ['running', 'failed', 'cancelled'],
  running: ['waiting_for_tool', 'completed', 'failed', 'cancelled'],
  waiting_for_tool: ['running', 'failed', 'cancelled'],
  completed: [], // Terminal state
  cancelled: [], // Terminal state
  failed: [], // Terminal state
};

/**
 * State transition handler
 */
export type StateTransitionHandler = (
  from: SessionStateValue,
  to: SessionStateValue,
  event: StateTransitionEvent,
) => void;

/**
 * Session State Machine
 *
 * Enforces valid state transitions and notifies listeners.
 */
export class SessionStateMachine {
  private state: SessionStateValue;
  private readonly handlers: Set<StateTransitionHandler>;
  private pendingCallId: string | null = null;
  private completionValue: unknown = undefined;
  private errorValue: Error | null = null;
  private cancelReason: string | null = null;

  constructor(initialState: SessionStateValue = 'starting') {
    this.state = initialState;
    this.handlers = new Set();
  }

  /**
   * Get current state
   */
  getState(): SessionStateValue {
    return this.state;
  }

  /**
   * Get pending call ID (when in waiting_for_tool state)
   */
  getPendingCallId(): string | null {
    return this.pendingCallId;
  }

  /**
   * Get completion value (when in completed state)
   */
  getCompletionValue(): unknown {
    return this.completionValue;
  }

  /**
   * Get error (when in failed state)
   */
  getError(): Error | null {
    return this.errorValue;
  }

  /**
   * Get cancel reason (when in cancelled state)
   */
  getCancelReason(): string | null {
    return this.cancelReason;
  }

  /**
   * Check if in a terminal state
   */
  isTerminal(): boolean {
    return this.state === 'completed' || this.state === 'cancelled' || this.state === 'failed';
  }

  /**
   * Subscribe to state transitions
   */
  onTransition(handler: StateTransitionHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Transition based on an event
   *
   * @throws Error if transition is invalid
   */
  transition(event: StateTransitionEvent): void {
    const targetState = this.getTargetState(event);

    if (!this.canTransition(targetState)) {
      throw new Error(`Invalid state transition: ${this.state} -> ${targetState} (event: ${event.type})`);
    }

    const previousState = this.state;
    this.state = targetState;

    // Update internal state based on event
    this.updateInternalState(event);

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(previousState, targetState, event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Check if a transition to target state is valid
   */
  canTransition(targetState: SessionStateValue): boolean {
    const validTargets = VALID_TRANSITIONS[this.state];
    return validTargets.includes(targetState);
  }

  /**
   * Get the target state for an event
   */
  private getTargetState(event: StateTransitionEvent): SessionStateValue {
    switch (event.type) {
      case 'start':
        return 'starting';
      case 'running':
        return 'running';
      case 'tool_call':
        return 'waiting_for_tool';
      case 'tool_result':
        return 'running';
      case 'complete':
        return 'completed';
      case 'cancel':
        return 'cancelled';
      case 'error':
        return 'failed';
    }
  }

  /**
   * Update internal state based on event
   */
  private updateInternalState(event: StateTransitionEvent): void {
    switch (event.type) {
      case 'tool_call':
        this.pendingCallId = event.callId;
        break;
      case 'tool_result':
        this.pendingCallId = null;
        break;
      case 'complete':
        this.completionValue = event.value;
        break;
      case 'error':
        this.errorValue = event.error;
        break;
      case 'cancel':
        this.cancelReason = event.reason ?? null;
        break;
    }
  }

  /**
   * Reset the state machine
   */
  reset(): void {
    this.state = 'starting';
    this.pendingCallId = null;
    this.completionValue = undefined;
    this.errorValue = null;
    this.cancelReason = null;
  }

  /**
   * Clear all handlers
   */
  clearHandlers(): void {
    this.handlers.clear();
  }
}

/**
 * Create a new session state machine
 */
export function createSessionStateMachine(initialState?: SessionStateValue): SessionStateMachine {
  return new SessionStateMachine(initialState);
}
