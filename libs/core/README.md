# @enclave-vm/core

[![npm version](https://img.shields.io/npm/v/@enclave-vm/core.svg)](https://www.npmjs.com/package/@enclave-vm/core)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Secure AgentScript execution environment with defense-in-depth architecture

The @enclave-vm/core package provides a hardened execution environment for running LLM-generated JavaScript code (AgentScript) safely. It combines AST validation, code transformation, runtime guards, and VM sandboxing to prevent sandbox escapes and resource exhaustion.

## Security

| Metric         | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Security Tests | 1900+ tests, 100% pass rate                                            |
| Attack Vectors | 150+ blocked (including function gadget attacks)                       |
| CVE Protection | Covers known vm2, isolated-vm, node-vm exploits                        |
| Defense Layers | 6 (Pre-Scanner, AST, Transform, Scoring, VM/Worker Pool, Sanitization) |

For the full security audit report, see [SECURITY-AUDIT.md](./SECURITY-AUDIT.md).

## Features

- **Defense-in-Depth**: 6 layers of security (Pre-Scanner → AST → transformation → AI Scoring → VM/Worker Pool → output sanitization)
- **Worker Pool Adapter**: Optional worker threads around the sandbox, with a heap limit per worker and a hard stop
- **Safe Tool Calls**: Secure `callTool()` execution with iteration and call limits
- **Reference Sidecar**: Handle large data without embedding it in the script
- **Configurable Security Levels**: From STRICT to PERMISSIVE based on trust level
- **Resource Limits**: Timeout, iteration limits, and tool call limits
- **AI Scoring Gate**: Semantic analysis detects exfiltration patterns and sensitive data access
- **Zero Dependencies on Vulnerable Packages**: Uses Node.js native `vm` module

## Installation

```bash
npm install @enclave-vm/core
# or
yarn add @enclave-vm/core
# or
pnpm add @enclave-vm/core
```

## Quick Start

```typescript
import { Enclave } from '@enclave-vm/core';

// Create enclave with a tool handler
const enclave = new Enclave({
  timeout: 5000,
  maxToolCalls: 10,
  maxIterations: 1000,
  toolHandler: async (toolName, args) => {
    // Your tool execution logic
    return { success: true, data: `Called ${toolName}` };
  },
});

// Execute AgentScript code
const result = await enclave.run(`
  const user = await callTool('getUser', { id: 123 });
  const orders = await callTool('getOrders', { userId: user.id });
  return { user, orderCount: orders.length };
`);

if (result.success) {
  console.log('Result:', result.value);
} else {
  console.error('Error:', result.error);
}

// Always dispose when done
enclave.dispose();
```

## Configuration

### CreateEnclaveOptions

```typescript
interface CreateEnclaveOptions {
  // Execution limits
  timeout?: number; // Execution timeout in ms (default: 5000)
  toolCallGraceMs?: number; // How long a tool call in progress at the timeout may still take (default: same as timeout)
  maxToolCalls?: number; // Maximum tool calls allowed (default: 100)
  maxIterations?: number; // Maximum loop iterations (default: 10000)

  // Security
  securityLevel?: SecurityLevel; // STRICT | SECURE | STANDARD | PERMISSIVE
  validate?: boolean; // Enable AST validation (default: true)
  transform?: boolean; // Enable code transformation (default: true)
  realmGlobals?: 'allowlist' | 'security-level'; // What exists in the script's realm (see "What the Script's Realm Holds")

  // Where the sandbox runs
  adapter?: 'vm' | 'worker_threads'; // In this process (default) or in a pool of worker threads (see "Worker Pool Adapter")
  workerPoolConfig?: Partial<WorkerPoolConfig>;

  // Tool execution
  toolHandler?: ToolHandler; // Function to execute tool calls
  toolNamespaces?: ToolNamespaces; // Expose tools as `ns.method(args)` (see "Tool Namespaces")

  // Console
  consoleHandler?: ConsoleHandler; // Receive console calls as (level, message) instead of the host console (see "Console Handler")
  maxConsoleCalls?: number; // Maximum console calls (default: by security level)
  maxConsoleOutputBytes?: number; // Maximum total console output (default: by security level)

  // Custom globals
  globals?: Record<string, unknown>; // Additional globals for the VM
  allowFunctionsInGlobals?: boolean; // Allow functions in globals (default: false)
  maxGlobalFunctionCalls?: number; // Cap on calls into functions from globals (default: 10 × maxToolCalls)

  // Errors
  sanitizeStackTraces?: boolean; // Redact paths/frames in every returned error (default: by security level)

  // Sidecar (large data handling)
  sidecar?: ReferenceSidecarOptions;

  // Double VM security layer
  doubleVm?: PartialDoubleVmConfig; // See "Double VM Security Layer" section
}
```

### Security Levels

| Level        | Description                                | Use Case             |
| ------------ | ------------------------------------------ | -------------------- |
| `STRICT`     | Maximum security, absolute minimum globals | Untrusted code       |
| `SECURE`     | High security with safe utility functions  | Semi-trusted code    |
| `STANDARD`   | Balanced security for most use cases       | Trusted code         |
| `PERMISSIVE` | Adds console for debugging                 | Internal/development |

```typescript
import { Enclave, SecurityLevel } from '@enclave-vm/core';

const enclave = new Enclave({
  securityLevel: SecurityLevel.STRICT,
  toolHandler: async (name, args) => {
    /* ... */
  },
});
```

### Allowed Globals by Security Level

Both AST validation and runtime sandbox enforce the same allowed globals for defense-in-depth:

| Global                | STRICT | SECURE | STANDARD | PERMISSIVE |
| --------------------- | ------ | ------ | -------- | ---------- |
| **Core API**          |        |        |          |            |
| `callTool`            | ✅     | ✅     | ✅       | ✅         |
| **Data Types**        |        |        |          |            |
| `Math`                | ✅     | ✅     | ✅       | ✅         |
| `JSON`                | ✅     | ✅     | ✅       | ✅         |
| `Array`               | ✅     | ✅     | ✅       | ✅         |
| `Object`              | ✅     | ✅     | ✅       | ✅         |
| `String`              | ✅     | ✅     | ✅       | ✅         |
| `Number`              | ✅     | ✅     | ✅       | ✅         |
| `Date`                | ✅     | ✅     | ✅       | ✅         |
| **Constants**         |        |        |          |            |
| `undefined`           | ✅     | ✅     | ✅       | ✅         |
| `NaN`                 | ✅     | ✅     | ✅       | ✅         |
| `Infinity`            | ✅     | ✅     | ✅       | ✅         |
| **Utility Functions** |        |        |          |            |
| `parseInt`            | ❌     | ✅     | ✅       | ✅         |
| `parseFloat`          | ❌     | ✅     | ✅       | ✅         |
| `isNaN`               | ❌     | ✅     | ✅       | ✅         |
| `isFinite`            | ❌     | ✅     | ✅       | ✅         |
| `encodeURI`           | ❌     | ✅     | ✅       | ✅         |
| `decodeURI`           | ❌     | ✅     | ✅       | ✅         |
| `encodeURIComponent`  | ❌     | ✅     | ✅       | ✅         |
| `decodeURIComponent`  | ❌     | ✅     | ✅       | ✅         |
| **Debugging**         |        |        |          |            |
| `console`             | ❌     | ❌     | ❌       | ✅         |

With a `consoleHandler`, `console` is allowed at every level (see [Console Handler](#console-handler)).

### Blocked Globals (All Security Levels)

These dangerous globals are **always blocked** regardless of security level:

| Category           | Blocked Globals                                                                |
| ------------------ | ------------------------------------------------------------------------------ |
| **Code Execution** | `eval`, `Function`, `AsyncFunction`, `GeneratorFunction`                       |
| **System Access**  | `process`, `require`, `module`, `exports`, `__dirname`, `__filename`, `Buffer` |
| **Global Objects** | `window`, `globalThis`, `self`, `global`, `this`                               |
| **Prototype**      | `constructor`, `__proto__`, `prototype`                                        |
| **Reflection**     | `Proxy`, `Reflect`                                                             |
| **Async Flooding** | `Promise`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`       |
| **Network**        | `fetch`, `XMLHttpRequest`, `WebSocket`                                         |
| **Workers**        | `Worker`, `SharedWorker`, `ServiceWorker`                                      |
| **Memory Hazards** | `Map`, `Set`, `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry`          |
| **Binary/Wasm**    | `WebAssembly`, `ArrayBuffer`, `SharedArrayBuffer`, `Atomics`                   |
| **Error Types**    | `Error`, `TypeError`, `ReferenceError`, `SyntaxError`, `RangeError`            |
| **Symbols/Regex**  | `Symbol`, `RegExp`                                                             |

### What the Script's Realm Holds

The tables above are what the validator accepts. The realm the script runs in agrees with them:

- **Only the allowed globals exist.** With the `agentscript` or `babel` preset and validation on (the default), every other standard global is removed from the realm before the script runs: `Function`, `eval`, `globalThis`, `Proxy`, `Reflect`, `Symbol`, `Promise`, `RegExp`, `WebAssembly`, the engine's `console`, and so on. What is left is the allowed globals of the security level, the runtime helpers, your `globals` and your `toolNamespaces`. A gap in the static rules therefore does not hand a script a global. This is `realmGlobals: 'allowlist'`. With another preset, or with `validate: false`, a script may legitimately name other standard globals, so the default is `realmGlobals: 'security-level'`: only the dangerous globals listed for the level are removed. Either value can be set explicitly.
- **No name resolves through a prototype.** `constructor`, `toString`, `valueOf`, `hasOwnProperty` and the other members of `Object.prototype` are not reachable as bare names (in every mode).
- **Scripts run in strict mode.** `this` is `undefined` outside a method call, an assignment to an undeclared name is a `ReferenceError`, and a function has no `caller` or `arguments.callee`. A write that cannot happen throws a `TypeError` instead of being silently ignored: assigning over a built-in method (`obj.toString = ...`; the built-in prototypes are frozen) or changing a frozen object, such as an error the runtime threw.
- **Regular expressions cannot run.** AgentScript has none, and with the realm allowlist the realm refuses them too, including the ones the engine builds from a string argument of `match`, `matchAll` and `search`. String operations that take plain strings (`split(',')`, `replace('a', 'b')`, `includes`) are unaffected.

### Console Handler

Without a `consoleHandler`, `console` is allowed only at `PERMISSIVE` and writes to the host process console. With one, scripts may use `console` at every security level and each call goes to the handler instead:

```typescript
import { Enclave, type ConsoleHandler } from '@enclave-vm/core';

const consoleHandler: ConsoleHandler = (level, message) => logger[level](message);
const enclave = new Enclave({ securityLevel: 'STRICT', consoleHandler });

await enclave.run(`console.info('users', { count: 2 }); return 1;`); // logger.info('users {"count":2}')
```

- `level` is a `ConsoleLevel` (`'log' | 'info' | 'warn' | 'error' | 'debug'`); `message` is the formatted line (arguments joined by spaces, objects JSON-serialized).
- `maxConsoleCalls` and `maxConsoleOutputBytes` are checked before the handler runs; past a limit the script's call throws and the handler is not called.
- The handler's return value is ignored and anything it throws or rejects with is swallowed.
- The handler is not started for a console call a script makes with the stack nearly full (less than 128 KB left): that line is dropped. Without a handler, at `PERMISSIVE`, such a call throws a `RangeError` in the script instead of starting the host console. See [A script at a full stack](#a-script-at-a-full-stack).
- The script's `console` is a frozen, null-prototype object built inside the sandbox; it leads to neither the handler nor any host object.
- Supported by the double VM (default), the `vm` adapter and the `worker_threads` adapter. A custom `sandboxAdapter` receives the handler as `context.consoleHandler`; the built-in `InterpreterAdapter` passes it one line of text per call, like the other adapters.
- Combining a `consoleHandler` with a `console` entry in `globals` throws a `TypeError`.

### AST Presets

The `preset` option controls **AST-level validation** - what JavaScript constructs are allowed before code transformation. This is separate from `securityLevel` which controls runtime security.

| Preset        | Description                                   | Custom Globals   |
| ------------- | --------------------------------------------- | ---------------- |
| `agentscript` | Default. Safe subset for LLM-generated code   | ✅ Supported     |
| `strict`      | Maximum restrictions, blocks most JS features | ❌ Not supported |
| `secure`      | High security with essential features         | ❌ Not supported |
| `standard`    | Balanced security for general use             | ❌ Not supported |
| `permissive`  | Minimal AST restrictions                      | ❌ Not supported |

```typescript
import { Enclave } from '@enclave-vm/core';

const enclave = new Enclave({
  preset: 'agentscript', // AST validation preset (default)
  securityLevel: SecurityLevel.STRICT, // Runtime security level
  toolHandler: async (name, args) => {
    /* ... */
  },
});
```

**Key Differences:**

| Aspect                   | `preset` (AST)               | `securityLevel` (Runtime)   |
| ------------------------ | ---------------------------- | --------------------------- |
| When applied             | Before execution             | During execution            |
| What it controls         | JavaScript syntax/constructs | Resource limits, timeouts   |
| Function expressions     | Blocked in `agentscript`     | N/A                         |
| Getter/setter syntax     | Blocked in `agentscript`     | N/A                         |
| Custom globals whitelist | Only `agentscript` preset    | Always available at runtime |

**Note:** Only the `agentscript` preset supports the `allowedGlobals` option for whitelisting custom global identifiers in AST validation. Other presets use their own fixed rule sets.

## Worker Pool Adapter (Optional)

`adapter: 'worker_threads'` runs each script in a worker thread taken from a pool. Inside the worker the script runs in the **same sandbox** as in process: the double VM by default. The worker thread is a layer around that sandbox and adds what only a separate thread can:

- **A heap limit per worker.** A script that outgrows `memoryLimitPerWorker` loses its worker, and the pool starts a replacement. The engine enforces the limit, or the pool does when the engine cannot: see [The Worker Heap Limit](#the-worker-heap-limit), also for what the limit does not guarantee.
- **A stop that does not depend on the script.** A script that does not end is terminated together with its worker (`timeout` plus a grace period of five seconds). In process, a script that cannot be interrupted keeps the host's thread.

```typescript
import { Enclave } from '@enclave-vm/core';

const enclave = new Enclave({
  adapter: 'worker_threads', // Run scripts in the worker pool
  workerPoolConfig: {
    minWorkers: 2,
    maxWorkers: 8,
    memoryLimitPerWorker: 256 * 1024 * 1024, // 256MB
  },
  toolHandler: async (name, args) => {
    /* ... */
  },
});
```

A worker thread is **not a sandbox by itself**: it has the whole Node.js API and shares the process with the host. It is also not process isolation. For tenants that must not share a process, run one enclave per process or container.

### What Is Different From In-Process Execution

- **Tool calls** are sent to the host thread and go through the same tool bridge as in-process tool calls (argument and result sanitization, sidecar references, the tool-call limit), so they behave the same. Tool names must start with a letter and contain only letters, digits, `:`, `.`, `_` and `-`; a call with another name fails with an error the script can catch.
- **Custom globals** reach a worker as JSON data. Functions in `globals` are not available there.
- **Console output** without a `consoleHandler` is printed by the host with a `[Worker]` prefix.
- **`toolBridge.mode: 'direct'`** does not apply: requests and responses always cross as strings.

### When to Use Worker Pool

| Scenario                              | Recommendation                       |
| ------------------------------------- | ------------------------------------ |
| Trusted internal scripts              | In process (lower overhead)          |
| Untrusted AI-generated code           | Worker Pool (hard stop)              |
| Memory-sensitive workloads            | Worker Pool (heap limit per worker)  |
| Tenants that must not share a process | One enclave per process or container |
| A host that must survive any script   | One enclave per process or container |

### Worker Pool Presets

| Level      | minWorkers | maxWorkers | memoryLimit | messagesPerSec |
| ---------- | ---------- | ---------- | ----------- | -------------- |
| STRICT     | 2          | 4          | 64MB        | 100            |
| SECURE     | 2          | 8          | 128MB       | 500            |
| STANDARD   | 2          | 16         | 256MB       | 1000           |
| PERMISSIVE | 4          | 32         | 512MB       | 5000           |

### Worker Pool Configuration Options

| Option                   | Default   | Description                                             |
| ------------------------ | --------- | ------------------------------------------------------- |
| `minWorkers`             | 2         | Minimum warm workers                                    |
| `maxWorkers`             | CPU count | Maximum concurrent workers                              |
| `memoryLimitPerWorker`   | 128MB     | Heap limit of each worker (its old generation); 0: none |
| `maxMessagesPerSecond`   | 1000      | Rate limit per worker                                   |
| `maxExecutionsPerWorker` | 1000      | Recycle after N executions                              |
| `maxQueueSize`           | 100       | Maximum pending executions                              |
| `idleTimeoutMs`          | 30000     | Time before idle worker release                         |

Executions beyond `maxWorkers` wait in a queue (`maxQueueSize`, `queueTimeoutMs`). The wait counts against the script's `timeout`, so size `maxWorkers` for the concurrency you expect.

### The Worker Heap Limit

`memoryLimitPerWorker` is the limit of the worker's old generation, passed to the engine as the worker's `resourceLimits`. The engine allows the young generation on top of it, and the pool sets that to 24 MB, so the most a worker can hold is the sum of the two: its budget. (Left to the engine the young generation of such a worker is 192 MB on Node.js 24 and 48 MB on Node.js 22, measured on a 64-bit machine.)

**A heap flag on the process replaces it.** When the host process runs with `--max-old-space-size`, on the command line or in `NODE_OPTIONS`, that value becomes the heap limit of every worker thread, whatever limit a worker was created with (this is Node.js behaviour; `worker.resourceLimits` goes on reporting the limit that was asked for). The pool therefore reads the actual limit of each new worker. When the engine does not apply the configured one, the pool logs a warning once and enforces the limit itself: while a worker executes, it reads the worker's heap every 100 ms and terminates the worker when its heap and external memory exceed the budget. The execution fails with `WorkerMemoryError`. This is approximate, because a script can allocate between two reads: with a 64 MB limit and `--max-old-space-size=4096`, a script that kept allocating was stopped when its worker held about 290 MB, with the process at 0.5 GB resident; without the check it went on until the process was at 4.4 GB. Reading a worker's heap from outside needs Node.js 22.16 or later; on an older 22.x the pool can only warn that the limit is not enforced.

**The memory monitor** (`memoryCheckIntervalMs`) asks every worker for its memory use and recycles a worker that holds more than its budget. It compares what the worker itself holds, its heap plus its external memory. (`rss` is no measure of a worker: inside a worker thread it is the resident size of the whole process.)

**What the limit does not guarantee** is that the host process survives. A worker thread shares the process, and Node.js says of these limits that the process may still abort. When a worker reaches its limit, Node.js ends the worker and lets the engine finish what it is doing; an allocation burst that outruns that is a fatal out-of-memory error for the whole process. A worker that runs plain JavaScript, limited to 64 MB and keeping 50 KB strings in a tight loop, aborted the process in 6 of 6 runs on Node.js 24.18. Inside the sandbox the same loop ended only its worker when the machine was idle (40 of 40 processes), but with the engine's default young generation it aborted 13 of 480 processes that ran 12 at a time: one garbage collection can move more into the old generation than the 16 MB Node.js allows the engine to finish with. That is why the pool sets the young generation to 24 MB; with it, 0 of 480 processes aborted under the same load. One allocation that is larger than that allowance still ends the process. With the default `memoryLimit` the sandbox's own accounting stops a script long before the worker's limit is reached. Treat the worker's limit as a backstop that usually works. A host that must survive whatever a script allocates needs the enclave in a child process or a container with a memory limit of the operating system.

### Layers

```
┌──────────────────────────────────────────────────────┐
│  Worker thread: heap limit, terminated on overrun     │
│  ┌──────────────────────────────────────────────────┐│
│  │  Parent VM: membrane, tool gate, validation       ││
│  │  ┌──────────────────────────────────────────────┐││
│  │  │  Inner VM: the script, allowed globals only   │││
│  │  └──────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────┘│
│  - messages to the host are JSON text                │
└──────────────────────────────────────────────────────┘
          │ tool calls, console, result
          ▼
   Host thread: checks every message against the protocol
   schema, runs the tool bridge, owns the watchdog
```

### Security Features

- **The double VM inside the worker**: the same realm, membrane and limits as an in-process execution (a single VM with `doubleVm: { enabled: false }`)
- **`worker.terminate()`**: hard stop for a script nothing else can interrupt
- **`resourceLimits`**: a heap limit per worker, enforced by V8, or by the pool when a heap flag of the process overrides it ([The Worker Heap Limit](#the-worker-heap-limit))
- **The host does not trust a worker**: every message is parsed without prototype pollution and checked against the protocol schema (types, identifier and tool-name patterns, sizes); a message that fails ends the execution and replaces the worker
- **JSON-only messages**: no structured clone of objects in either direction
- **Rate limiting**: message flood protection per worker
- **Pool recovery**: a worker that is terminated or dies is removed and replaced, so the pool is not left short. Running out of memory is the one way a worker can still take the process with it ([The Worker Heap Limit](#the-worker-heap-limit))

## Double VM Security Layer

The Double VM provides defense-in-depth by running user code in a nested VM structure. User code runs in an **Inner VM** which is isolated inside a **Parent VM**, providing enhanced protection against VM escape attacks.

### Configuration

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  doubleVm: {
    enabled: true, // Default: true
    parentTimeoutBuffer: 1000, // Extra timeout buffer for parent VM (ms)
    parentValidation: {
      validateOperationNames: true, // Validate tool names against patterns
      allowedOperationPattern: /^(db|api):[a-z]+$/i, // Whitelist pattern
      blockedOperationPatterns: [/^shell:/i, /^system:/i], // Blacklist patterns
      maxOperationsPerSecond: 100, // Rate limiting
      blockSuspiciousSequences: true, // Enable suspicious pattern detection
      rapidEnumerationThreshold: 30, // Max same-operation calls in 5s
      rapidEnumerationOverrides: {
        // Per-operation overrides for rapidEnumerationThreshold
        search: 100, // Allow 100 search calls
        'users.list': 50, // Allow 50 user list calls
      },
    },
  },
});
```

### Parent Validation Options

| Option                      | Type                    | Default | Description                                  |
| --------------------------- | ----------------------- | ------- | -------------------------------------------- |
| `validateOperationNames`    | `boolean`               | `true`  | Enable operation name validation             |
| `allowedOperationPattern`   | `RegExp`                | -       | Whitelist pattern for operation names        |
| `blockedOperationPatterns`  | `RegExp[]`              | -       | Blacklist patterns for operation names       |
| `maxOperationsPerSecond`    | `number`                | `100`   | Rate limit for operations per second         |
| `blockSuspiciousSequences`  | `boolean`               | `true`  | Enable suspicious pattern detection          |
| `rapidEnumerationThreshold` | `number`                | `30`    | Max same-operation calls in 5 seconds        |
| `rapidEnumerationOverrides` | `Record<string,number>` | `{}`    | Per-operation thresholds (overrides default) |
| `suspiciousPatterns`        | `SuspiciousPattern[]`   | `[]`    | Custom suspicious pattern detectors          |

### Built-in Suspicious Pattern Detection

When `blockSuspiciousSequences: true`, the following patterns are detected:

| Pattern ID            | Description                                         |
| --------------------- | --------------------------------------------------- |
| `EXFIL_LIST_SEND`     | List/query followed by send/export (data exfil)     |
| `RAPID_ENUMERATION`   | Same operation called too many times (configurable) |
| `CREDENTIAL_EXFIL`    | Credential access followed by external operation    |
| `BULK_OPERATION`      | Bulk/batch operations (mass data extraction)        |
| `DELETE_AFTER_ACCESS` | Delete operation after data access (cover-up)       |

### Configuring Rapid Enumeration Detection

The `RAPID_ENUMERATION` pattern blocks excessive repeated calls to the same operation. Use `rapidEnumerationThreshold` and `rapidEnumerationOverrides` to tune this:

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  doubleVm: {
    parentValidation: {
      // Default: Block if same operation called >30 times in 5 seconds
      rapidEnumerationThreshold: 30,

      // Per-operation overrides
      rapidEnumerationOverrides: {
        search: 100, // Search can be called 100 times (pagination)
        'db.query': 50, // Database queries up to 50 times
        'users.filter': 200, // High-volume filtering allowed
      },
    },
  },
});
```

### Custom Suspicious Patterns

You can add custom pattern detectors:

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  doubleVm: {
    parentValidation: {
      suspiciousPatterns: [
        {
          id: 'CUSTOM_PATTERN',
          description: 'Detect sensitive + external call',
          detect: (operationName, args, history) => {
            const hasSensitiveAccess = history.some((h) => h.operationName.includes('sensitive'));
            const isExternalCall = operationName.includes('external');
            return hasSensitiveAccess && isExternalCall;
          },
        },
      ],
    },
  },
});
```

## AI Scoring Gate

The AI Scoring Gate provides semantic security analysis to detect attack patterns beyond what static AST validation can catch. It analyzes tool call patterns, sensitive data access, and exfiltration attempts.

### Configuration

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  scoring: {
    scorer: 'rule-based', // 'disabled' | 'rule-based' | 'local-llm' | 'external-api'
    blockThreshold: 70, // Block if score >= 70
    warnThreshold: 40, // Warn if score >= 40
  },
});
```

### Scorer Types

| Type           | Description                                | Latency |
| -------------- | ------------------------------------------ | ------- |
| `disabled`     | No scoring (pass-through)                  | 0ms     |
| `rule-based`   | Pure TypeScript rules, zero dependencies   | ~1ms    |
| `local-llm`    | On-device ML with HuggingFace transformers | ~5-10ms |
| `external-api` | External API-based scoring                 | ~100ms  |

### Custom Analyzer (Extensibility)

For advanced use cases, you can provide a custom analyzer to integrate external LLMs or static code analyzers:

```typescript
import { Enclave, CustomAnalyzer } from '@enclave-vm/core';

