import type { HostToolHandler, ToolHandler, ToolResultOrder } from './types';

const nextTurn: (task: () => void) => void =
  typeof setImmediate === 'function'
    ? (task) => {
        setImmediate(task);
      }
    : (task) => {
        setTimeout(task, 0);
      };

/** Numbers each call in the order it reaches the host; in 'call' order, delivers one result per turn, in call order */
export function numberToolCalls(handler: ToolHandler, order: ToolResultOrder = 'completion'): HostToolHandler {
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
      new Promise<unknown>((started) => started(handler(toolName, args, { callIndex }))).then(
        (value) => hold(callIndex, () => resolve(value)),
        (error: unknown) => hold(callIndex, () => reject(error)),
      );
    });
  };
}
