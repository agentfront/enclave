import { utf8Length } from './bounded-json';
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
  /** The most the replies waiting behind an earlier call may hold together, in UTF-8 bytes */
  maxHeldBytes: number;
  /** The short reply that takes the place of a refused one, holding nothing of it */
  refusal: (reply: BridgeReply) => string;
  /** The reply of a call whose bridge or whose finishing failed */
  failed: string;
}

function insertionIndex(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The tool bridge with its replies delivered in call order, one per turn of the event loop. What
 * waits is the bridge's reply, bounded and sanitized. When the replies waiting behind a blocked
 * call would hold more than their budget, the latest positions are refused, and every position
 * after a refused one is refused while that call stays blocked. Once the run is aborted nothing waits.
 */
export function inCallOrder(
  bridge: (requestJson: string) => Promise<BridgeReply>,
  signal: AbortSignal,
  limits: OrderLimits,
): (requestJson: string) => Promise<string> {
  const answers = new Map<number, (response: string) => void>();
  const settled = new Map<number, { reply: BridgeReply; heldBytes: number }>();
  const charged: number[] = [];
  let heldBytes = 0;
  let cutoff = Number.POSITIVE_INFINITY;
  let nextCall = 0;
  let nextDelivery = 0;
  let delivering = false;
  const sizeOf = (reply: BridgeReply): number => (typeof reply === 'string' ? utf8Length(reply) : reply.bytes);
  const answer = (call: number, reply: BridgeReply): void => {
    let response: string;
    try {
      response = typeof reply === 'string' ? reply : reply.finish();
    } catch {
      response = limits.failed;
    }
    answers.get(call)?.(response);
    answers.delete(call);
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const call of [...settled.keys()].sort((left, right) => left - right)) {
        answer(call, (settled.get(call) as { reply: BridgeReply }).reply);
      }
      settled.clear();
      charged.length = 0;
    },
    { once: true },
  );
  const deliverNext = (): void => {
    const entry = settled.get(nextDelivery);
    if (!entry || !answers.has(nextDelivery)) {
      delivering = false;
      return;
    }
    settled.delete(nextDelivery);
    if (entry.heldBytes > 0) {
      heldBytes -= entry.heldBytes;
      charged.shift();
    }
    cutoff = Number.POSITIVE_INFINITY;
    answer(nextDelivery++, entry.reply);
    nextTurn(deliverNext);
  };
  const refuse = (call: number, reply: BridgeReply): void => {
    cutoff = Math.min(cutoff, call);
    settled.set(call, { reply: limits.refusal(reply), heldBytes: 0 });
  };
  const hold = (call: number, reply: BridgeReply): void => {
    if (signal.aborted) return answer(call, reply);
    if (call > cutoff) refuse(call, reply);
    else if (call === nextDelivery) settled.set(call, { reply, heldBytes: 0 });
    else {
      const bytes = sizeOf(reply);
      settled.set(call, { reply, heldBytes: bytes });
      charged.splice(insertionIndex(charged, call), 0, call);
      heldBytes += bytes;
      while (heldBytes > limits.maxHeldBytes) {
        const latest = charged.pop() as number;
        const entry = settled.get(latest) as { reply: BridgeReply; heldBytes: number };
        heldBytes -= entry.heldBytes;
        refuse(latest, entry.reply);
      }
    }
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