const myAnalyzer: CustomAnalyzer = {
  async analyze(prompt, features) {
    // Call your external LLM or static analyzer
    const response = await fetch('https://my-analyzer-api.com/score', {
      method: 'POST',
      body: JSON.stringify({ prompt, features }),
    });
    const result = await response.json();
    return {
      score: result.riskScore,
      signals: result.signals,
    };
  },
  // Optional lifecycle methods
  async initialize() {
    /* connect to service */
  },
  dispose() {
    /* cleanup */
  },
};

const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  scoringGate: {
    scorer: 'local-llm',
    localLlm: {
      modelId: 'Xenova/all-MiniLM-L6-v2',
      customAnalyzer: myAnalyzer,
    },
  },
});
```

### CustomAnalyzer Interface

```typescript
interface CustomAnalyzer {
  // Analyze prompt and features, return risk score and signals
  analyze(prompt: string, features: ExtractedFeatures): Promise<{ score: number; signals: RiskSignal[] }>;

  // Optional: Initialize resources (e.g., connect to external service)
  initialize?(): Promise<void>;

  // Optional: Cleanup resources
  dispose?(): void;
}
```

## Reference Sidecar

The Reference Sidecar is a powerful feature for handling large data in AgentScript without embedding it directly in the script. This is essential when:

- Tool responses contain large datasets
- You need to pass large data between tool calls
- Script size must be kept small for security validation

### How It Works

1. **Large Data Extraction**: When a tool returns large data, it's stored in a sidecar storage and replaced with a reference token (`__ref_abc123`)
2. **Lazy Resolution**: When the script accesses the reference, it's resolved just-in-time
3. **Safe Property Access**: Only specific properties can be accessed, preventing data exfiltration

### Enabling Sidecar

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  sidecar: {
    enabled: true,
    maxTotalSize: 10 * 1024 * 1024, // 10MB total storage
    maxReferenceSize: 1 * 1024 * 1024, // 1MB per reference
    extractionThreshold: 1024, // Extract strings > 1KB
    maxResolvedSize: 5 * 1024 * 1024, // 5MB max resolved size
    allowComposites: false, // Block string concatenation with refs
  },
});
```

