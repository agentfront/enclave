import { fork } from 'node:child_process';
import { join } from 'node:path';

interface ResearcherVerdict {
  pollutedCheck: boolean;
  pollutedRegex: boolean;
  pollutedBullseye: boolean;
}

interface CorrectedVerdict {
  pollutedRecord: boolean;
  pollutedPath: boolean;
}

// Each vector runs in a disposable child that exits, so any singleton scribble cannot leak.
function runInThrowawayChild<TVerdict>(mode: 'researcher' | 'corrected'): Promise<TVerdict> {
  return new Promise<TVerdict>((resolve, reject) => {
    const worker = fork(join(__dirname, 'pp-worker.cjs'), [mode], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    worker.once('message', (verdict) => resolve(verdict as TVerdict));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`pp-worker exited with code ${code}`));
    });
  });
}

describe('CWE-1321 prototype-pollution advisory regression (@enclave-vm/types)', () => {
  it('Researcher PoC payload does not pollute Object.prototype', async () => {
    const verdict = await runInThrowawayChild<ResearcherVerdict>('researcher');
    expect(verdict.pollutedCheck).toBe(false);
    expect(verdict.pollutedRegex).toBe(false);
    expect(verdict.pollutedBullseye).toBe(false);
  });

  it('Corrected hypothesis (genuine __proto__ via supported API) does not pollute', async () => {
    const verdict = await runInThrowawayChild<CorrectedVerdict>('corrected');
    expect(verdict.pollutedRecord).toBe(false);
    expect(verdict.pollutedPath).toBe(false);
  });
});
