import { MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH } from '@enclave-vm/ast';

/** A tool call of an earlier run of the same script that the host answers from its record of that run */
export interface ReplayedCall {
  callIndex: number;
  toolName: string;
  /** When the call reached the host, in milliseconds from the start of the earlier run */
  elapsedMs: number;
}

/** The `run()` features of this build, for a host to detect at run time */
export const ENCLAVE_RUN_FEATURES: readonly string[] = Object.freeze(['replayed-calls']);

export interface ReplayedCallOptions {
  /** The replayed calls, in call order: exempt from the rate limit and the sequence detectors, kept in their history at their original times */
  replayedCalls?: readonly ReplayedCall[];
}

export function copyReplayedCalls(value: unknown, maxToolCalls: number): readonly ReplayedCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxToolCalls) {
    throw new TypeError(`replayedCalls must be a list of at most maxToolCalls (${maxToolCalls}) calls`);
  }
  const copies: ReplayedCall[] = [];
  for (let position = 0; position < value.length; position++) {
    const listed: unknown = value[position];
    const { callIndex, toolName, elapsedMs } = (typeof listed === 'object' && listed !== null ? listed : {}) as Record<
      string,
      unknown
    >;
    const previous = copies[position - 1];
    if (
      typeof callIndex !== 'number' ||
      !Number.isSafeInteger(callIndex) ||
      callIndex < (previous ? previous.callIndex + 1 : 0) ||
      typeof toolName !== 'string' ||
      toolName.length === 0 ||
      toolName.length > MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH ||
      typeof elapsedMs !== 'number' ||
      !(elapsedMs >= (previous ? previous.elapsedMs : 0) && elapsedMs <= Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError(
        `replayedCalls[${position}] must have an integer callIndex above the previous one (from 0), ` +
          `a toolName of 1 to ${MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH} characters, ` +
          `and a finite elapsedMs not below the previous one (from 0)`,
      );
    }
    copies.push(Object.freeze({ callIndex, toolName, elapsedMs }));
  }
  return Object.freeze(copies);
}

export class ReplayedCallCursor {
  private nextListedCall = 0;
  private passedCalls = 0;

  constructor(private readonly listedCalls: readonly ReplayedCall[] = []) {}

  get replaying(): boolean {
    return this.nextListedCall < this.listedCalls.length;
  }

  match(toolName: string): ReplayedCall | undefined {
    const listed = this.listedCalls[this.nextListedCall];
    if (listed && listed.callIndex === this.passedCalls && listed.toolName === toolName) return listed;
    this.nextListedCall = this.listedCalls.length;
    return undefined;
  }

  pass(replayed: ReplayedCall | undefined): void {
    if (replayed) this.nextListedCall++;
    this.passedCalls++;
  }
}