### Sidecar Options

| Option                | Type      | Default | Description                                      |
| --------------------- | --------- | ------- | ------------------------------------------------ |
| `enabled`             | `boolean` | `false` | Enable the sidecar feature                       |
| `maxTotalSize`        | `number`  | 10MB    | Maximum total size of all stored references      |
| `maxReferenceSize`    | `number`  | 1MB     | Maximum size of a single reference               |
| `extractionThreshold` | `number`  | 1024    | Minimum string size to extract to sidecar        |
| `maxResolvedSize`     | `number`  | 5MB     | Maximum size when resolving references           |
| `allowComposites`     | `boolean` | `false` | Allow string concatenation with reference tokens |

### Example with Sidecar

```typescript
const enclave = new Enclave({
  sidecar: {
    enabled: true,
    extractionThreshold: 100, // Extract strings > 100 bytes
    allowComposites: false, // Block: ref + "suffix" (security measure)
  },
  toolHandler: async (name, args) => {
    if (name === 'getLargeData') {
      // Returns 1MB of data - automatically stored in sidecar
      return { data: 'x'.repeat(1024 * 1024) };
    }
  },
});

const result = await enclave.run(`
  // Large data is transparently handled via sidecar
  const response = await callTool('getLargeData', {});

  // Access properties - resolved on demand
  return { hasData: response.data.length > 0 };
