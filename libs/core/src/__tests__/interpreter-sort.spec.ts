import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';

const ROW_COUNT = 3000;
const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({ id: index, score: (index * 7919) % 1000 }));
const SORT_ROWS = `let calls = 0; const sorted = rows.toSorted((a, b) => { calls++; return a.score - b.score; }); return [calls, sorted.map((row) => row.id).join(',')];`;

describe('sort with a comparator on the interpreter', () => {
  it('sorts 3,000 rows in O(n log n) comparisons, in the order of the double VM', async () => {
    const options = { globals: { rows }, timeout: 60_000 };
    const doubleVm = new Enclave(options);
    const interpreted = new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() });
    try {
      const reference = await doubleVm.run(SORT_ROWS);
      const actual = await interpreted.run(SORT_ROWS);
      const [calls, order] = actual.value as [number, string];

      expect(actual.error).toBeUndefined();
      expect(order).toBe((reference.value as [number, string])[1]);
      expect(calls).toBeLessThanOrEqual(ROW_COUNT * Math.ceil(Math.log2(ROW_COUNT)));
    } finally {
      doubleVm.dispose();
      interpreted.dispose();
    }
  });
});
