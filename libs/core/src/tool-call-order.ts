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

/** What a reply was: a result, a failure of the tool, or a refusal of the enclave */
export type ReplyOutcome = 'succeeded' | 'failed' | 'refused';

interface OrderLimits {
  /** The most the replies waiting behind an earlier call may hold together, in UTF-8 bytes */
  maxHeldBytes: number;
  /** What a reply is, read when it is refused room; nothing of it is kept */
  classify: (reply: BridgeReply) => ReplyOutcome;
  /** The short reply of a call refused room, built when it is delivered */
  refused: (outcome: ReplyOutcome) => string;
  /** The reply of a call whose bridge or whose finishing failed */
  failed: string;
}

interface Settled {
  reply?: BridgeReply;
  refused?: ReplyOutcome;
  heldBytes: number;
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
  const settled = new Map<number, Settled>();
  const charged: number[] = [];
  let heldBytes = 0;
  let cutoff = Number.POSITIVE_INFINITY;
  let nextCall = 0;
  let nextDelivery = 0;
  let delivering = false;
  let answering = false;
  let drainWhenAnswered = false;
  const sizeOf = (reply: BridgeReply): number => (typeof reply === 'string' ? utf8Length(reply) : reply.bytes);
  const responseOf = (entry: Settled): string => {
    try {
      if (entry.refused) return limits.refused(entry.refused);
      return typeof entry.reply === 'string' ? entry.reply : (entry.reply as Exclude<BridgeReply, string>).finish();
    } catch {
      return limits.failed;
    }
  };
  const answer = (call: number, entry: Settled): void => {
    const resolve = answers.get(call);
    answers.delete(call);
    answering = true;
    const response = responseOf(entry);
    answering = false;
    resolve?.(response);
    if (drainWhenAnswered) drain();
  };
  const drain = (): void => {
    drainWhenAnswered = false;
    const calls = [...settled.keys()].sort((left, right) => left - right);
    const entries = calls.map((call) => settled.get(call) as Settled);
    settled.clear();
    charged.length = 0;
    calls.forEach((call, index) => answer(call, entries[index]));
  };
  signal.addEventListener(
    'abort',
    () => {
      if (answering) drainWhenAnswered = true;
      else drain();
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
    cutoff = Number.POSITIVE_INFINITY;
    const head = settled.get(++nextDelivery);
    if (head && head.heldBytes > 0) {
      heldBytes -= head.heldBytes;
      head.heldBytes = 0;
      charged.shift();
    }
    answer(nextDelivery - 1, entry);
    nextTurn(deliverNext);
  };
  const refuse = (call: number, reply: BridgeReply): void => {
    cutoff = Math.min(cutoff, call);
    settled.set(call, { refused: limits.classify(reply), heldBytes: 0 });
  };
  const hold = (call: number, reply: BridgeReply): void => {
    if (signal.aborted) return answer(call, { reply, heldBytes: 0 });
    if (call > cutoff) refuse(call, reply);
    else if (call === nextDelivery) settled.set(call, { reply, heldBytes: 0 });
    else {
      const bytes = sizeOf(reply);
      settled.set(call, { reply, heldBytes: bytes });
      charged.splice(insertionIndex(charged, call), 0, call);
      heldBytes += bytes;
      while (heldBytes > limits.maxHeldBytes) {
        const latest = charged.pop() as number;
        const entry = settled.get(latest) as Settled;
        heldBytes -= entry.heldBytes;
        refuse(latest, entry.reply as BridgeReply);
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
