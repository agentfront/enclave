import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { gzipSync } from 'node:zlib';
import { compile, drive, Machine, restore, save, type Snapshot } from '../../src/interpreter/resumable';
import { makeEnclave, MAX_STEPS, runCurrentInterpreter, runEnclave, runPrototype } from './engines';
import { AGGREGATE, APPROVAL, CALLBACKS, SORT, WORKLOADS, toolHandler } from './workloads';

const WARMUP = 3;
const RUNS = 7;
const ENGINES = ['double-vm', 'interpreter-enclave', 'interpreter-bare', 'prototype', 'prototype-run'] as const;
type Engine = (typeof ENGINES)[number];

type Runner = () => Promise<unknown>;

function runners(workload: string): Array<[Engine, Runner, () => void]> {
  const w = WORKLOADS.find((x) => x.name === workload)!;
  const handler = async (n: string, a: unknown): Promise<unknown> => toolHandler(n, a);
  const vm = makeEnclave('double-vm', handler);
  const interp = makeEnclave('interpreter', handler);
  const program = compile(w.source);
  const none = (): void => undefined;
  return [
    ['double-vm', () => runEnclave(vm, w.source), () => vm.dispose()],
    ['interpreter-enclave', () => runEnclave(interp, w.source), () => interp.dispose()],
    ['interpreter-bare', () => runCurrentInterpreter(w.source, toolHandler), none],
    ['prototype', () => runPrototype(compile(w.source), toolHandler), none],
    ['prototype-run', () => runPrototype(program, toolHandler), none],
  ];
}

interface Timing {
  cpu: number;
  wall: number;
}

const middle = (t: number[]): number => [...t].sort((a, b) => a - b)[Math.floor(t.length / 2)];

/** Engines take turns each round, so a change in machine load reaches all of them alike. */
async function measure(workload: string, warmup: number, runs: number): Promise<Record<string, Timing>> {
  const list = runners(workload);
  const cpu = new Map<string, number[]>(list.map(([e]) => [e, []]));
  const wall = new Map<string, number[]>(list.map(([e]) => [e, []]));
  for (let round = 0; round < warmup + runs; round++) {
    for (const [engine, run] of list) {
      const startCpu = process.cpuUsage();
      const start = performance.now();
      await run();
      const elapsed = performance.now() - start;
      const used = process.cpuUsage(startCpu);
      if (round < warmup) continue;
      wall.get(engine)!.push(elapsed);
      cpu.get(engine)!.push((used.user + used.system) / 1000);
    }
  }
  for (const [, , dispose] of list) dispose();
  const out: Record<string, Timing> = {};
  for (const [engine] of list) out[engine] = { cpu: middle(cpu.get(engine)!), wall: middle(wall.get(engine)!) };
  return out;
}

const ms = (n: number): string => (n >= 100 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);

async function stateSizes(): Promise<void> {
  console.log('\nSaved state');
  for (const [label, w, at] of [
    ['aggregate-3000, mid-loop (statement 6,000 of 23,904, row 759)', AGGREGATE, 6000],
    ['callbacks-3000, inside map (statement 4,000)', CALLBACKS, 4000],
  ] as const) {
    let count = 0;
    const machine = Machine.start(compile(w.source), { maxSteps: MAX_STEPS, pauseAt: () => ++count === at });
    const out = await drive(machine, toolHandler);
    if (out.kind !== 'paused') throw new Error(`not paused: ${out.kind}`);
    const t0 = performance.now();
    const text = JSON.stringify(save(machine));
    const t1 = performance.now();
    const back = restore(compile(w.source), JSON.parse(text) as Snapshot, { maxSteps: MAX_STEPS });
    const t2 = performance.now();
    const rest = await drive(back, toolHandler);
    if (rest.kind !== 'done') throw new Error('resume did not finish');
    const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
    console.log(
      `- ${label}: ${kb(text.length)} JSON, ${kb(gzipSync(text).length)} gzipped; save ${ms(t1 - t0)}, restore ${ms(t2 - t1)}`,
    );
  }
  const approval = Machine.start(compile(APPROVAL.source), { maxSteps: MAX_STEPS });
  const held = await drive(approval, toolHandler, { hold: (c) => (c.args as { id: number }).id === 3 });
  if (held.kind !== 'held') throw new Error('expected a held call');
  const text = JSON.stringify(save(approval));
  console.log(`- parallel-approval, 4 of 5 calls done, call 3 held: ${text.length} bytes JSON`);
}

async function main(): Promise<void> {
  const [mode, workload, warmup, runs] = process.argv.slice(2);
  if (mode === 'one') {
    process.stdout.write(JSON.stringify(await measure(workload, Number(warmup), Number(runs))));
    return;
  }
  console.log(
    `node ${process.version}, ${process.platform}/${process.arch}, load average ${loadavg()[0].toFixed(0)} on ${cpus().length} cores`,
  );
  console.log(
    `one process per workload, engines take turns; median CPU time (median wall time) of ${RUNS} after ${WARMUP} warm-up rounds\n`,
  );
  console.log(`| workload | ${ENGINES.join(' | ')} |`);
  console.log(`|---|${ENGINES.map(() => '---').join('|')}|`);
  for (const w of WORKLOADS) {
    const [warmup, runs] = w === SORT ? [1, 3] : [WARMUP, RUNS];
    const args = [__filename, 'one', w.name, String(warmup), String(runs)];
    const r = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })) as Record<string, Timing>;
    const label = w === SORT ? `${w.name} (${runs} runs)` : w.name;
    console.log(`| ${label} | ${ENGINES.map((e) => `${ms(r[e].cpu)} (${ms(r[e].wall)})`).join(' | ')} |`);
  }
  await stateSizes();
}

void main();
