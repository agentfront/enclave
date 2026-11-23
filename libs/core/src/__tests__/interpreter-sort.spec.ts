import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';

const ROW_COUNT = 3000;
const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({ id: index, score: (index * 7919) % 1000 }));
const SORT_ROWS = `let calls = 0; const sorted = rows.toSorted((a, b) => { calls++; return a.score - b.score; }); return [calls, sorted.map((row) => row.id).join(',')];`;

/** The value of the sort and the CPU time it took, after a first run that warms the sandbox up. */
async function sortOn(enclave: Enclave): Promise<{ value: [number, string]; cpuMs: number }> {
  await enclave.run('return 1;');
  const before = process.cpuUsage();
  const result = await enclave.run(SORT_ROWS);
  const used = process.cpuUsage(before);
  expect(result.error).toBeUndefined();
  return { value: result.value as [number, string], cpuMs: (used.user + used.system) / 1000 };
}

describe('sort with a comparator on the interpreter', () => {
  it('sorts 3,000 rows in O(n log n) comparisons, in the order and within a CPU budget near the double VM', async () => {
    const options = { globals: { rows }, timeout: 60_000 };
    const doubleVm = new Enclave(options);
    const interpreted = new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() });
    try {
      const reference = await sortOn(doubleVm);
      const actual = await sortOn(interpreted);

      expect(actual.value[1]).toEqual(reference.value[1]);
      expect(actual.value[0]).toBeLessThanOrEqual(ROW_COUNT * Math.ceil(Math.log2(ROW_COUNT)));
      expect(actual.cpuMs).toBeLessThan(5 * reference.cpuMs + 250);
    } finally {
      doubleVm.dispose();
      interpreted.dispose();
    }
  });
});
