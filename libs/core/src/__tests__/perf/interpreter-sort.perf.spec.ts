/**
 * Interpreter Sort Performance
 *
 * A sort with a comparator on the interpreter, in CPU time against the double VM.
 */

import { InterpreterAdapter } from '../../adapters/interpreter-adapter';
import { Enclave } from '../../enclave';
import { recordMetric } from './utils/benchmark-reporter';

const ROW_COUNT = 3000;
const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({ id: index, score: (index * 7919) % 1000 }));
const SORT_ROWS = `return rows.toSorted((a, b) => a.score - b.score).length;`;

/** CPU time of one sort, after a first run that warms the sandbox up. */
async function sortCpuMs(enclave: Enclave): Promise<number> {
  await enclave.run('return 1;');
  const before = process.cpuUsage();
  const result = await enclave.run(SORT_ROWS);
  const used = process.cpuUsage(before);
  expect(result.value).toBe(ROW_COUNT);
  return (used.user + used.system) / 1000;
}

describe('Interpreter Sort Performance', () => {
  it('sorts 3,000 rows with a comparator within a CPU budget near the double VM', async () => {
    const options = { globals: { rows }, timeout: 60_000 };
    const doubleVm = new Enclave(options);
    const interpreted = new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() });
    try {
      const referenceMs = await sortCpuMs(doubleVm);
      const interpretedMs = await sortCpuMs(interpreted);
      console.log(
        `\nSort of ${ROW_COUNT} rows: double VM ${referenceMs.toFixed(1)} ms, interpreter ${interpretedMs.toFixed(1)} ms CPU`,
      );
      recordMetric('interpreter_sort', 'interpreter_sort_3000_rows_cpu', interpretedMs, 'ms', 5 * referenceMs + 250);

      expect(interpretedMs).toBeLessThan(5 * referenceMs + 250);
    } finally {
      doubleVm.dispose();
      interpreted.dispose();
    }
  });
});
