# @enclave-vm/browser

A sandbox for running AgentScript in the browser: it validates a script with [`@enclave-vm/ast`](https://www.npmjs.com/package/@enclave-vm/ast) and runs it in two nested sandboxed iframes, with tool calls answered by your page. For applications that execute model-generated code on the client.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/browser.svg)](https://www.npmjs.com/package/@enclave-vm/browser)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

It is the browser runtime of [Enclave](https://github.com/agentfront/enclave), with the same `callTool()` API, security levels and AgentScript preset as [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core), which runs scripts in Node.js.

## How It Works

Each `run()` creates two iframes:

- **Outer iframe**: a barrier between your page and the script. It relays messages, rate-limits tool calls, checks tool names against your patterns and looks for suspicious sequences of calls.
- **Inner iframe**: runs the script, after removing dangerous globals, freezing the built-in prototypes, wrapping values in secure proxies and installing the loop and memory counters.

Both iframes use `sandbox="allow-scripts"` without `allow-same-origin`, and a Content Security Policy in a `<meta>` tag: `default-src 'none'`, and a `script-src` that names, by its hash, the one script this package wrote into each document. There is no `'unsafe-eval'`, so `eval`, `new Function` and string timers are refused by the browser. The peer-connection constructors, which open a connection the policy does not govern, are removed from the inner frame, and its document is emptied and closed before the script starts.

Before any of this, the script is pre-scanned and validated (the `agentscript` preset by default) and transformed, as in `@enclave-vm/core`. Your page counts tool calls again, copies tool arguments and results as JSON, and enforces the timeout.

## What It Protects Against, and What It Does Not

Some guarantees are enforced by the browser, and some hold only for a script the validator has accepted:

| Property                                                                                          | Enforced by                                                                     | Holds with `validate: false` |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| The page's DOM, cookies and storage cannot be reached                                             | The browser: `sandbox="allow-scripts"` without `allow-same-origin`              | Yes                          |
| No request through a source the document policy governs (`fetch`, XHR, WebSocket, subresources)   | The browser: `default-src 'none'`                                               | Yes                          |
| No code from a string, no script in another document, no worker                                   | The browser: `script-src` names the package's two scripts by hash               | Yes                          |
| No peer connection; no load started by an element, no child frame                                 | The inner frame, before the script starts (measured in Chromium)                | Yes                          |
| Tool-call limit, tool names, the copy of tool arguments and results, console limits               | Your page                                                                       | Yes                          |
| A script cannot name `window`, `document`, `location` or any other property of the frame's window | The validator: unknown names are refused                                        | **No**                       |
| Removed globals, frozen prototypes, secure proxies, memory tracking, loop limits                  | The inner frame, for a script the validator has confined to the names it allows | **No**                       |

**The validator is what keeps a script from the document it runs in.** Unlike `@enclave-vm/core`, the script does not run in a realm that holds only the allowed globals: it runs in the inner frame's window. With `validate: false` (or a preset other than `agentscript` together with `transform: false`) a script can read and change the sandbox's own variables, including its limits and counters, post messages as the frame, and learn the origin of the embedding page. Run code you do not trust with validation on.

**A script that never yields is ended only where the browser runs the sandbox frames in another process than the page.** The timeout is kept by timers, and the frames share a thread. Where the browser runs them in the page's process (for example the Chromium headless shell with default settings, or an embedded web view that keeps a sandboxed `srcdoc` frame in the page's process), a script that computes without yielding holds the page's thread, and `run()` returns the timeout error only when it has finished. The per-loop iteration limit narrows what one loop can do; it does not bound nested loops or callbacks.

**`memoryLimit` is a counter, not a budget.** It tracks what `repeat`, `padStart`, `padEnd`, `join` and `fill` allocate over a run; concatenation, spreads and literals are not counted.

The network and process-model measurements were made in Chromium; Firefox and Safari have not been measured. The layers, the message protocol and these measurements are described on the "Security Architecture" page of the browser section of the [documentation](https://agentfront.dev/docs/guides/enclave).

## Installation

```bash
npm install @enclave-vm/browser
```

The package is an ES module for browsers (no CommonJS build) and needs a DOM: it creates iframes in `document`.

## Quick Start

```typescript
import { BrowserEnclave } from '@enclave-vm/browser';

const enclave = new BrowserEnclave({
  securityLevel: 'STANDARD',
  timeout: 10000,
  maxToolCalls: 50,
  toolHandler: async (toolName, args) => {
    const response = await fetch(`/api/tools/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return response.json();
  },
});

