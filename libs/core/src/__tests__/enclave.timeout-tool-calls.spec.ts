/**
 * How `timeout` treats tool calls. `@enclave-vm/browser` follows the same rules, so a script with
 * slow tools behaves the same on both runtimes:
 * - a tool call in progress when the timeout passes is not cut off; its result is delivered;
 * - once the timeout has passed, the script's next tool call fails with "Execution aborted";
 * - the wait for a call in progress has an end: `toolCallGraceMs` after the timeout (by default as
 *   long again as the timeout) the execution ends with the timeout error, and the error says how
 *   many host calls were left running. `Infinity` waits for the handler however long it takes.
 */

import { Enclave } from '../enclave';

const slowTool = (ms: number) => () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms));

describe('timeout and tool calls', () => {
  let enclave: Enclave;

  beforeEach(() => {
    // The tool outlasts the timeout (400 ms) and is done within the grace (until 800 ms)
    enclave = new Enclave({ timeout: 400, toolHandler: slowTool(600) });
  });

  afterEach(() => {
    enclave.dispose();
  });

  it('delivers the result of a tool call that outlasts the timeout', async () => {
    const result = await enclave.run("return await callTool('slow', {});");

    expect(result.error).toBeUndefined();
    expect(result.value).toBe('done');
  });

  it('refuses the next tool call once the timeout has passed', async () => {
    const result = await enclave.run("const first = await callTool('slow', {}); return await callTool('slow', {});");

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Execution aborted');
  });

  it('ends the execution when a tool call is still in progress after the grace', async () => {
    const hanging = new Enclave({ timeout: 200, toolHandler: slowTool(60_000) });
    try {
      const started = Date.now();
      const result = await hanging.run("return await callTool('slow', {});");
      const elapsed = Date.now() - started;

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Script execution timed out after 200ms');
      expect(result.error?.data).toEqual({ pendingHostCalls: 1 });
      // As long again as the timeout, by default
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      hanging.dispose();
    }
  });

  it('waits for the handler however long it takes with toolCallGraceMs: Infinity', async () => {
    const patient = new Enclave({ timeout: 100, toolCallGraceMs: Infinity, toolHandler: slowTool(700) });
    try {
      const result = await patient.run("return await callTool('slow', {});");

      expect(result.error).toBeUndefined();
      expect(result.value).toBe('done');
    } finally {
      patient.dispose();
    }
  });
});