`);
```

### Security Considerations

The `allowComposites: false` setting (default) blocks string concatenation with reference tokens. This prevents attacks like:

```javascript
// BLOCKED when allowComposites: false
const malicious = ref + '__proto__'; // Attempting prototype pollution
```

Set `allowComposites: true` only if you need to concatenate strings and understand the security implications.

## Tool Namespaces

Expose tools to scripts as namespaced functions instead of (or alongside) `callTool()`:

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => callMyTool(name, args),
  toolNamespaces: {
    mail: ['list', 'send'], // mail.list(args) calls the tool 'mail.list'
    users: { get: 'users:get' }, // users.get(args) calls the tool 'users:get'
  },
});

const result = await enclave.run(`
  const inbox = await mail.list({ unread: true });
  const sender = await users.get({ id: inbox[0].from });
  return sender.name;
`);
```

A namespace method call **is** a `callTool()` call: `mail.list(args, options)` behaves exactly like
`callTool('mail.list', args, options)`. It counts toward `maxToolCalls`, goes through the double VM's
rate limit, operation-name and suspicious-sequence checks, its result is sanitized, and it reaches your
`toolHandler`. `args` defaults to `{}`. Each namespace is a frozen, null-prototype object created
inside the sandbox, so aliasing (`const m = mail; m.list()`) and destructuring work and no host object
is exposed.

The constructor throws a `TypeError` (`Invalid toolNamespaces: ...`) for names that are not identifiers,
prototype keys (`__proto__`, `constructor`, `prototype`), names starting with `__`, reserved words and
sandbox globals used as namespaces (`callTool`, `Math`, `console`, ...), identifiers the AgentScript
validator refuses (`process`, `fetch`, ...), namespaces that collide with a custom global, duplicated
methods, and tool names every adapter cannot carry (empty, over 256 characters, or outside letters, digits,
`:`, `.`, `_` and `-` starting with a letter, including a generated `<namespace>.<method>` name).

Prefer namespaces over exposing tools as functions in `globals`: functions in `globals` are gated and
sanitized (see "Custom Globals"), but the suspicious-sequence detectors only see tool calls.

## callTool Options

Scripts can pass options as the third argument of `callTool` (or the second argument of a namespace
method):

```javascript
const r = await callTool('users:get', { id }, { throwOnError: false });
if (r.success) {
  return r.data;
}
return { failed: r.error.message }; // r.error: { name, message, code?, toolName }
```

| Option         | Default | Description                                                                                                            |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `throwOnError` | `true`  | `false`: resolve to `{ success: true, data }` or, when the tool fails, `{ success: false, error }` instead of throwing |

Only failures of the tool itself (the handler threw or rejected, or its result could not be delivered)
are returned this way; the error object is plain data with no stack. Refusals by the enclave (abort,
`maxToolCalls`, rate limit, operation-name and suspicious-sequence checks, invalid arguments) always
throw. Options are applied inside the sandbox and are not passed to the `toolHandler`.

## Custom Globals

You can provide custom globals to the VM:

```typescript
const enclave = new Enclave({
  globals: {
    config: { apiUrl: 'https://api.example.com' },
    helpers: {
      formatDate: (date: Date) => date.toISOString(),
    },
  },
  allowFunctionsInGlobals: true, // Required when globals contain functions
  toolHandler: async (name, args) => {
    /* ... */
  },
});

