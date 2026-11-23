import * as acorn from 'acorn';
import type * as ESTree from 'estree';
import { Enclave } from '../../src/enclave';
import { InterpreterAdapter } from '../../src/adapters/interpreter-adapter';
import { Interpreter } from '../../src/interpreter/interpreter';
import { createSafeGlobals } from '../../src/interpreter/safe-globals';
import {
  compile,
  drive,
  Machine,
  restore,
  save,
  type CompiledProgram,
  type Snapshot,
} from '../../src/interpreter/resumable';
import type { ToolHandler } from '../../src/types';

export const MAX_STEPS = 50_000_000;

const asData = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export async function runPrototype(
  program: CompiledProgram,
  handler: (n: string, a: unknown) => Promise<unknown>,
): Promise<unknown> {
  const machine = Machine.start(program, { maxSteps: MAX_STEPS });
  const out = await drive(machine, handler);
  if (out.kind !== 'done') throw new Error(`Prototype stopped: ${out.kind}`);
  return out.value;
}

export async function runPrototypeWithSaves(
  source: string,
  handler: (n: string, a: unknown) => Promise<unknown>,
  every: (count: number) => boolean,
): Promise<{ value: unknown; saves: number; largest: number }> {
  let count = 0;
  const pauseAt = (): boolean => every(++count);
  let machine = Machine.start(compile(source), { maxSteps: MAX_STEPS, pauseAt });
  let saves = 0;
  let largest = 0;
  for (;;) {
    const out = await drive(machine, handler);
    if (out.kind === 'done') return { value: out.value, saves, largest };
    if (out.kind !== 'paused') throw new Error(`Unexpected ${out.kind}`);
    const text = JSON.stringify(save(machine));
    largest = Math.max(largest, text.length);
    saves++;
    machine = restore(compile(source), JSON.parse(text) as Snapshot, { maxSteps: MAX_STEPS, pauseAt });
  }
}

export async function runCurrentInterpreter(
  source: string,
  handler: (n: string, a: unknown) => Promise<unknown>,
): Promise<unknown> {
  const box: { interpreter?: Interpreter } = {};
  const safe = createSafeGlobals({
    charge: () => undefined,
    call: (fn, args) => box.interpreter!.callCallback(fn, args),
  });
  const globals: Record<string, unknown> = {
    ...safe.globals,
    callTool: async (name: string, args: unknown) => asData(await handler(name, args)),
    parallel: async (items: unknown[], fn: unknown) =>
      Promise.all(items.map((item, i) => box.interpreter!.call(fn, [item, i]))),
  };
  const interpreter = new Interpreter({
    globals,
    constructors: safe.constructors,
    instanceChecks: safe.instanceChecks,
    maxSteps: MAX_STEPS,
    maxCallDepth: 200,
  });
  box.interpreter = interpreter;
  const program = acorn.parse(`async function __ag_main() {\n${source}\n}`, {
    ecmaVersion: 'latest',
    sourceType: 'script',
  }) as unknown as ESTree.Program;
  return interpreter.run(program);
}

export function makeEnclave(kind: 'double-vm' | 'interpreter', handler: ToolHandler): Enclave {
  return new Enclave({
    securityLevel: 'PERMISSIVE',
    toolHandler: handler,
    timeout: 600_000,
    maxIterations: 1_000_000,
    maxToolCalls: 1000,
    maxSanitizeProperties: 100_000,
    memoryLimit: 512 * 1024 * 1024,
    doubleVm: { parentValidation: { blockSuspiciousSequences: false, maxOperationsPerSecond: 100_000 } },
    ...(kind === 'interpreter' ? { sandboxAdapter: new InterpreterAdapter({ maxSteps: MAX_STEPS }) } : {}),
  });
}

export async function runEnclave(enclave: Enclave, source: string): Promise<unknown> {
  const result = await enclave.run(source);
  if (!result.success) throw new Error(`Enclave failed: ${JSON.stringify(result.error)}`);
  return result.value;
}
