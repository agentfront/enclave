/**
 * How `timeout` treats tool calls. `@enclave-vm/browser` follows the same rules, so a script with
 * slow tools behaves the same on both runtimes:
 * - a tool call in progress when the timeout passes is not cut off; its result is delivered;
 * - once the timeout has passed, the script's next tool call fails with "Execution aborted".
 */

import { Enclave } from '../enclave';

const slowTool = (ms: number) => () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms));

describe('timeout and tool calls', () => {
  let enclave: Enclave;

  beforeEach(() => {
    enclave = new Enclave({ timeout: 300, toolHandler: slowTool(600) });
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
});