const result = await enclave.run(`
  const url = config.apiUrl;
  const formatted = helpers.formatDate(new Date());
  return { url, formatted };
`);
```

**Security Note**: Set `allowFunctionsInGlobals: true` only when you intentionally provide functions. Functions in globals can potentially leak host scope via closures.

Every call from the script into a function from `globals` (including functions nested in objects) goes
through the enclave's gate:

- it is refused once the execution is aborted, and counts toward `maxGlobalFunctionCalls`
  (default: 10 × `maxToolCalls`), not toward `maxToolCalls`;
- its arguments are copied into plain host data first, the way tool arguments are: the function
  receives null-prototype objects, arrays, primitives and `Date`s, never a live script value, and a
  call that passes a function or a symbol is refused. The script's `this` is not passed either;
- in the double VM (the default) it shares the operation rate limit
  (`doubleVm.parentValidation.maxOperationsPerSecond`) with tool calls;
- its return value is sanitized like a tool result: the script receives a plain-data copy, and a
  value containing functions or symbols, or exceeding the sanitize depth/size limits, is refused;
- an error it throws reaches the script as a plain error without the host stack;
- calling it with `new` is refused.

The suspicious-sequence detectors only look at tool calls, so expose tools with `toolNamespaces` or
`callTool()`, not as functions. The `worker_threads` adapter never passes functions into the sandbox.

A function is not started when the script calls it with the stack nearly full (less than 128 KB
left): the call throws a `RangeError` in the script, and the function has not run. So a function
either runs and its result reaches the script, or it was not started.

The validation of `globals` judges what a script can reach through a value, not only what the
value has itself. The methods of a class are functions in `globals`: an instance of a class with
methods needs `allowFunctionsInGlobals: true`, and so does a function in a property that is not
enumerable or is keyed by a symbol. Code that runs when a property is read is refused whatever is
allowed: a getter or setter, on the value or on its class, and a Proxy of an object. That
includes a `Buffer` (pass a `Uint8Array`) and an `Error` object (pass its message). A function
passed as a global is judged as a function; what hangs on it is not looked at.
An instance of a class without methods or accessors is plain data and is accepted, unless
`secureProxyConfig.blockConstructor` is off (as at `PERMISSIVE`): then a script can read its
`constructor`, which is a function.

Values passed in `globals` are **read-only** inside the sandbox. They are the host's own objects, shared
by every execution of the enclave, so a script cannot assign to them, add or delete properties, freeze
them, or call a built-in method that changes its receiver (`push`, `sort`, `Map.prototype.set`,
`Date.prototype.setTime`, ...): the attempt throws, or is ignored at `PERMISSIVE`. Reading works as
before, and an array returned by a built-in method (`map`, `filter`, `slice`, ...) is the script's own
copy, which it can sort or extend. To let scripts keep state, return it from a tool instead.

Inside arrays, Maps and Sets only plain data is allowed (primitives, plain objects, arrays, Maps, Sets,
Dates, RegExps, typed arrays): the built-in methods of those collections (`forEach`, iteration, `get`)
hand elements to the script directly, so a function (or an object with methods) stored there would be
called without the gate. The constructor refuses it with an error naming the path, e.g.
`Custom global "cfg" contains a function inside a collection at hooks.0.run`. Every own entry counts there,
enumerable or not, and Map and Set subclasses are refused inside collections. Arrays anywhere in `globals`
must be plain arrays (no Proxy, no custom prototype), since those can hide entries from validation.
Promises, WeakMaps, iterators and generators are refused anywhere in `globals`, since their contents cannot
be validated.

## Execution Result

```typescript
interface ExecutionResult<T> {
  success: boolean;
  value?: T; // Result when success is true
  error?: {
    message: string;
    name: string;
    code?: string; // Error code (e.g., 'VALIDATION_ERROR', 'TIMEOUT')
    stack?: string;
    data?: Record<string, unknown>;
  };
  stats: {
    duration: number; // Execution time in ms
    toolCallCount: number; // Number of tool calls made
    iterationCount: number; // Number of loop iterations
  };
}
```

With `sanitizeStackTraces` on (the default for `STRICT` and `SECURE`), every returned `error.stack` is
sanitized, whichever stage raised the error (validation, transformation, compilation, execution, tool
calls) and whichever adapter ran the script: stack frames become `at [REDACTED]` and paths, URLs and
file locations in the remaining lines are redacted.

### Error Codes

| Code               | Description                            |
| ------------------ | -------------------------------------- |
| `VALIDATION_ERROR` | AST validation failed (dangerous code) |
| `TIMEOUT`          | Execution exceeded timeout             |
| `MAX_TOOL_CALLS`   | Exceeded maximum tool calls            |
| `MAX_ITERATIONS`   | Exceeded maximum loop iterations       |
| `TOOL_ERROR`       | Tool handler threw an error            |
| `RUNTIME_ERROR`    | General runtime error in script        |

### How `timeout` Is Enforced

- Until the script's first `await`, Node's `vm` interrupts it at the deadline.
- After that, the script checks the clock itself: the transformer inserts a check at the start of
  every function and loop body, so synchronous work, recursion and promise chains that never yield
  are stopped at the deadline as well. A script that catches the timeout error cannot enter another
  function or loop iteration.
- A tool call in progress at the deadline is not cut off, and its result is delivered. From then on
  the next tool call or call into a host function is refused with `Execution aborted`. The same
  holds for an async function from `globals`.
- That wait has an end: `toolCallGraceMs` after the deadline the execution ends with the timeout
  error, whatever is still in progress, and `error.data.pendingHostCalls` says how many calls
  were left running. The default is the value of `timeout`, so `run()` takes at most twice
  `timeout`. `0` ends every execution at the deadline; `Infinity` waits for the handler however
  long it takes, as versions up to 2.18 did (a handler that never settles then keeps `run()` from
  settling).
- When `run()` has returned, for whatever reason, the script is finished for the host as well.
  What it left behind (a tool call it did not await, with a `then` on it) can no longer call a
  tool, a function from `globals` or the console.
- A script that only waits is ended as well. Waiting takes no code: a thenable that never calls
  back (`return { then: () => 0 }`) is enough, and nothing runs that could look at the clock. So
  the enclave keeps count of what the host has in flight for the script (tool calls, async
  functions from `globals`), and from the deadline on `run()` returns the timeout error as soon as
  that count is zero. A sandbox has no timers and no I/O, so nothing else could wake the script.
  (With `adapter: 'worker_threads'` the pool ends such a script like a busy one: with its worker,
  five seconds after the deadline.)
- Not covered: a single built-in call that does all its work natively (the memory limit bounds
  those) and a script run with `transform: false`. And the enclave cannot stop your
  `toolHandler`: a call it stops waiting for keeps running in the host, so a tool that changes
  something should be safe to repeat, or have a time limit of its own. For a
  stop the script cannot influence, use `adapter: 'worker_threads'`: a script that is still
  running five seconds after its timeout is terminated with its worker (see
  [Worker Pool Adapter](#worker-pool-adapter-optional)). A process you can terminate does the
  same for everything else that runs in it.

## Defense-in-Depth Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Code Input                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: Pre-Scanner (ast-guard)                           │
│  ├── Blocks ReDoS patterns                                  │
│  ├── Blocks BiDi/Trojan source attacks                      │
│  ├── Input size limits                                      │
│  └── Nesting depth limits                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: AST Validation (ast-guard)                        │
│  ├── NoEvalRule - Blocks eval(), Function()                 │
│  ├── NoGlobalAccessRule - Blocks dangerous globals          │
│  ├── DisallowedIdentifierRule - Blocks reserved prefixes    │
│  └── RequiredFunctionCallRule - Enforces callTool usage     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Code Transformation                               │
│  ├── Wraps in async function __ag_main()                    │
│  ├── callTool → __safe_callTool (tracked)                   │
│  ├── Loops → __safe_for, __safe_forOf (guarded)             │
│  └── String literals → extracted to sidecar (if enabled)   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: AI Scoring Gate                                   │
│  ├── Semantic security analysis via AST features            │
│  ├── Exfiltration pattern detection                         │
│  ├── Sensitive field access tracking                        │
│  └── Risk scoring (0-100) with thresholds                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Runtime Sandbox                                   │
│  ├── Standard: Node.js vm (prototype isolation)             │
│  ├── Optional: Worker Pool (heap limit, hard stop)          │
│  │   ├── Dual-layer: worker thread + VM context             │
│  │   ├── Hard halt via worker.terminate()                   │
│  │   └── Per-worker memory limits                           │
│  ├── __safe_callTool - Enforces maxToolCalls                │
│  ├── __safe_forOf - Enforces maxIterations                  │
│  └── Timeout enforcement                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: Output Sanitization                               │
│  ├── Removes stack traces                                   │
│  ├── Sanitizes file paths                                   │
│  └── Truncates oversized outputs                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Safe Execution Result                    │
└─────────────────────────────────────────────────────────────┘
```

