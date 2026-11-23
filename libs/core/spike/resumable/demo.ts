import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compile, drive, Machine, restore, save, type Snapshot } from '../../src/interpreter/resumable';
import { MAX_STEPS, runCurrentInterpreter } from './engines';
import { AGGREGATE, APPROVAL, FANOUT, calls, toolHandler, type Workload } from './workloads';

const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

interface Scenario {
  workload: Workload;
  pauseAt?: (fiber: number, count: number) => boolean;
  hold?: number;
}

let inTask = 0;

const SCENARIOS: Record<string, Scenario> = {
  loop: { workload: AGGREGATE, pauseAt: (_fiber, n) => n === 6000 },
  parallel: { workload: FANOUT, pauseAt: (fiber) => fiber === 23 && ++inTask === 7 },
  approval: { workload: APPROVAL, hold: 3 },
};

async function saveRun(name: string, file: string): Promise<void> {
  const scenario = SCENARIOS[name];
  const program = compile(scenario.workload.source);
  let count = 0;
  let where = '';
  const machine = Machine.start(program, {
    maxSteps: MAX_STEPS,
    pauseAt: (stmt, fiber) => {
      if (!scenario.pauseAt?.(fiber, ++count)) return false;
      const info = program.statements[stmt];
      where = `before the ${info.type} at line ${info.line}, in fiber ${fiber}, statement #${count}`;
      return true;
    },
  });
  const out = await drive(machine, toolHandler, {
    hold: (c) => scenario.hold !== undefined && (c.args as { id?: number }).id === scenario.hold,
  });
  if (out.kind === 'done') throw new Error('The run finished before it paused');
  if (out.kind === 'held') {
    where = `waiting for approval of ${out.calls.map((c) => `${c.name}#${String((c.args as { id: number }).id)}`).join(', ')}`;
  }
  const made = [...calls];
  const text = JSON.stringify(save(machine));
  writeFileSync(file, text);
  const reference = await runCurrentInterpreter(scenario.workload.source, toolHandler);
  const p = `[pid ${process.pid}]`;
  console.log(`${p} ${name}: paused ${where}; ${machine.fibers.size} fiber(s) live`);
  console.log(`${p} tool calls before the pause: ${summarize(made)}`);
  console.log(`${p} saved ${text.length} bytes to ${file}`);
  console.log(`${p} uninterrupted result (current interpreter): ${digest(reference)}`);
}

function summarize(list: string[]): string {
  if (list.length <= 8) return list.join(', ') || 'none';
  return `${list.length} (${list.slice(0, 3).join(', ')}, ... ${list.slice(-2).join(', ')})`;
}

async function resumeRun(name: string, file: string): Promise<void> {
  const scenario = SCENARIOS[name];
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  const machine = restore(compile(scenario.workload.source), snapshot, { maxSteps: MAX_STEPS });
  const out = await drive(machine, toolHandler);
  if (out.kind !== 'done') throw new Error(`Resume stopped: ${out.kind}`);
  const p = `[pid ${process.pid}]`;
  console.log(`${p} ${name}: restored from ${file}`);
  console.log(`${p} tool calls after the resume: ${summarize(calls)}`);
  console.log(`${p} resumed result: ${digest(out.value)}  ${JSON.stringify(out.value).slice(0, 100)}`);
}

const [mode, name, file] = process.argv.slice(2);
void (mode === 'save' ? saveRun(name, file) : resumeRun(name, file));
