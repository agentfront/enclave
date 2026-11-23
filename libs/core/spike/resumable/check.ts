import { compile } from '../../src/interpreter/resumable';
import { makeEnclave, runCurrentInterpreter, runEnclave, runPrototype, runPrototypeWithSaves } from './engines';
import { APPROVAL, COLLECTIONS, WORKLOADS, toolHandler } from './workloads';

const isDeepStrictEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  let failed = false;
  const vm = makeEnclave('double-vm', async (name, args) => toolHandler(name, args));
  for (const w of [...WORKLOADS, APPROVAL, COLLECTIONS]) {
    const reference = await runCurrentInterpreter(w.source, toolHandler);
    const proto = await runPrototype(compile(w.source), toolHandler);
    const viaVm = await runEnclave(vm, w.source);
    const same = isDeepStrictEqual(reference, proto) && isDeepStrictEqual(reference, viaVm);
    console.log(`${w.name}: prototype ${same ? 'matches' : 'DIFFERS FROM'} the interpreter and the double VM`);
    if (!same) {
      failed = true;
      console.log(JSON.stringify({ reference, proto, viaVm }).slice(0, 2000));
    }
    const intervals =
      w.name === 'closures-and-collections' ? [7] : w.name.startsWith('parallel') ? [1, 3, 17] : [997, 3001];
    for (const k of intervals) {
      const run = await runPrototypeWithSaves(w.source, toolHandler, (n) => n % k === 0);
      const ok = isDeepStrictEqual(reference, run.value);
      if (!ok) failed = true;
      console.log(
        `  save + restore every ${k} statements: ${run.saves} saves, largest ${run.largest} bytes, result ${ok ? 'same' : 'DIFFERENT'}`,
      );
    }
    let seed = 7;
    const random = await runPrototypeWithSaves(w.source, toolHandler, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 211 === 0;
    });
    const ok = isDeepStrictEqual(reference, random.value);
    if (!ok) failed = true;
    console.log(`  save + restore at random statements: ${random.saves} saves, result ${ok ? 'same' : 'DIFFERENT'}`);
  }
  vm.dispose();
  if (failed) process.exitCode = 1;
}

void main();
