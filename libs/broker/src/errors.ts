/**
 * Broker errors
 *
 * @packageDocumentation
 */

/**
 * Codes of the errors the broker raises itself.
 */
export const BrokerErrorCode = {
  /** The session id is not a usable id */
  InvalidSessionId: 'INVALID_SESSION_ID',
  /** A session with this id is registered */
  SessionExists: 'SESSION_EXISTS',
  /** The broker holds as many sessions as `maxSessions` allows */
  MaxSessionsReached: 'MAX_SESSIONS_REACHED',
} as const;

export type BrokerErrorCode = (typeof BrokerErrorCode)[keyof typeof BrokerErrorCode];

/**
 * An error with a machine-readable code.
 */
export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
  }
}
