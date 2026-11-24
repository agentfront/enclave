import type { HostToolHandler, ToolHandler, ToolResultOrder } from './types';
import { resultLimitRefusal } from './tool-bridge';
import { sanitizeValue } from './value-sanitizer';

const nextTurn: (task: () => void) => void =
  typeof setImmediate === 'function'
    ? (task) => {
        setImmediate(task);
      }
    : (task) => {
        setTimeout(task, 0);
      };

function refusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { name: 'ToolBridgeError', code });
}

/** A copy of a result to hold for its turn, within the run's limits; a result over them fails the call at once */
export function boundedSnapshot(
  limits: { maxSanitizeDepth?: number; maxSanitizeProperties?: number; maxToolResultBytes?: number },
  onRefused?: () => void,
): (value: unknown) => unknown {
  return (value) => {
    let copy: unknown;
    try {
      copy = sanitizeValue(value, {
        maxDepth: limits.maxSanitizeDepth,
        maxProperties: limits.maxSanitizeProperties,
        allowDates: true,
        allowErrors: true,
      });
    } catch (error: unknown) {
      onRefused?.();
      throw refusal(
        error instanceof Error ? error.message : 'Tool returned an unsupported value',
        'TOOL_RESULT_NOT_SAFE',
      );
    }
    const overLimit = resultLimitRefusal(copy, limits.maxToolResultBytes);
    if (overLimit) {
      onRefused?.();
      throw refusal(overLimit.message, overLimit.code);
    }
    return copy;
  };
}

/** The fields of a failure the bridge reads, taken when the call settles */
function settledFailure(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { name, message, code } = error as { name?: unknown; message?: unknown; code?: unknown };
  const copy = new Error(typeof message === 'string' ? message : '');
  if (typeof name === 'string') copy.name = name;
  return typeof code === 'string' ? Object.assign(copy, { code }) : copy;
}

/** Numbers each call in the order it reaches the host; in 'call' order, holds a snapshot of each result for its turn */
export function numberToolCalls(
  handler: ToolHandler,
  order: ToolResultOrder = 'completion',
  snapshot: (value: unknown) => unknown = (value) => value,
): HostToolHandler {
  let nextCallIndex = 0;
  if (order === 'completion') {
    return (toolName, args) => handler(toolName, args, { callIndex: nextCallIndex++ });
  }

  const settled = new Map<number, () => void>();
  let nextDelivery = 0;
  let delivering = false;
  const deliverNext = (): void => {
    const deliver = settled.get(nextDelivery);
    if (!deliver) {
      delivering = false;
      return;
    }
    settled.delete(nextDelivery);
    nextDelivery++;
    deliver();
    nextTurn(deliverNext);
  };
  const hold = (callIndex: number, deliver: () => void): void => {
    settled.set(callIndex, deliver);
    if (!delivering) {
      delivering = true;
      nextTurn(deliverNext);
    }
  };

  return (toolName, args) => {
    const callIndex = nextCallIndex++;
    return new Promise((resolve, reject) => {
      new Promise<unknown>((started) => started(handler(toolName, args, { callIndex }))).then(snapshot).then(
        (value) => hold(callIndex, () => resolve(value)),
        (error: unknown) => {
          const failure = settledFailure(error);
          hold(callIndex, () => reject(failure));
        },
      );
    });
  };
}
