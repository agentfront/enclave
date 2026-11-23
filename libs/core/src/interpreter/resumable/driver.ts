import type { Machine, ToolRequest } from './machine';

export type ToolHandler = (name: string, args: unknown) => Promise<unknown>;

export type DriveResult =
  | { kind: 'done'; value: unknown }
  | { kind: 'paused' }
  | { kind: 'held'; calls: ToolRequest[] };

export interface DriveOptions {
  /** true leaves a call pending (for an approval): the run stops once nothing else can go on. */
  hold?: (call: ToolRequest) => boolean;
}

/** Tool results enter the machine as JSON data, so every value a script holds can be saved. */
function asData(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export async function drive(machine: Machine, handler: ToolHandler, options: DriveOptions = {}): Promise<DriveResult> {
  const held = new Set<number>();
  for (;;) {
    const outcome = machine.run();
    if (outcome.kind !== 'waiting') return outcome;
    const ready: ToolRequest[] = [];
    for (const call of outcome.calls) {
      if (held.has(call.callId)) continue;
      if (options.hold?.(call)) held.add(call.callId);
      else ready.push(call);
    }
    if (ready.length === 0) return { kind: 'held', calls: outcome.calls };
    const settled = await Promise.allSettled(ready.map((c) => handler(c.name, c.args)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') machine.resolve(ready[i].callId, true, asData(r.value));
      else machine.resolve(ready[i].callId, false, r.reason);
    });
  }
}