const result = await enclave.run(`
  const users = await callTool('users:list', { limit: 10 });
  const active = users.filter(u => u.active);
  return active.length;
`);

if (result.success) {
  console.log('Result:', result.value, 'in', result.stats.duration, 'ms');
} else {
  console.error(result.error?.code, result.error?.message);
}

enclave.dispose();
```

The `toolHandler` runs in your page, with your page's network access; the script reaches it only through `callTool()` (or `toolNamespaces`).

## Options

| Option                                      | Type                                                                  | Default                            | Meaning                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `securityLevel`                             | `'STRICT' \| 'SECURE' \| 'STANDARD' \| 'PERMISSIVE'`                  | `'STANDARD'`                       | Defaults of the limits and the allowed globals                                                        |
| `preset`                                    | `'agentscript' \| 'strict' \| 'secure' \| 'standard' \| 'permissive'` | `'agentscript'`                    | AST validation preset                                                                                 |
| `preScan`                                   | `{ preset?, config? }`                                                | named like `preset`                | Pre-scanner preset or single limits; not run with `validate: false`                                   |
| `validate`                                  | `boolean`                                                             | `true`                             | Validate the script                                                                                   |
| `transform`                                 | `boolean`                                                             | `true`                             | Transform the script                                                                                  |
| `timeout`                                   | `number`                                                              | by level (30 s at STANDARD)        | Milliseconds, at most 2,147,483,647 (see above for what ends a busy script)                           |
| `toolCallGraceMs`                           | `number`                                                              | `timeout`                          | How long a tool call in progress at the timeout may still deliver; `Infinity` waits without limit     |
| `maxToolCalls`                              | `number`                                                              | by level (100 at STANDARD)         | Tool calls per run                                                                                    |
| `maxIterations`                             | `number`                                                              | by level (10,000 at STANDARD)      | Iterations per loop                                                                                   |
| `memoryLimit`                               | `number`                                                              | 1 MB                               | Bytes the tracked operations may allocate; `0` turns tracking off                                     |
| `globals`                                   | `Record<string, unknown>`                                             | -                                  | Custom globals, copied in as JSON data; a function or symbol at any depth makes the constructor throw |
| `toolHandler`                               | `(name, args) => Promise<unknown>`                                    | -                                  | Answers tool calls; can also be passed to `run()`                                                     |
| `toolNamespaces`                            | `ToolNamespaces`                                                      | -                                  | Expose tools as `ns.method(args)`; requires the `agentscript` preset                                  |
| `sanitizeStackTraces`                       | `boolean`                                                             | by level (on at STRICT and SECURE) | Redact paths, URLs and frames in returned errors                                                      |
| `maxSanitizeDepth`, `maxSanitizeProperties` | `number`                                                              | by level                           | Limits on the value a script returns                                                                  |
| `maxConsoleCalls`, `maxConsoleOutputBytes`  | `number`                                                              | by level                           | Console limits                                                                                        |
| `secureProxyConfig`                         | `Partial<SecureProxyLevelConfig>`                                     | by level                           | Override the secure proxy settings                                                                    |
| `doubleIframe`                              | `Partial<DoubleIframeConfig>`                                         | see below                          | Outer-frame checks and the timeout buffer                                                             |
| `customSerializablePatterns`                | `SerializableSuspiciousPattern[]`                                     | `[]`                               | String-based suspicious patterns that run in the outer iframe                                         |
| `allowFunctionsInGlobals`                   | `boolean`                                                             | -                                  | Has no effect: functions cannot cross the iframe boundary                                             |

Every numeric limit must be a finite number (except `toolCallGraceMs`, which may be `Infinity`); the constructor throws a `TypeError` otherwise. The per-level defaults are exported as `SECURITY_LEVEL_CONFIGS`.

`doubleIframe` defaults to `DEFAULT_DOUBLE_IFRAME_CONFIG`:

```typescript
{
  enabled: true,
  parentTimeoutBuffer: 1000, // ms added to `timeout` before the page removes the frames
  parentValidation: {
    validateOperationNames: true,
    maxOperationsPerSecond: 100,
    blockSuspiciousSequences: true,
    rapidEnumerationThreshold: 30,
    rapidEnumerationOverrides: {},
    suspiciousPatterns: [], // function-based patterns, evaluated by your page
  },
}
```

`allowedOperationPattern` and `blockedOperationPatterns` (regular expressions) restrict tool names, as in `@enclave-vm/core`.

## Results and Errors

`run()` resolves to an `ExecutionResult`; a script that is refused or fails is reported in `error`:

```typescript
interface ExecutionResult<T> {
  success: boolean;
  value?: T;
  error?: { name: string; message: string; code?: string; stack?: string; data?: Record<string, unknown> };
  stats: { duration: number; toolCallCount: number; iterationCount: number; startTime: number; endTime: number };
}
```

The returned value is copied out of the sandbox as plain data; a value containing a function or symbol, nested deeper than `maxSanitizeDepth`, or with more than `maxSanitizeProperties` properties fails the run.

| Code                                           | Meaning                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                             | The pre-scanner or the validator refused the script                                      |
| `EXECUTION_TIMEOUT`                            | The script exceeded `timeout`                                                            |
| `PROTOCOL_VIOLATION`                           | The sandbox sent the page a message the protocol does not allow; the execution was ended |
| `SANDBOX_SETUP_FAILED`                         | The inner iframe could not put one of its measures in place; the script was not started  |
| `IFRAME_CREATE_FAILED`                         | The sandbox iframe could not be created                                                  |
| `TOOL_RESULT_NOT_JSON`, `TOOL_RESULT_NOT_SAFE` | A tool result could not be copied into the sandbox                                       |
| `GLOBALS_CHANGED`                              | A custom global no longer holds the kind of value it held when the enclave was created   |
| `EXECUTION_ABORTED`, `ADAPTER_DISPOSED`        | The execution was aborted, or the enclave was disposed while it ran                      |
| `ENCLAVE_ERROR`                                | Any other failure                                                                        |

The tool-call and iteration limits end a run without a code; `error.message` starts with `Maximum tool call limit exceeded` or `Maximum iteration limit exceeded`.

## API

```typescript
class BrowserEnclave {
  constructor(options?: BrowserEnclaveOptions);
  run<T = unknown>(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<T>>;
  getSecurityLevel(): SecurityLevel;
  dispose(): void;
}
```

For advanced use the package also exports `IframeAdapter`, the message types of the iframe protocol with their guards (`isEnclaveMessage`, `isToolCallMessage`, `isResultMessage`, `isConsoleMessage`, `isReadyMessage`), and `utf8ByteLength`.

## Related Packages

- [`@enclave-vm/ast`](https://www.npmjs.com/package/@enclave-vm/ast): the validator and pre-scanner this package runs before every script
- [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core): the Node.js sandbox, which runs scripts in a realm that holds only the allowed globals

## Documentation

- Guides and reference: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Reporting a vulnerability: [SECURITY.md](https://github.com/agentfront/enclave/blob/main/SECURITY.md)

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
