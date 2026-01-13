/**
 * Session Module
 *
 * Provides streaming session support for the Enclave.
 *
 * @packageDocumentation
 */

// Session class and factory
export { Session, createSession } from './session';
export type { SessionOptions } from './session';

// Event emitter
export { SessionEmitter, createSessionEmitter } from './session-emitter';
export type { SessionEmitterConfig } from './session-emitter';

// State machine
export { SessionStateMachine, createSessionStateMachine } from './session-state-machine';
export type { StateTransitionEvent, StateTransitionHandler } from './session-state-machine';

// Runtime channels
export { EmbeddedChannel, createEmbeddedChannelPair } from './channels';
export type { EmbeddedChannelOptions } from './channels';
