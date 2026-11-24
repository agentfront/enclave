import type { HostToolHandler, ToolHandler } from './types';

const nextTurn: (task: () => void) => void =
  typeof setImmediate === 'function'
    ? (task) => {
        setImmediate(task);
      }
    : (task) => {
        setTimeout(task, 0);
      };

/** Numbers each call in the order it reaches the host: the `callIndex` the handler and the review hooks get */
export function numberToolCalls(handler: ToolHandler): HostToolHandler {
  let nextCallIndex = 0;
  return (toolName, args) => handler(toolName, args, { callIndex: nextCallIndex++ });
}

/**
 * The tool bridge with its responses delivered in call order, one per turn of the event loop. What
 * waits for its turn is the bridge's response, bounded and sanitized; once the run is aborted nothing waits.
 */
export function inCallOrder(
  bridge: (requestJson: string) => Promise<string>,
  signal: AbortSignal,
): (requestJson: string) => Promise<string> {
  const settled = new Map<number, () => void>();
  let nextCall = 0;
  let nextDelivery = 0;
  let delivering = false;
  signal.addEventListener('abort', () => settled.clear(), { once: true });
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
  const hold = (call: number, deliver: () => void): void => {
    if (signal.aborted) return;
    settled.set(call, deliver);
    if (!delivering) {
      delivering = true;
      nextTurn(deliverNext);
    }
  };
  return (requestJson) => {
    const call = nextCall++;
    return new Promise((resolve, reject) => {
      bridge(requestJson).then(
        (response) => hold(call, () => resolve(response)),
        (error: unknown) => hold(call, () => reject(error)),
      );
    });
  };
}