## Runtime Notes

### Node.js 24 (V8 13.x)

V8 13.x, which every Node.js 24 release ships, can crash the process when the same compiled code is instantiated in a second context: once a function has baseline (Sparkplug) code, a garbage collection that starts while a fresh closure of it is being entered reads a stale register (`SIGSEGV` in `ClearStaleLeftTrimmedPointerVisitor`). Running one script repeatedly, in fresh contexts, is exactly that pattern. Node.js 22 does not have the defect and V8 14.1 (Node.js 25) fixed it.

On an affected engine the enclave therefore never shares compiled sandbox code: every source it compiles for a sandbox is made unique, so nothing comes out of the engine's compilation cache. Nothing needs to be configured. Details and the crash measurements are in `src/sandbox-script.ts`.

A process started with `node --no-sparkplug` has no baseline code and cannot hit the defect. The enclave reads that flag from the command line (`process.execArgv`) when it is loaded, and in such a process it shares compiled code as on an unaffected engine. Measured in the same batch as the table, the same script again took 3.0 ms per execution with the flag (5.5 ms without it), which is what Node.js 22 takes; a script the engine had not seen gained little (5.0 ms against 5.6 ms). The flag has a price of its own: everything in the process that is not optimized yet runs in the interpreter. It has to be on the command line (Node.js refuses it in `NODE_OPTIONS`), and a command line that mentions the baseline compiler in any other way, such as `--always-sparkplug`, keeps the workaround on.

