import { test, expect } from '@playwright/test';
import { loadHarness } from './helpers';

test.describe('protocol', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('isEnclaveMessage identifies valid messages', async ({ page }) => {
    const result = await page.evaluate(() => {
      const EB = (window as any).EnclaveBrowser;
      return [
        EB.isEnclaveMessage({ __enclave_msg__: true, type: 'ready' }),
        EB.isEnclaveMessage({ __enclave_msg__: true, type: 'tool-call', requestId: '1' }),
      ];
    });
    expect(result).toEqual([true, true]);
  });

  test('isEnclaveMessage rejects non-enclave data', async ({ page }) => {
    const result = await page.evaluate(() => {
      const EB = (window as any).EnclaveBrowser;
      return [
        EB.isEnclaveMessage(null),
        EB.isEnclaveMessage(undefined),
        EB.isEnclaveMessage(42),
        EB.isEnclaveMessage('string'),
        EB.isEnclaveMessage({}),
        EB.isEnclaveMessage({ __enclave_msg__: false, type: 'ready' }),
        EB.isEnclaveMessage({ type: 'ready' }),
      ];
    });
    expect(result).toEqual([false, false, false, false, false, false, false]);
  });

  test('type guards work correctly', async ({ page }) => {
    const result = await page.evaluate(() => {
      const EB = (window as any).EnclaveBrowser;
      return {
        toolCall: EB.isToolCallMessage({ type: 'tool-call' }),
        toolCallNeg: EB.isToolCallMessage({ type: 'result' }),
        result: EB.isResultMessage({ type: 'result' }),
        resultNeg: EB.isResultMessage({ type: 'tool-call' }),
        console: EB.isConsoleMessage({ type: 'console' }),
        consoleNeg: EB.isConsoleMessage({ type: 'result' }),
        ready: EB.isReadyMessage({ type: 'ready' }),
        readyNeg: EB.isReadyMessage({ type: 'result' }),
      };
    });
    expect(result.toolCall).toBe(true);
    expect(result.toolCallNeg).toBe(false);
    expect(result.result).toBe(true);
    expect(result.resultNeg).toBe(false);
    expect(result.console).toBe(true);
    expect(result.consoleNeg).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.readyNeg).toBe(false);
  });

  test('generateId produces unique strings', async ({ page }) => {
    const result = await page.evaluate(() => {
      const EB = (window as any).EnclaveBrowser;
      const id1 = EB.generateId();
      const id2 = EB.generateId();
      return {
        id1Type: typeof id1,
        id2Type: typeof id2,
        id1Len: id1.length > 0,
        different: id1 !== id2,
      };
    });
    expect(result.id1Type).toBe('string');
    expect(result.id2Type).toBe('string');
    expect(result.id1Len).toBe(true);
    expect(result.different).toBe(true);
  });

  test('Zod schema validates tool-call message', async ({ page }) => {
    // The Zod schemas are internal but we can test via the bundle
    const result = await page.evaluate(() => {
      const EB = (window as any).EnclaveBrowser;
      // Check that the type guard works for a well-formed message
      const msg = {
        __enclave_msg__: true,
        type: 'tool-call',
        requestId: 'req-123',
        callId: 'call-456',
        toolName: 'users:list',
        args: { limit: 10 },
      };
      return EB.isEnclaveMessage(msg) && EB.isToolCallMessage(msg);
    });
    expect(result).toBe(true);
  });
});
