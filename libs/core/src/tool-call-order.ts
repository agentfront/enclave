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

/** A bridge reply, or one whose sidecar write waits for its turn */
export type BridgeReply = string | { bytes: number; finish: () => string };

interface OrderLimits {
  /** The most the replies waiting behind an earlier call may hold together, in bytes */
  maxHeldBytes: number;
  /** The reply of a call whose own reply would take the waiting ones over `maxHeldBytes` */
  overflow: string;
  /** The reply of a call whose bridge failed */
  failed: string;
}

/**
 * The tool bridge with its replies delivered in call order, one per turn of the event loop. What
 * waits is the bridge's reply, bounded and sanitized; once the run is aborted nothing waits.
 */
export function inCallOrder(
  bridge: (requestJson: string) => Promise<BridgeReply>,
  signal: AbortSignal,
  limits: OrderLimits,
): (requestJson: string) => Promise<string> {
  const answers = new Map<number, (response: string) => void>();
  const settled = new Map<number, { reply: BridgeReply; heldBytes: number }>();
  let heldBytes = 0;
  let nextCall = 0;
  let nextDelivery = 0;
  let delivering = false;
  const sizeOf = (reply: BridgeReply): number => (typeof reply === 'string' ? reply.length : reply.bytes);
  const answerNow = (call: number, reply: BridgeReply): void => {
    answers.get(call)?.(typeof reply === 'string' ? reply : reply.finish());
    answers.delete(call);
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const call of [...settled.keys()].sort((left, right) => left - right)) {
        answerNow(call, (settled.get(call) as { reply: BridgeReply }).reply);
      }
      settled.clear();
    },
    { once: true },
  );
  const deliverNext = (): void => {
    const entry = settled.get(nextDelivery);
    const answer = answers.get(nextDelivery);
    if (!entry || !answer) {
      delivering = false;
      return;
    }
    settled.delete(nextDelivery);
    answers.delete(nextDelivery);
    nextDelivery++;
    heldBytes -= entry.heldBytes;
    answer(typeof entry.reply === 'string' ? entry.reply : entry.reply.finish());
    nextTurn(deliverNext);
  };
  const hold = (call: number, reply: BridgeReply): void => {
    if (signal.aborted) return answerNow(call, reply);
    const waits = call !== nextDelivery;
    const kept = waits && heldBytes + sizeOf(reply) > limits.maxHeldBytes ? limits.overflow : reply;
    const keptBytes = waits ? sizeOf(kept) : 0;
    heldBytes += keptBytes;
    settled.set(call, { reply: kept, heldBytes: keptBytes });
    if (!delivering) {
      delivering = true;
      nextTurn(deliverNext);
    }
  };
  return (requestJson) => {
    const call = nextCall++;
    return new Promise<string>((resolve) => {
      answers.set(call, resolve);
      bridge(requestJson).then(
        (reply) => hold(call, reply),
        () => hold(call, limits.failed),
      );
    });
  };
}