What that costs, measured on Node.js 24.18.0 and 22.21.1 (arm64) with a small script, the double VM and default options:

| Time per execution                      | Node.js 24 | Node.js 22 | 2.18.0 (either)                                                         |
| --------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------- |
| The same script again                   | 5.5 ms     | 3.0 ms     | 2.0 ms                                                                  |
| A script the engine has not seen before | 5.6 ms     | 5.1 ms     | 6.0 ms at first; 10.5 ms as the median over 1,500 scripts of one length |

The last column rose because the engine compares a new source with every source of the same length it still holds (V8 hashes a long string by its length alone), and the bootstraps of two scripts of one length used to differ only near their end. They now differ at their start, and on an affected engine they also differ in length.

### A script at a full stack

A script can recurse until the stack is full and, on the way back up, call everything it has at
every level. What the enclave guarantees there:

- **What the script catches is its own.** Every call into the runtime enters through a function of
  the script's realm, so the `RangeError` of a stack overflow is an error of that realm whatever
  was being called.
- **The runtime's code and yours start with room to finish.** V8 refuses to compile a function for
  its first call when less than about 40 KB of stack is left (measured: 39.9 KB with Node.js 24,
  46.4 KB with Node.js 22), so code that starts in that zone fails wherever it first calls
  something new. A call into the runtime needs 64 KB; a function from `globals`, a
  `consoleHandler` and the host console need 128 KB, checked on the host right before they start.
  With less, the script gets a `RangeError` (a console line for a `consoleHandler` is dropped)
  and nothing of the host has run. Without this, a write to `process.stdout` that is cut off
  halfway leaves that stream waiting forever, and that is not specific to the sandbox.
