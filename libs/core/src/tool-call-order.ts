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
  /** The reply of a call that was refused room to wait */
  overflow: string;
  /** The reply of a call whose bridge or whose finishing failed */
  failed: string;
  /** Told of each reply that is refused room to wait */
  onRefused: (reply: BridgeReply) => void;
}

interface Waiting {
  reply: BridgeReply;
  heldBytes: number;
  refused: boolean;
}

/**
 * The tool bridge with its replies delivered in call order, one per turn of the event loop. What
 * waits is the bridge's reply, bounded and sanitized; when the waiting replies would hold more than
 * their budget, the latest positions are refused. Once the run is aborted nothing waits.
 */
export function inCallOrder(
  bridge: (requestJson: string) => Promise<BridgeReply>,
  signal: AbortSignal,
  limits: OrderLimits,
): (requestJson: string) => Promise<string> {
  const answers = new Map<number, (response: string) => void>();
  const settled = new Map<number, Waiting>();
  let heldBytes = 0;
  let nextCall = 0;
  let nextDelivery = 0;
  let delivering = false;
  const sizeOf = (reply: BridgeReply): number => (typeof reply === 'string' ? utf8Length(reply) : reply.bytes);
  const responseOf = (entry: Waiting): string => {
    if (entry.refused) return limits.overflow;
    try {
      return typeof entry.reply === 'string' ? entry.reply : entry.reply.finish();
    } catch {
      return limits.failed;
    }
  };
  const answer = (call: number, entry: Waiting): void => {
    answers.get(call)?.(responseOf(entry));
    answers.delete(call);
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const call of [...settled.keys()].sort((left, right) => left - right)) {
        answer(call, settled.get(call) as Waiting);
      }
      settled.clear();
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
    heldBytes -= entry.heldBytes;
    answer(nextDelivery++, entry);
    nextTurn(deliverNext);
  };
  const refuseLatest = (): void => {
    const latest = Math.max(...[...settled.keys()].filter((call) => (settled.get(call) as Waiting).heldBytes > 0));
    const entry = settled.get(latest) as Waiting;
    heldBytes -= entry.heldBytes;
    limits.onRefused(entry.reply);
    settled.set(latest, { reply: entry.reply, heldBytes: 0, refused: true });
  };
  const hold = (call: number, reply: BridgeReply): void => {
    const waits = call !== nextDelivery && !signal.aborted;
    const entry = { reply, heldBytes: waits ? sizeOf(reply) : 0, refused: false };
    if (signal.aborted) return answer(call, entry);
    settled.set(call, entry);
    heldBytes += entry.heldBytes;
    while (heldBytes > limits.maxHeldBytes) refuseLatest();
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
