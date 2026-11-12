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

For the full security audit report, see [SECURITY-AUDIT.md](./SECURITY-AUDIT.md). The invariants of the sandbox by layer, and the ones that are still open, are listed in [SECURITY-TESTS.md](../../SECURITY-TESTS.md): in process the time and memory limits are the enclave's own accounting, not the engine's (see [How `timeout` Is Enforced](#how-timeout-is-enforced) and [What `memoryLimit` Counts](#what-memorylimit-counts)).

## Features

- **Defense-in-Depth**: 6 layers of security (Pre-Scanner → AST → transformation → AI Scoring → VM/Worker Pool → output sanitization)
- **Worker Pool Adapter**: Optional worker threads around the sandbox, with a heap limit per worker and a hard stop
- **Safe Tool Calls**: Secure `callTool()` execution with iteration and call limits
- **Reference Sidecar**: Handle large data without embedding it in the script
- **Configurable Security Levels**: From STRICT to PERMISSIVE based on trust level
- **Resource Limits**: Timeout, memory accounting, iteration limits, and tool call limits
- **AI Scoring Gate**: Optional heuristic risk score for a script, from its tool calls and argument names
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
  timeout?: number; // Execution timeout in ms (default: 30000; by security level)
  toolCallGraceMs?: number; // How long a tool call in progress at the timeout may still take (default: same as timeout)
  maxToolCalls?: number; // Maximum tool calls allowed (default: 100; by security level)
  maxIterations?: number; // Maximum loop iterations (default: 10000; by security level)
  memoryLimit?: number; // Memory limit in bytes, as the enclave counts it (default: 1048576, 1 MB; 0: off)

  // Security
  securityLevel?: SecurityLevel; // 'STRICT' | 'SECURE' | 'STANDARD' | 'PERMISSIVE' (default: 'STANDARD')
  preset?: AstPreset; // AST validation preset (default: 'agentscript')
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

  // Scoring gate
  scoringGate?: ScoringGateConfig; // See "AI Scoring Gate" section

  // Double VM security layer
  doubleVm?: PartialDoubleVmConfig; // See "Double VM Security Layer" section
}
```

### Option Values

The constructor checks its options and throws a `TypeError` for a value outside the documented type or range:

- A limit is a finite integer in its range: `timeout` from 1 to 4294967295; `maxIterations`, `maxSanitizeDepth` and `maxSanitizeProperties` at least 1; `maxToolCalls`, `maxConsoleCalls`, `maxConsoleOutputBytes`, `maxGlobalFunctionCalls` and `memoryLimit` at least 0. `Infinity`, `NaN` and a value of another type (a numeric string, `null`) are refused. The one exception is `toolCallGraceMs`, a number of at least 0 for which `Infinity` means "wait without limit".
- A switch is a boolean: `validate`, `transform`, `sanitizeStackTraces`, `allowFunctionsInGlobals`, `allowBuiltins`, `doubleVm.enabled`, and the switches of `secureProxyConfig` and `doubleVm.parentValidation`.
- `securityLevel` is one of the four levels.
- An option passed as `undefined` is an option that was not set: it has its default, which is the security level's value where the level sets one. A wrapper can forward `{ maxIterations: opts.maxIterations }` whether or not its caller set it.

### Limits on the Script Itself

- **Size.** A script is at most 5,242,880 characters. A longer one, or a script that is not a string, fails with `VALIDATION_ERROR` before anything parses it.
- **Dynamic import.** A script that contains `import()` or `import.meta` is refused before it runs. Every preset refuses it during validation; with `validate: false` it fails with `SECURITY_VIOLATION`. The word in a string, a comment or a property name is not the construct.
- **Iteration limit.** A script that declares `__maxIterations`, the runtime's name for the limit, is refused. With validation off the limit still holds: each loop is compared with a number in its own code.

### What `memoryLimit` Counts

`memoryLimit` (default 1 MB; `0` switches it off) is the enclave's own accounting of the operations that make data grow. It is not a limit of the engine's heap.

- **Text**: concatenation (`a + b`, and `x += y`, which is charged like `x + y`) and the methods that multiply their input (`repeat`, `padStart`, `padEnd`, `join`).
- **Arrays**: no single array is larger than the limit holds, at 8 bytes per element, and what an operation adds is charged: `push`, `unshift`, `splice`, `fill`, the elements `concat`, `flat`, `flatMap` and a spread literal add, and what `Array.from` makes out of something that is not an array.
- **Not counted**: a copy is free, so a script can hold many arrays that are each within the limit; object literals, Maps and Sets are not counted.

A script that goes over the limit fails with `MEMORY_LIMIT_EXCEEDED`, and a script cannot switch the accounting off or reset it. With a limit set, a returned value whose serialized size is estimated above the limit (above 50 MB where the limit is larger) fails with `SERIALIZATION_LIMIT_EXCEEDED`. The limit is an estimate: where the host must survive whatever a script allocates, use the [worker pool](#worker-pool-adapter-optional), whose workers have a heap limit of the engine, or a child process or container with a memory limit of the operating system.

### Security Levels

| Level        | Description                                | Use Case             |
| ------------ | ------------------------------------------ | -------------------- |
| `STRICT`     | Maximum security, absolute minimum globals | Untrusted code       |
| `SECURE`     | High security with safe utility functions  | Semi-trusted code    |
| `STANDARD`   | Balanced security for most use cases       | Trusted code         |
| `PERMISSIVE` | Adds console for debugging                 | Internal/development |

```typescript
import { Enclave } from '@enclave-vm/core';

const enclave = new Enclave({
  securityLevel: 'STRICT',
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
  securityLevel: 'STRICT', // Runtime security level
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

| Option                   | Default   | Description                                                      |
| ------------------------ | --------- | ---------------------------------------------------------------- |
| `minWorkers`             | 2         | Minimum warm workers                                             |
| `maxWorkers`             | CPU count | Maximum concurrent workers                                       |
| `memoryLimitPerWorker`   | 128MB     | Heap limit of each worker (its old generation); 0: none          |
| `maxMessagesPerSecond`   | 1000      | Messages a worker may send per second while it runs an execution |
| `maxPendingToolCalls`    | 100       | Tool calls one execution may have in flight                      |
| `maxMessageSizeBytes`    | 16MB      | Largest single message a worker may send                         |
| `maxExecutionsPerWorker` | 1000      | Recycle after N executions                                       |
| `maxQueueSize`           | 100       | Maximum pending executions                                       |
| `queueTimeoutMs`         | 30000     | Longest wait for a free worker                                   |
| `idleTimeoutMs`          | 30000     | Time before idle worker release                                  |

These are the defaults of `WorkerPoolConfig`. An enclave starts from the preset of its security level (the table above, exported as `WORKER_POOL_PRESETS`), and `workerPoolConfig` overrides single settings of it.

Executions beyond `maxWorkers` wait in a queue (`maxQueueSize`, `queueTimeoutMs`). The wait counts against the script's `timeout`, so size `maxWorkers` for the concurrency you expect.

`maxMessagesPerSecond` is counted per execution: what an earlier execution sent from the same worker is not held against the next one, and the result and the worker's confirmation that it is idle are not counted. `maxMessageSizeBytes` is applied before a message is parsed. The limit an execution gets is never below what the enclave's own limits let one message carry (a tool request of `toolBridge.maxPayloadBytes`, a result of `memoryLimit`), so it decides where those are larger than it or off: with `memoryLimit: 0` it is the only bound on the size of a result.

### How a Worker Execution Ends

A worker runs one execution at a time. After its result it confirms that it is idle, which it can only do when nothing of the script keeps its thread busy, and only then is it given to the next execution. A worker that does not confirm within one second is terminated and replaced; the result it sent stands.

An execution the pool ends itself ends its worker too, and the pool starts a new one. `run()` then returns `error.code` `EXECUTION_ERROR` with one of these in `error.name`:

| `error.name`                          | When                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `WorkerTimeoutError`                  | The script was still running five seconds after its `timeout`                                                              |
| `WorkerMemoryError`                   | The worker held more than its memory budget while it executed (see [The Worker Heap Limit](#the-worker-heap-limit))        |
| `MessageFloodError`                   | The execution sent more than `maxMessagesPerSecond` messages                                                               |
| `MessageSizeError`                    | A message from the worker was larger than the limit                                                                        |
| `TooManyPendingCallsError`            | More than `maxPendingToolCalls` tool calls were in flight                                                                  |
| `MessageValidationError`              | A message from the worker did not pass the protocol schema                                                                 |
| `ExecutionAbortedError`               | The pool was disposed while the execution was in flight, or the script's time had passed before it started (it is not run) |
| `QueueFullError`, `QueueTimeoutError` | No worker became free: the queue was full, or the wait exceeded `queueTimeoutMs`                                           |

`dispose()` ends the executions in flight with `ExecutionAbortedError` and terminates every worker.

### The Worker Heap Limit

`memoryLimitPerWorker` is the limit of the worker's old generation, passed to the engine as the worker's `resourceLimits`. The engine allows the young generation on top of it, and the pool sets that to 24 MB, so the most a worker can hold is the sum of the two: its budget. (Left to the engine the young generation of such a worker is 192 MB on Node.js 24 and 48 MB on Node.js 22, measured on a 64-bit machine.)

**A heap flag on the process replaces it.** When the host process runs with `--max-old-space-size`, on the command line or in `NODE_OPTIONS`, that value becomes the heap limit of every worker thread, whatever limit a worker was created with (this is Node.js behaviour; `worker.resourceLimits` goes on reporting the limit that was asked for). The pool therefore reads the actual limit of each new worker. When the engine does not apply the configured one, the pool logs a warning once and enforces the limit itself: while a worker executes, it reads the worker's heap every 100 ms and terminates the worker when its heap and external memory exceed the budget. The execution fails with `WorkerMemoryError`. Where the engine does enforce the heap limit, the same read bounds what the engine does not count: memory the worker holds outside its heap counts against the budget while it executes. This is approximate, because a script can allocate between two reads: with a 64 MB limit and `--max-old-space-size=4096`, a script that kept allocating was stopped when its worker held about 290 MB, with the process at 0.5 GB resident; without the check it went on until the process was at 4.4 GB. Reading a worker's heap from outside needs Node.js 22.16 or later; on an older 22.x the pool can only warn that the limit is not enforced.

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
- **Rate and size limits**: the messages a worker may send per second, counted per execution, and the size of one message
- **Idle confirmation**: a worker is given to the next execution only when it has confirmed that nothing of the last script is left in it
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

The AI Scoring Gate gives a script a risk score from 0 to 100 before it runs and refuses the script when the score reaches a threshold. The score is a heuristic over features of the script's text: the tools it calls, their argument names and literal values, their order, and the loops they are in. It flags patterns that look like exfiltration, bulk access or access to sensitive fields; a low score is not evidence that a script is safe. The gate runs after AST validation and before execution, and is off unless configured.

### Configuration

```typescript
const enclave = new Enclave({
  toolHandler: async (name, args) => {
    /* ... */
  },
  scoringGate: {
    scorer: 'rule-based', // 'disabled' | 'rule-based' | 'local-llm' | 'external-api'
    blockThreshold: 70, // Do not run the script if score >= 70
    warnThreshold: 40, // Set scoringResult.warned if score >= 40
    failOpen: true, // Run the script when scoring fails (default)
  },
});
```

| Option           | Default                        | Description                                                                                     |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `scorer`         | `'disabled'`                   | Which scorer answers                                                                            |
| `scoring`        | -                              | Progressive scoring: the rule-based scorer first, a detailed scorer for scripts that score high |
| `blockThreshold` | 70                             | A script with a score at or above it is not run                                                 |
| `warnThreshold`  | 40                             | A script with a score at or above it runs, with `scoringResult.warned` set                      |
| `failOpen`       | `true`                         | Whether a script runs when the scorer cannot give its answer                                    |
| `customRules`    | -                              | Base scores of the rule-based scorer by rule id (0-100; 0 turns a rule off)                     |
| `toolNamespaces` | the enclave's `toolNamespaces` | The namespaces whose method calls are scored as tool calls                                      |
| `localLlm`       | -                              | Configuration of the `local-llm` scorer                                                         |
| `externalApi`    | -                              | `endpoint`, `apiKey`, `timeoutMs`, `retries`, `headers` of the `external-api` scorer            |
| `cache`          | enabled, 5 minutes, 1,000      | Cache of scoring results by the SHA-256 digest of the script                                    |
| `verbose`        | `false`                        | Log scores and signals to the console                                                           |

A scoring failure is anything that keeps the configured scorer from giving its answer: a script the feature extractor cannot parse (`FeatureExtractionError`), a scorer that throws, and in progressive mode a detailed scorer that fails or is missing once the fast score called for it. With `failOpen: false` each of these refuses the script; with `failOpen: true` the script runs.

A refused script fails with `SCORING_BLOCKED`; `error.data` holds `totalScore`, `riskLevel` and `signals`. A result of a script the gate evaluated carries `scoringResult`.

A call through a tool namespace (`mail.send(args)`) is scored as the tool call it stands for (`callTool('mail.send', args)`): the gate of an enclave knows the enclave's `toolNamespaces`.

### Scorer Types

| Type           | What the score is computed from                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `disabled`     | No scoring                                                                                                |
| `rule-based`   | Eight TypeScript rules over the extracted features, zero dependencies                                     |
| `local-llm`    | Your `customAnalyzer`, or a built-in keyword heuristic over the extracted features (no model computes it) |
| `external-api` | The answer of your scoring service, which receives the extracted features                                 |

The `local-llm` scorer loads a Hugging Face model at initialization when the optional dependency `@huggingface/transformers` is installed, but it never calls it: no score is computed from the model. Set `ENCLAVE_DISABLE_LOCAL_LLM_MODEL=1` to skip the load. Its `mode: 'similarity'` searches a VectoriaDB index that is created empty and that the configuration cannot fill, so it scores like the default mode.

### Custom Analyzer (Extensibility)

A custom analyzer replaces the keyword heuristic of the `local-llm` scorer, for example with a call to a model or a static analyzer of your own:

```typescript
import { Enclave, type LocalLlmConfig } from '@enclave-vm/core';

const myAnalyzer: NonNullable<LocalLlmConfig['customAnalyzer']> = {
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

The Reference Sidecar keeps large strings outside the sandbox. The script holds a short reference token in place of the data and can pass it on to another tool. This is for scripts that move large data from one tool to another, not for scripts that read it.

### How It Works

1. **Storing**: A string of at least `extractionThreshold` bytes is stored in the sidecar and replaced by a reference token (`__REF_<uuid>__`). This applies to a string literal in the script's source and to a tool result that is a string as a whole. A tool that returns an object or an array is returned as it is, with every string in it.
2. **The script holds a token**: Nothing is resolved for the script, lazily or otherwise. The token is an ordinary short string, and the script has no way to read the stored data.
3. **Resolving at the tool boundary**: A token in the arguments of a tool call, at any depth, is replaced with the stored data before the `toolHandler` is called.

The sidecar belongs to one execution and is disposed when `run()` returns.

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
    extractionThreshold: 1024, // Store strings of 1KB and more
    maxResolvedSize: 5 * 1024 * 1024, // 5MB resolved for one tool call
    allowComposites: false, // Refuse string concatenation with refs
  },
});
```

### Sidecar Options

| Option                 | Type      | Default              | Description                                                              |
| ---------------------- | --------- | -------------------- | ------------------------------------------------------------------------ |
| `enabled`              | `boolean` | `false`              | Enable the sidecar feature                                               |
| `maxTotalSize`         | `number`  | by level             | Maximum total size of all stored references                              |
| `maxReferenceSize`     | `number`  | by level             | Maximum size of a single reference                                       |
| `extractionThreshold`  | `number`  | by level             | Size in bytes from which a string is stored                              |
| `maxResolvedSize`      | `number`  | by level             | Maximum size the references in the arguments of one tool call resolve to |
| `maxTotalResolvedSize` | `number`  | twice `maxTotalSize` | Maximum size of everything one execution resolves for its tool calls     |
| `maxReferenceCount`    | `number`  | by level             | Maximum number of references in one execution                            |
| `allowComposites`      | `boolean` | by level             | Allow string concatenation with reference tokens                         |

| Default               | STRICT  | SECURE  | STANDARD | PERMISSIVE |
| --------------------- | ------- | ------- | -------- | ---------- |
| `maxTotalSize`        | 16 MB   | 64 MB   | 256 MB   | 1 GB       |
| `maxReferenceSize`    | 4 MB    | 16 MB   | 64 MB    | 256 MB     |
| `extractionThreshold` | 64 KB   | 256 KB  | 1 MB     | 4 MB       |
| `maxResolvedSize`     | 8 MB    | 32 MB   | 128 MB   | 512 MB     |
| `maxReferenceCount`   | 50      | 100     | 500      | 1,000      |
| `allowComposites`     | `false` | `false` | `true`   | `true`     |

`maxTotalResolvedSize` bounds what one execution resolves in total: a stored value counts once, the first time it is resolved, and a concatenation of references counts every time it is built. A tool call whose arguments would go over it, or over `maxResolvedSize`, is refused (`REFERENCE_RESOLUTION_LIMIT`) and the handler is not called.

### Example with Sidecar

```typescript
const enclave = new Enclave({
  sidecar: {
    enabled: true,
    extractionThreshold: 100, // Store strings of 100 bytes and more
    allowComposites: false, // Refuse: ref + "suffix"
  },
  toolHandler: async (name, args) => {
    if (name === 'getLargeText') {
      // A 1MB string: stored in the sidecar, the script gets a token
      return 'x'.repeat(1024 * 1024);
    }
    if (name === 'saveText') {
      // args.text is the 1MB string again: the token was resolved
      return { saved: args.text.length };
    }
  },
});

const result = await enclave.run(`
  const text = await callTool('getLargeText', {});
  // text is a reference token here, not the data
  return await callTool('saveText', { text });
`);
```

### Concatenation

With `allowComposites: false` (the default at `STRICT` and `SECURE`), concatenating a reference token with anything throws inside the script: a token can only be passed on as it is.

```javascript
// Throws when allowComposites is false
const combined = ref + '-suffix';
```

With `allowComposites: true` (the default at `STANDARD` and `PERMISSIVE`), the concatenation yields a composite handle, and a tool that is passed the handle receives the concatenated text.

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
left): the call throws a `RangeError` in the script, and the function has not run. The check only
decides whether a function starts: it is never started halfway. It says nothing about a function
that did start. An async function that is still in progress when `toolCallGraceMs` is over is left
behind like a tool call, and `run()` ends without its result reaching the script.

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

A **regular expression** passed in `globals` can be read (`source`, `flags`, `global`, ...) but not
run: `test`, `exec` and its use as the pattern of `match`, `matchAll`, `replace`, `search` or `split`
throw, at every security level. A match would run the host's pattern on a text the script chooses,
outside the rules that apply to the script's own expressions, and with the `g` or `y` flag it writes
`lastIndex` on the host's object. Pass a function that does the matching, or let the script build
the expression from `source` and `flags` where the preset allows `RegExp`. The same goes for
`match`, `matchAll` and `search` on a `String` object (`new String(...)`) passed in `globals`;
a plain string is not affected.

A custom global cannot be named `Object`: the sandbox provides its own. The constructor throws.

With the single VM, an object of the script's own that a host built-in hands back to a callback
(the object a script gave `reduce` to collect into) stays the script's and stays writable. The
runtime recognises it by its prototype chain, which ends in the sandbox's `Object.prototype`. An
object without a prototype (`Object.create(null)`) carries nothing that says who made it and is
treated as the host's, so it arrives read-only in the callback: collect into `{}` or an array.

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
    code?: string; // Error code (e.g., 'VALIDATION_ERROR'; see "Error Codes")
    stack?: string; // Only for errors made outside the sandbox
    data?: Record<string, unknown>;
  };
  stats: {
    duration: number; // Execution time in ms
    toolCallCount: number; // Number of tool calls made
    iterationCount: number; // Number of loop iterations
    memoryUsage?: number; // Peak tracked memory in bytes (when memoryLimit is set)
    startTime: number;
    endTime: number;
  };
  scoringResult?: ScoringGateResult; // When a scoring gate evaluated the script
}
```

**`result.error` is plain, bounded text.** Whatever a script threw, `name` and `message` are strings: `name`
of at most 256 characters, `message` of at most 16,384. A thrown string is the message; a thrown `null`,
`undefined` or other primitive is named in the message (`The script threw null`); an object without a
string `message` is reported as `The script threw a value that is not an error`. An object a script makes
to look like the memory-limit error is not reported as one. The message of a validation failure is cut to
500 characters per issue and 32,768 in total; `error.data.issues` holds the issues.

**Errors made inside the sandbox have no `stack`.** No sandbox realm captures a stack trace, so
`error.stack` is `undefined` for the script and absent from `result.error` for what a script throws and
for what the runtime raises inside the sandbox (a limit, a failed tool call). This holds for the double VM
and the single VM, in process and in a worker. Errors the host makes outside a sandbox realm (an adapter
that fails, a worker pool error, an error of the `InterpreterAdapter`, which has no realm of its own) keep
their stack. With `sanitizeStackTraces` on (the default for `STRICT` and `SECURE`), such a stack is
sanitized, whichever stage raised the error: stack frames become `at [REDACTED]` and paths, URLs and file
locations in the remaining lines are redacted.

### Error Codes

| Code                                       | Description                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                         | AST validation failed, or the script is too large or not a string                                                                            |
| `SECURITY_VIOLATION`                       | The script contains a dynamic import (also with `validate: false`), or a blocked operation was recorded at `STRICT` or `SECURE`              |
| `SCORING_BLOCKED`                          | Refused by the scoring gate                                                                                                                  |
| `DOUBLE_VM_EXECUTION_ERROR`                | The script failed in the double VM (the default): an error it did not catch, a failed tool call, the tool-call or iteration limit, a timeout |
| `VM_EXECUTION_ERROR`                       | The same with `doubleVm: { enabled: false }`; with either VM, the timeout of a script that was only waiting                                  |
| `MEMORY_LIMIT_EXCEEDED`                    | `memoryLimit` exceeded                                                                                                                       |
| `SERIALIZATION_LIMIT_EXCEEDED`             | The returned value is larger than the memory limit allows                                                                                    |
| `EXECUTION_ERROR`                          | The adapter itself failed; with the worker pool `error.name` is the pool's error (`WorkerTimeoutError`, ...)                                 |
| `ENCLAVE_ERROR`                            | Any other failure outside the sandbox, such as a script with a syntax error                                                                  |
| `EXECUTION_TIMEOUT`, `STEP_LIMIT_EXCEEDED` | The timeout and the step budget of the `InterpreterAdapter`                                                                                  |

For the limits `error.message` says which one ended the script: `Script execution timed out ...`,
`Maximum iteration limit exceeded ...`, `Maximum tool call limit exceeded ...`.

### How `timeout` Is Enforced

- The time is the script's: the clock starts when the sandbox is ready to run it. Validation, the
  transform and the creation of the sandbox adapter (once per enclave; with the worker pool that
  starts the worker threads) come before it. Waiting for a free worker counts, and a script whose
  time has passed while it waited is not started: `run()` returns `ExecutionAbortedError`.
- Until the script's first `await`, Node's `vm` interrupts it at the deadline.
- After that, the script checks the clock itself: the transformer inserts a check at the start of
  every function and loop body and in front of a parameter default, so synchronous work, recursion
  and promise chains that never yield are stopped at the deadline as well. A script that catches
  the timeout error cannot enter another function or loop iteration. The deadline is cooperative:
  it is looked at between the steps of the script's own code.
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
  tool, a function from `globals` or the console, and it ends within a bounded number of steps:
  its next checks throw `Script execution has ended`.
- A script that only waits is ended as well. Waiting takes no code: a thenable that never calls
  back (`return { then: () => 0 }`) is enough, and nothing runs that could look at the clock. So
  the enclave keeps count of what the host has in flight for the script (tool calls, async
  functions from `globals`), and from the deadline on `run()` returns the timeout error as soon as
  that count is zero. A sandbox has no timers and no I/O, so nothing else could wake the script.
  (With `adapter: 'worker_threads'` the pool ends such a script like a busy one: with its worker,
  five seconds after the deadline.)
- Not covered: a single built-in call that does all its work natively, and a script run with
  `transform: false`. The engine finishes one call into a built-in before the next check, so its
  duration is bounded by the size of what it works on (which the memory limit bounds), not by
  `timeout`. And the enclave cannot stop your
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
│  Layer 0: Pre-Scanner (ast-guard, `standard` preset)        │
│  ├── Input size, line and string limits                     │
│  ├── Nesting depth limits                                   │
│  ├── ReDoS analysis of regex literals                       │
│  └── Refuses a fixed list of look-alike letters             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: AST Validation (ast-guard)                        │
│  ├── NoEvalRule - Blocks eval(), Function()                 │
│  ├── NoGlobalAccessRule - Blocks dangerous globals          │
│  ├── AllowedSyntaxRule - Syntax allowlist                   │
│  ├── UnknownGlobalRule - Only the allowed globals           │
│  └── ReservedPrefixRule - Blocks reserved prefixes          │
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
│  Layer 3: AI Scoring Gate (optional, heuristic)             │
│  ├── Features of the script's tool calls                    │
│  ├── Exfiltration-like tool sequences                       │
│  ├── Sensitive field names                                  │
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
│  ├── Returned values copied into plain data                 │
│  ├── Errors as bounded text, no stack from the sandbox      │
│  └── Refuses oversized return values                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Safe Execution Result                    │
└─────────────────────────────────────────────────────────────┘
```

### What the Pre-Scanner Checks

`Enclave` runs the validator's pre-scanner with its `standard` configuration, whatever the AST `preset` is. On the transformed script it refuses:

- more than 5 MB of text, more than 10,000 lines, a line of more than 10,000 characters, and a null byte;
- brackets nested more than 50 deep and more than 20 consecutive operators;
- a string literal of more than 500 KB, and more than 5 MB of string literals in total;
- more than 30 regular-expression literals, one of more than 500 characters, and one the ReDoS analysis rates as vulnerable (the `agentscript` preset then refuses every regular-expression literal anyway);
- one of a fixed list of letters that look like ASCII letters (Cyrillic and Greek look-alikes of `a`, `c`, `e`, `o`, `p`, `x`, `y`, and the full-width `a` and `e`), anywhere in the text.

It does not refuse bidirectional control characters or invisible characters. Those checks belong to the stricter pre-scanner presets of `@enclave-vm/ast` (`agentscript` and `strict` have both, `secure` the first), which a host can run on a script itself before it calls `run()`.

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
  `disableSandboxRejectionGuard(false)` turns it back on from the next execution of an enclave.
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
npx nx test core

# Run tests with coverage
npx nx test core --coverage
```

## Related Packages

- [`@enclave-vm/ast`](../ast) - AST validation rules used by enclave

## License

Apache-2.0