- **A tool handler starts from an empty stack**, whatever the script's stack looks like when it
  makes the call.
- The check costs about 2.7 microseconds per call into the runtime and about 5.5 per call into
  your code. Reading a property is not checked, and has no need to be: `globals` cannot hold
  getters or proxies, so no code of yours runs on a read (see [Custom Globals](#custom-globals)).

What it does not prevent: **Node.js writes to the process's stderr** when a promise is rejected
while the stack is full. Its own bookkeeping for the rejection is JavaScript and cannot run there,
and it prints a block (`Exception in PromiseRejectCallback`, with the source line that was
executing) from native code. A script can produce such blocks at a few megabytes per second for as
long as it runs, and the printed line is a line of the script. Nothing in JavaScript can intercept
that write, in a worker thread either. If your stderr is collected, give it a size limit and do not
parse it for decisions; a child process whose stderr you control is the complete answer.

### Promise rejections a script leaves behind

Node.js ends the process when a promise is rejected and nothing handles it, and the rule covers
the promises of a sandbox: an async function that throws and is not awaited, a failing tool call
nobody awaits. The enclave therefore answers the two process events `unhandledRejection` and
`rejectionHandled` itself for every promise that is not one of the host realm (it wraps
`process.emit` the first time a sandbox is used). The process goes on, none of your listeners is
called with a script's promise or reason, and your own rejections reach your listeners, or end the
process, exactly as before.

- Under `--unhandled-rejections=strict` Node.js raises the exception before it emits anything, and
  under `=warn` it prints its warning first: use the default mode (`throw`) or `none`.
- Promises of `vm` contexts your application created itself are covered as well.
- `disableSandboxRejectionGuard()` turns this off. Your `unhandledRejection` listener then has to
  ignore every promise for which `isHostPromise(promise)` is false, without touching the reason.
- Test runners that give tests a stand-in `process` object (Jest does) are not covered: there the
  runner reports a script's rejection as a failure of the test.
- In the sandbox, `Symbol.for` refuses keys in the `nodejs.` namespace: Node.js looks up some of
  its own protocols in that registry, among them the method `util.inspect` calls on a value.

### Memory under sustained load

V8 keeps every script it compiled in its compilation cache until several major garbage collections have passed, whether or not anything still uses it. An execution of a script the engine has not seen before leaves about 0.4 MB there (0.26 MB in 2.18.0); on an affected engine every execution does, because no compiled code is shared. Under a steady stream of executions the heap therefore grows toward its limit before the engine starts dropping those entries: 2,000 executions took the heap to 1.4 GB with the default limit, and stayed at about 0.5 GB, at the same speed, with `--max-old-space-size=512`. Nothing is leaked: a heap snapshot, which clears that cache, shows 2 KB per execution. Give the process the heap limit you want it to stay within rather than relying on the default. With the worker pool, that flag also replaces the heap limit of every worker thread, and the pool then enforces `memoryLimitPerWorker` itself: see [The Worker Heap Limit](#the-worker-heap-limit).

## API Reference

### Enclave Class

```typescript
class Enclave {
  constructor(options?: CreateEnclaveOptions);

  // Execute AgentScript code
  run<T = unknown>(code: string): Promise<ExecutionResult<T>>;

  // Clean up resources
  dispose(): void;
}
```

### ToolHandler Type

```typescript
type ToolHandler = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
```

Called for every `callTool()` and `toolNamespaces` method call that passes the enclave's checks. The
script's `callTool` options (`CallToolOptions`) are applied inside the sandbox and are not passed to
the handler.

## Testing

```bash
# Run tests
nx test enclave-vm

# Run tests with coverage
nx test enclave --coverage
```

## Related Packages

- [`ast-guard`](../ast-guard) - AST validation rules used by enclave

## License

Apache-2.0
