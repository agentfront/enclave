import type { HostToolHandler, ToolHandler, ToolResultOrder } from './types';
import { sanitizeValue } from './value-sanitizer';

const nextTurn: (task: () => void) => void =
  typeof setImmediate === 'function'
    ? (task) => {
        setImmediate(task);
      }
    : (task) => {
        setTimeout(task, 0);
      };

/** A copy of a result to hold for its turn, within the sanitize limits; a result the copy refuses fails the call */
export function boundedSnapshot(
  limits: { maxSanitizeDepth?: number; maxSanitizeProperties?: number },
  onRefused?: () => void,
): (value: unknown) => unknown {
  return (value) => {
    try {
      return sanitizeValue(value, {
        maxDepth: limits.maxSanitizeDepth,
        maxProperties: limits.maxSanitizeProperties,
        allowDates: true,
        allowErrors: true,
      });
    } catch (error: unknown) {
      onRefused?.();
      const refusal = new Error(error instanceof Error ? error.message : 'Tool returned an unsupported value');
      throw Object.assign(refusal, { name: 'ToolBridgeError', code: 'TOOL_RESULT_NOT_SAFE' });
    }
  };
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
        (error: unknown) => hold(callIndex, () => reject(error)),
      );
    });
  };
}
