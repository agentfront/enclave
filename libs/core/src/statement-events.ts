import { assertIntegerOption } from './enclave-options';
import type { StatementEvent } from './types';

export const DEFAULT_MAX_STATEMENT_EVENTS = 10_000;

/** The run options that report the statements a script runs (interpreter only) */
export interface StatementEventOptions {
  /** Called as each statement starts; carries no value of the script. A throw ends the run */
  onStatement?: (event: StatementEvent) => void;
  /** How many statements a run reports at most; the rest of the run reports none (default 10,000) */
  maxStatementEvents?: number;
}

/** The run's `onStatement`, called for at most `maxStatementEvents` statements, or undefined without one */
export function boundedStatementHook(
  options: StatementEventOptions,
  reportsStatements: boolean | undefined,
): ((event: StatementEvent) => void) | undefined {
  const { onStatement, maxStatementEvents = DEFAULT_MAX_STATEMENT_EVENTS } = options;
  assertIntegerOption('maxStatementEvents', maxStatementEvents, 1);
  if (onStatement === undefined) return undefined;
  if (typeof onStatement !== 'function') throw new TypeError('onStatement must be a function');
  if (reportsStatements !== true) {
    throw new TypeError('onStatement needs an adapter that reports statements, such as InterpreterAdapter');
  }
  let reported = 0;
  return (event) => {
    if (reported >= maxStatementEvents) return;
    reported++;
    onStatement(event);
  };
}
