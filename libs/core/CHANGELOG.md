# Changelog

All notable changes to `enclave-vm` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Interpreter adapter, call depth.** `maxCallDepth` (default 256) is counted along each chain of calls, not over the whole execution. The tasks of a `parallel` batch each continue the chain that started the batch, so a batch whose tasks call helper functions no longer adds up to the limit. A callback counts as a call of the function that invokes it (an array method, `parallel`, a bound function), and a chain keeps its depth across what it awaits.
- **Interpreter adapter, calls in progress.** New option `maxPendingCalls` (default 4096): how many calls of an execution may be unfinished at once, running or waiting, over all its chains. A script that goes over it gets `Too many calls in progress at once (4096)`. Before, the call depth was that bound too, at 256.

### Security

- **Interpreter adapter, property keys.** A property is read under a key of the script through one function that checks the key where the read happens, a write and a delete check it again, and `Object.prototype` and `Array.prototype` are never data a script may change (ATK-INTERP). These keys were refused before; nothing changes for a script. It closes the two code-scanning alerts on the interpreter.

### After 2.19.1: a review of every package

Draft for the maintainer. The invariants each item restores, and the tests that pin them, are listed by category in `SECURITY-TESTS.md`, which also lists what is still open.

#### Changed: what a host will notice

- **Options are checked.** A limit that is not a finite integer in its range (`Infinity` and `NaN` included), a switch that is not a boolean and an unknown security level throw a `TypeError` at construction. An option passed as `undefined` has the security level's value (ATK-CONFIG).
- **Errors made inside the sandbox have no `stack`.** No sandbox realm captures a stack trace, for the script and in `result.error` (ATK-MERR, ATK-STACK).
- **`result.error` is plain, bounded text.** `name` and `message` are strings whatever a script threw; a thrown `null`, `undefined` or primitive is reported as such; an object a script makes to look like the memory-limit error is not reported as one (ATK-THROWN).
- **A script has a maximum size** (5,242,880 characters; `VALIDATION_ERROR`, "too large"), checked before anything parses it, and the message of a validation failure is cut per issue and in total (ATK-RSRC).
- **`memoryLimit` counts arrays that grow.** No single array is larger than the limit holds (8 bytes per element), and what `push`, `unshift`, `splice`, `concat`, `flat`, `flatMap`, a spread literal and `Array.from` add is charged; `x += y` is charged like `x + y`. A copy is not charged, and objects, Maps and Sets are not counted: the limit is an estimate, see "Open invariants" (ATK-MEMACC).
- **Iteration limit.** A script that declares `__maxIterations` is refused; with validation off the limit still holds, because each loop is compared with a number in its own code (ATK-LCTR).
- **Timeout.** The deadline is also checked in front of a parameter default. What a script left behind when `run()` returned ends within a bounded number of steps; its rejection text is "Script execution has ended" (ATK-TIME).
- **Dynamic import.** With `validate: false` a script that contains `import()` or `import.meta` fails with `SECURITY_VIOLATION` before it runs (ATK-IMPORT).
- **A value that is referenced twice is returned twice.** The sanitizer of returned values, tool arguments and tool results took the second reference to any object for a circle and replaced it by the text `[Circular]`. Only an object that contains itself is one. Every copy counts against `maxSanitizeProperties` (ATK-SIZE).
- **Tool-call sequence detectors** see the calls of the window they ask for (up to 60 seconds), so a sequence whose calls are a few seconds apart is refused as documented (ATK-SEQ).
- **Tool namespaces.** A method or namespace named `then`, `toString`, `valueOf`, `toLocaleString` or `toJSON` is refused where the namespaces are declared (ATK-NSHOOK).
- **Worker pool.** A worker goes back into the pool only when it has confirmed that nothing of the last script is left in it; an execution the pool ends, ends its worker; the message rate is counted per execution; `maxMessageSizeBytes` is applied (`MessageSizeError`); memory a worker holds outside its heap counts against its budget while it executes (`WorkerMemoryError`; Node.js 22.16 or later); `dispose()` ends the executions in flight with `ExecutionAbortedError` (ATK-WORKER).
- **Interpreter adapter.** A script that computes past its timeout ends with `EXECUTION_TIMEOUT`; the work of a built-in counts as steps (`stats.iterationCount`, `maxSteps`); a function stored under a name the engine calls by itself (`then`, `toString`, `valueOf`, `toJSON`, `toLocaleString`, `toISOString`, and `join` on an array) is refused at the write; of an iterator only `next` can be called; a BigInt is limited to 1,048,576 bits and charged to the allocation budget; a text made by `+` is charged in full; the allocation limit cannot be caught. New: `InterpreterOptions.deadline`, `Interpreter.chargeAllocation`, `Interpreter.countBigInt` (ATK-INTERP-37 to 47).
- **Babel preset.** The message of a failed transform is at most 2,000 characters; `transformMultiple` refuses file names over 255 characters and lists each dependency once; a transform whose output is over the limit is refused before it is rewritten (ATK-BABEL).
- **Sidecar.** New `sidecar.maxTotalResolvedSize` (default twice `maxTotalSize`): what one execution resolves in total; over it a concatenation fails with `REFERENCE_RESOLUTION_LIMIT` (ATK-SIDECAR).
- **Scoring gate.** `FeatureExtractor.extract` throws `FeatureExtractionError` for text it cannot parse, and `failOpen` decides: with `failOpen: false` the gate blocks on every path where the scorer cannot answer. The gate of an enclave knows the enclave's tool namespaces (`toolNamespaces`), `customRules` takes effect, and `codeHash` is the whole SHA-256 digest (ATK-SCORE).
- **Sessions.** A tool result reaches the call it was submitted for; `wait()` returns one shared promise; the object from `pendingToolCall` no longer carries `resolve` / `reject`.

#### Security

- **Membrane, double VM.** An object a script passes to a built-in of host data is seen by that built-in through a guard, so a method of it never receives a host value raw (ATK-HVAL). A function of the script that is called through a value the runtime handed out receives the value the script holds; freezing such a value keeps its nested values behind the membrane; its prototype cannot be replaced (ATK-REACH).
- **Async context.** Nothing a script can reach on its own promises is an object of the host's `AsyncLocalStorage` context (Node.js 22); tool handlers, console handlers and functions from `globals` still run in the caller's context (ATK-ALS).
- **One reading of the script.** The transforms that run after validation parse the script with the goal the validator and the engine use (ATK-GOAL).
- **Computed keys.** The run-time key guard refuses the property names the validator refuses when they are written out (ATK-KGUARD).
- **Rejection guard.** It answers for promises of a sandbox only: a rejection that a promise library of the application reports for a promise type of its own reaches the application's listeners (ATK-REJECT).
- **Host work on script text is linear.** The tool-call detectors and the import scans of the Babel path cost time in proportion to their input (ATK-REDOS, ATK-BABEL).

## [2.19.0] - 2026-11-12

Draft for the maintainer: a security release. The invariants each item restores, and the tests that pin them, are listed by category in `SECURITY-TESTS.md`; nothing here says more than that file does.

### Security

- **Host process.** A promise rejection a script leaves unhandled no longer ends the host process, and is not shown to the application's `unhandledRejection` listeners (ATK-REJECT). The application's own rejections are handled as before.
- **Timeout.** `timeout` now also ends a script that only waits (for a thenable that never calls back, for a promise nobody settles): from the deadline on, `run()` returns the timeout error as soon as nothing the host started for the script is in flight. Before, `run()` did not settle. A tool call or async host function that is in flight is waited for, but no longer for ever: `toolCallGraceMs` after the deadline the execution ends whatever is in flight. Synchronous work after an `await` is stopped at the deadline as well (ATK-TIME).
- **After `run()` has returned.** What a script left behind (a tool call it did not await, with a `then` on it) can no longer call a tool, a function from `globals` or the console (ATK-TIME).
- **Custom globals.** The validation covers what a script reaches through a value: the methods and accessors of a class instance's class, a function in a property that is not enumerable or is keyed by a symbol, and a Proxy of an object. These passed before, whatever `allowFunctionsInGlobals` said.
- **A script at a full stack.** Every call into the runtime enters through a function of the script's own realm, so what a script catches there is never an object of another realm; a tool handler is started from an empty stack; code supplied by the application (functions in `globals`, a `consoleHandler`, the host console) is not started with the stack nearly full, so a host function either runs and returns to the script or is not started, and the host's output streams keep working (ATK-STACK).
- **Membrane.** No callable handed to a script has a host function in its target chain; what a script catches is a frozen safe error; a host function never receives a live script value; values passed in `globals` are read-only in the sandbox (ATK-REALM, ATK-MERR, ATK-GARG, ATK-HOSTW, ATK-HVAL, ATK-HCBK).
- **Single-VM adapter** (`doubleVm: { enabled: false }`). Its runtime is now built inside the sandbox realm: the standard library a script sees is the realm's own, nothing of the host's intrinsics is in the realm, and host values and functions sit behind a proxy of the realm (ATK-SVM).
- **Realm.** With the `agentscript` and `babel` presets only the allowed globals exist in the realm (`realmGlobals: 'allowlist'`); no bare name resolves through a prototype; scripts run in strict mode; regular expressions cannot run with the allowlist; the parent realm's intrinsics are frozen while a script runs (ATK-GLOBALS, ATK-THIS, ATK-RXRT, ATK-PLOCK).
- **Worker pool.** Inside a worker the script runs in the same sandbox as in process; tool calls go through the host's tool bridge and every message from a worker is checked; the worker's memory limit is enforced when a heap flag of the process replaces it; `maxWorkers` holds when executions start together; a disposed pool leaves nothing running; a worker with a memory limit has a bounded young generation, so that reaching the limit ends the worker and not, as it did in a few runs of a hundred under load, the process (ATK-WORKER).
- **Interpreter adapter.** Tool arguments and results are copies, the returned value is sanitized, the standard globals are stand-ins, allocation is bounded, and regular expressions are refused (ATK-INTERP).
- **Result path and sidecar.** The size check of a returned value is an upper bound and never calls into the value; a composite reference handle a script writes by hand is refused when composites are disabled (ATK-SIZE, ATK-SIDECAR).
- **Engine.** On V8 13.x (Node.js 24), compiled sandbox code is never shared between realms, which could crash the process. A process started with `node --no-sparkplug` does not have the code in question and keeps sharing (ATK-ENGINE).
- **Regular expressions of the host.** A regular expression passed in `globals` cannot be run from the sandbox, at any security level: neither `test` / `exec` nor as the pattern of a string method, and a `String` object passed in `globals` cannot be matched against a pattern of the script (`match`, `matchAll`, `search`). Its `lastIndex` is not written. The built-in methods the membrane withholds on host data (the ones that run a regular expression, the ones that change their receiver) are withheld on every read path, a property descriptor included (ATK-RXRT).
- **Tool-call limit, single VM.** A call is counted and checked against `maxToolCalls` where the script makes it, so the limit is exact when several calls are in flight together (ATK-BRIDGE).
- **Interpreter adapter, built-in calls.** A bound on what one built-in call may produce holds however the call is written (`call`, `apply`, `bind`, a method kept in a variable); a built-in method only works on the kind of value it belongs to; converting an array to text, a replacement pattern, `concat`, `flat`, `split` and indented `JSON.stringify` output are bounded, and what `JSON.parse` builds is charged before it is built. A built-in used as the callback of an array method or of `parallel` gets the checks of a direct call; a function of the script used there is called as before (ATK-INTERP).
- **Size check.** A `Map`, a `Set` and a regular expression are measured as what they are copied into (ATK-SIZE).
- **Worker pool.** A script whose execution ended while it waited for a worker is never started; an execution that queued behind a worker that failed to start is told at once. A pool whose warm-up failed leaves no worker running (ATK-WORKER).

### Changed

- Values passed in `globals` are read-only in the sandbox, in the single VM as in the double VM: assignments and mutating built-in methods throw (they are ignored at `PERMISSIVE`).
- A console call a script makes with less than 128 KB of stack left does not reach a `consoleHandler` (the line is dropped) and throws a `RangeError` with the host console; a function from `globals` called there throws a `RangeError` and has not run.
- The enclave wraps `process.emit` the first time a sandbox is used, to answer `unhandledRejection` and `rejectionHandled` for promises that are not of the host realm. `disableSandboxRejectionGuard()` turns this off.
- In the sandbox, `Symbol.for` refuses keys in the `nodejs.` namespace.
- `run()` on a script that is still waiting at the deadline now resolves with `Script execution timed out after <timeout>ms`. A tool call in progress at the deadline still delivers, for `toolCallGraceMs` (default: the value of `timeout`, so `run()` takes at most twice `timeout`); after that `run()` returns the same error with `error.data.pendingHostCalls`, and the handler's promise is left to settle. `toolCallGraceMs: Infinity` restores the previous behaviour, in which a handler that never settles keeps `run()` waiting.
- `globals`: an instance of a class with methods needs `allowFunctionsInGlobals: true`; an instance of a class with getters or setters, a `Buffer`, and a Proxy of an object are refused. An instance of a class without methods or accessors is still accepted (not where `secureProxyConfig.blockConstructor` is off).
- When `run()` returns, the execution is aborted: a tool call the script started and did not await still completes in the host, but nothing the script does afterwards reaches the host.
- With the worker pool, an execution that is still running five seconds after its timeout is ended by terminating its worker (`WorkerTimeoutError`); pool statistics report the workers' memory.
- A worker with `memoryLimitPerWorker` has a young generation of 24 MB (it was the engine's default: 192 MB on Node.js 24, 48 MB on Node.js 22), so the most it can hold is its limit plus 24 MB.
- The interpreter adapter hands tools JSON copies, fails an execution that returns a function, and has an allocation budget. With a `consoleHandler` it gives the script a `console`, under the same `maxConsoleCalls` and `maxConsoleOutputBytes` as the VM adapters.
- A regular expression passed in `globals` can be read (`source`, `flags`) but not run; a custom global cannot be named `Object` (the constructor throws).
- With the AgentScript preset, `match`, `matchAll` and `search` on a custom global that is a string are refused like on any string of the script. On a tool namespace, and on a custom global that is an object or a function, a method of that name is the host's and is accepted with any argument.
- With the single VM, a host built-in called with a callback (`reduce`, `forEach`, ...) hands the script's own objects back as they are: an accumulator the script created stays writable. Host values are behind the membrane as before.
- With the single VM, calls beyond `maxToolCalls` are refused one by one where they are made; the calls within the limit run, also when all of them were made before the first one started.
- Interpreter adapter: array methods need an array and string methods a string as their receiver; one call makes at most 1,000,000 array items and 16,000,000 chars of text from an array; `maxSanitizeDepth` and `maxSanitizeProperties` apply as configured (they were clamped to 5-50 and 50-1000).
- Worker pool metrics: `memoryKills` also counts a worker the engine ended at its heap limit.
- Interpreter adapter used without an `Enclave`: a context that sets no `maxSanitizeDepth` / `maxSanitizeProperties` gets the sanitizer's defaults (20 and 10,000), as with the double VM.
- With the single VM, an object without a prototype that a script passes through a host built-in arrives read-only in the callback (it cannot be told from a host object); collect into `{}` or an array.
- The `timeout` clock starts when the sandbox adapter is ready, not before it is created: the first `run()` of an enclave with the worker pool no longer spends its time starting the workers. With the pool, a script whose time has passed while it waited for a worker is not started (`ExecutionAbortedError`).
- Cost, measured with a small script that makes one tool call (arm64): 5.9 ms per execution with the double VM on Node.js 24 and 2.7 ms on Node.js 22; 2.9 ms and 1.6 ms with the single VM. A call into the runtime checks the stack first (about 2.7 microseconds); a call into a host function or the console about 5.5.

### Added

- `disableSandboxRejectionGuard()` and `isHostPromise()`.
- `toolCallGraceMs`.
- `realmGlobals` (`'allowlist' | 'security-level'`).
- `SECURITY-TESTS.md`: the catalog of security tests by layer and invariant, with the rules for changing the sandbox. The tests themselves are in a private repository (see the root changelog).

### Known limits

- Node.js prints to the process's stderr when a promise is rejected while the stack is full; a script can cause that output, and nothing in JavaScript can intercept it (see "A script at a full stack" in the README).
- The enclave cannot stop a tool handler: a call it stops waiting for at `timeout + toolCallGraceMs` keeps running in the host.
- A script run with `transform: false` is not stopped by the cooperative deadline check.

## [2.7.0] - 2026-01-09

### Added

- Introduced a JSON-based tool bridge with configurable modes and payload limits, exposed via the new `toolBridge` option on `EnclaveConfig`.
- Added serialized size estimators (`estimateSerializedSize`/`checkSerializedSize`) and enforce them before returning sandbox values when a memory limit is configured.

### Changed

- Enclave construction now normalizes `toolBridge` settings and requires explicit acknowledgement before enabling insecure direct bridging.

### Security

- `Array.prototype.fill` is now memory-tracked inside both VM adapters to block sparse-array exhaustion attacks.
- Return paths reject values whose serialized size would exceed the configured memory limit, preventing Vector 340 serialization amplification.
- All host-generated errors now go through centralized `createSafeError`, severing prototype chains and stripping host stack details.
- String-mode tool bridge validates JSON payloads, enforces payload caps, sanitizes arguments/results, and updates tool-call stats before invoking host handlers.

## [2.6.0] - 2026-01-08

### Added

- Stack-trace hardening scripts now run in both the single-VM adapter and worker pool so sandboxed errors only return redacted frames, and a new sanitizeStackTraces option is propagated through the double-VM bootstrap (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts).
- STRICT/SECURE executions now record code-generation attempts via policy-violation reporters and return SecurityViolationError payloads when user code suppresses the original throw (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/adapters/worker-pool/worker-script.ts, libs/enclave-vm/src/double-vm/double-vm-wrapper.ts).
- Local LLM scoring exposes the DISABLE_MODEL_LOAD_ENV constant, honors ENCLAVE_DISABLE_LOCAL_LLM_MODEL=1, and defaults its cache under ~/.enclave/models for better operator control (libs/enclave-vm/src/scoring/scorers/index.ts, libs/enclave-vm/src/scoring/scorers/local-llm.scorer.ts).

### Changed

- User-provided globals, safe runtime helpers, and console bridges are now installed as non-enumerable, non-configurable descriptors to block Object.assign/Object.values reconnaissance in the sandbox (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts).
- Safe runtime utilities and tool bridge errors are wrapped with prototype-severing helpers so attacker code cannot reach Function via error.constructor.constructor (libs/enclave-vm/src/double-vm/double-vm-wrapper.ts, libs/enclave-vm/src/safe-runtime.ts).

### Fixed

- DoubleVmWrapper now surfaces MemoryLimitError data emitted from sandbox-side tracking so callers receive accurate used/limit bytes even when the sandbox throws its own payload (libs/enclave-vm/src/double-vm/double-vm-wrapper.ts).

### Security

- MemoryTracker enforcement now tracks cumulative allocations made through patched repeat/join/pad helpers by delegating to a host-side callback, preventing incremental heap exhaustion (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts).
- Sandbox stack traces have their formatters locked and frames redacted to avoid leaking host file paths or line numbers (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts).
- STRICT/SECURE modes fail closed whenever the sandbox attempts code generation or other blocked operations, even if user code catches the initial exception (libs/enclave-vm/src/adapters/vm-adapter.ts, libs/enclave-vm/src/adapters/worker-pool/worker-script.ts, libs/enclave-vm/src/double-vm/double-vm-wrapper.ts).

## [2.5.0] - 2026-01-07

### Added

- Serialized worker protocol now carries a `securityLevel` flag so worker-pool executions mirror the AST guard preset in use.
- Worker sandbox utilities now derive security-level-specific global maps and the Enclave validator pulls its base allow list from `getAgentScriptGlobals` before appending custom globals.

### Changed

- `serializeError` now tolerates string throws from transformed loop guards before sanitizing stack traces.

### Security

- Sandbox creation now exposes only the globals permitted for the selected security level, removing constructors like `console`, `Promise`, or `RegExp` under stricter tiers for defense-in-depth.
- Double-VM bootstrap instantiates safe objects using inner-context intrinsics, makes the injected `__host_vm_module__` removable, and nulls `vm.createContext`/`vm.Script` before user code executes.

## [2.4.0] - 2026-01-06

### Added

- When a memoryLimit is configured the VM patches String.repeat/pad\* and Array.join before execution so they enforce quotas and throw MemoryLimitError instead of allocating unbounded buffers (libs/enclave-vm/src/adapters/vm-adapter.ts:547-632; libs/enclave-vm/src/memory-proxy.ts:45-195).
- Double VM hosts now propagate memoryLimit metadata into the parent/inner bootstrap so the same pre-allocation guards run inside nested sandboxes (libs/enclave-vm/src/double-vm/double-vm-wrapper.ts:205-246; libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts:776-870).

### Changed

- AgentScript validation now happens before the sidecar/memory transforms so constructor obfuscation is caught before \_\_safe_concat instrumentation alters the AST (libs/enclave-vm/src/enclave.ts:304-354).

### Security

- Sandbox contexts install a SafeObject that strips defineProperty/defineProperties/setPrototypeOf/getOwnPropertyDescriptor(s) to block serialization hijacks and prototype pollution attacks (libs/enclave-vm/src/adapters/vm-adapter.ts:275-360).
- All VM entry points disable codeGeneration for strings/wasm and expand the set of removed Node.js 24 globals (Function, eval, Proxy, SharedArrayBuffer, WeakRef, etc.), closing multiple escape vectors (libs/enclave-vm/src/adapters/vm-adapter.ts:549-636; libs/enclave-vm/src/adapters/worker-pool/worker-script.ts:135-161; libs/enclave-vm/src/double-vm/double-vm-wrapper.ts:205-246; libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts:55-120,776-870).

## [2.3.0] - 2026-01-06

### Added

- Expose configurable rapid-enumeration thresholds and per-operation overrides to the double VM validator so enumeration detection can be tuned per workload.
- Propagate the `__maxIterations` runtime global through the worker pool, safe runtime, and parent VM bootstrap to enforce ast-guard’s loop iteration limits.
- Local LLM scorer now accepts a `customAnalyzer` plug-in, enabling external LLMs or static analyzers to provide risk signals.

### Changed

- Validation failures now deduplicate issues and include line numbers for clearer error reporting.
- Rapid-enumeration suspicious-pattern detection now uses the configurable thresholds/overrides when evaluating tool call history.
- Keyword-based scoring heuristics were refined and the scorer cleanup path now disposes custom analyzers.

### Fixed

- Double VM wrapper now normalizes thrown string errors (e.g., loop limit violations) so sandbox failures return structured execution errors.

## [2.2.0] - 2026-01-05

### Added

- Integrated the new `MemoryTracker` across the VM and double-VM adapters so executions that opt into `memoryLimit` report `stats.memoryUsage` and raise `MemoryLimitError` responses with `MEMORY_LIMIT_EXCEEDED` metadata.
- Re-exported `MemoryTracker`, `MemoryLimitError`, and estimation helpers for host code, and injected memory-aware String/Array proxies plus `__safe_*` console/Error globals into the sandbox for AST transformer compatibility.

### Changed

- STRICT/SECURE/STANDARD security levels now throw a `SecurityError` whenever blocked properties such as `constructor` or `__proto__` are accessed; override `secureProxyConfig.throwOnBlocked` to restore silent `undefined` returns.
- Worker pool slots only set `--max-old-space-size` when a memory budget is configured and resolve the compiled worker script path when running from TS sources, keeping the adapter compatible with Node 24 and ts-jest.
- Safe runtime concatenation and template literal helpers now distinguish numeric addition from string composites, track allocations, and route reference IDs through the resolver for accurate memory accounting.

### Fixed

- Worker scripts automatically invoke the transformed `__ag_main()` entrypoint and expose both `console` and `__safe_console`, ensuring AgentScript-transformed bundles run under the worker adapter.

## [2.1.0] - 2026-01-05

### Added

- Default double VM layer with parent/inner VMs, operation validation, rate limiting, and suspicious-pattern detection (`libs/enclave-vm/src/double-vm/**/*`).
- Configurable `doubleVm` options plus exported `DoubleVmConfig`/`ParentValidationConfig` so callers can tune the parent validation stage (`libs/enclave-vm/src/types.ts`, `libs/enclave-vm/src/enclave.ts`).
- AST validation preset selection via the new `preset` option covering agentscript/strict/secure/standard/permissive modes (`libs/enclave-vm/src/enclave.ts`, `libs/enclave-vm/src/index.ts`).
- Reference helpers such as `BlockedPropertyCategory` and `REF_ID_SUFFIX` are now exported for consumers that integrate with the reference sidecar (`libs/enclave-vm/src/types.ts`, `libs/enclave-vm/src/sidecar/reference-config.ts`).

### Changed

- **Breaking:** `Enclave` now routes execution through the double VM wrapper by default and only falls back to raw adapters when `doubleVm.enabled` is set to false (`libs/enclave-vm/src/enclave.ts`).
- Custom globals injected into the VM are automatically wrapped in secure proxies to block prototype-chain attacks (`libs/enclave-vm/src/adapters/vm-adapter.ts`).
- `clearProxyCache()` now throws to make it clear the API is unsupported and unnecessary (`libs/enclave-vm/src/secure-proxy.ts`).

### Removed

- Removed the unused `allowFunctionBinding` option from `SecureProxyOptions`; function binding is always handled by the proxy rules (`libs/enclave-vm/src/secure-proxy.ts`).

### Fixed

- Pattern serialization and suspicious-pattern plumbing now reject unsafe detector bodies, handle `JSON.stringify` failures, and preserve error causes when bubbling through the parent VM (`libs/enclave-vm/src/double-vm/suspicious-patterns.ts`, `libs/enclave-vm/src/double-vm/double-vm-wrapper.ts`).

### Security

- Parent VM suspicious-pattern detectors block data exfiltration, enumeration, credential leaks, and bulk operations before tool calls reach the host (`libs/enclave-vm/src/double-vm/suspicious-patterns.ts`, `libs/enclave-vm/src/double-vm/parent-vm-bootstrap.ts`).

## [2.0.0] - 2026-01-04

### Added

- Introduced the `DoubleVmWrapper`, parent bootstrap generator, suspicious-pattern serializers, and adapter wrapper so user code now runs inside parent+inner VMs with strict tool-call validation and sanitized host proxies (`libs/enclave-vm/src/double-vm/**/*.ts`).
- Exposed the `doubleVm` configuration plus reusable `DoubleVmConfig`/`ParentValidationConfig` defaults so callers can tune the new layer (`libs/enclave-vm/src/types.ts:842-918`).

### Changed

- **Breaking:** `Enclave` always routes execution through the double VM wrapper unless you explicitly disable it, so adapter selections only apply after opting out of the new layer (`libs/enclave-vm/src/enclave.ts:259-563`).
- Tool calls now flow through the parent VM proxy that resolves reference handles, sanitizes values, and redacts stack traces before returning to the host (`libs/enclave-vm/src/double-vm/double-vm-wrapper.ts:82-224`).

### Removed

- **Breaking:** Removed the unused `allowFunctionBinding` toggle from `SecureProxyOptions`; function binding is now managed entirely inside the secure proxy (`libs/enclave-vm/src/secure-proxy.ts:254-260`).

### Security

- Built-in suspicious-pattern detectors now block common exfiltration, enumeration, and credential-leak sequences before tool calls reach the host (`libs/enclave-vm/src/double-vm/suspicious-patterns.ts:1-304`).

### Added

- **Double VM Layer**: New security layer providing defense-in-depth through nested VM isolation
  - `doubleVm` configuration option in `CreateEnclaveOptions`
  - Operation validation with whitelist/blacklist patterns
  - Rate limiting for enumeration attack prevention
  - Suspicious pattern detection (exfiltration, credential theft, bulk operations)
- **BlockedPropertyCategory**: Type export for categorized property blocking
- **REF_ID_SUFFIX**: New constant for reference ID construction (complements REF_ID_PREFIX)

### Changed

- **BREAKING**: `clearProxyCache()` now throws an error instead of being a silent no-op
  - Migration: Remove calls to this deprecated function - WeakMap/WeakSet entries are automatically garbage collected
- **BREAKING**: Removed `allowFunctionBinding` option from `SecureProxyOptions`
  - Migration: This option was never implemented - remove from any custom configurations
- Sanitization limits (`maxDepth`, `maxProperties`) now respect security level configuration instead of using hardcoded values

### Fixed

- Code injection validation added to `generatePatternDetectorsCode` to detect dangerous patterns in custom detectors
- JSON.stringify circular reference handling in BULK_OPERATION pattern detector
- Error cause preservation in tool call proxy for better debugging
- Console assignment in parent VM now uses Object.defineProperty for consistency

## [1.0.2] - 2025-12-12

### Changed

- Declared @huggingface/transformers as an optional peer dependency so it is only required when local scoring is enabled.

### Fixed

- LocalLlmScorer now imports @huggingface/transformers via a dynamic Function() call, preventing TypeScript and bundler failures when the optional dependency is absent.

### Changed

- Updated the documented cache directory default for `LocalLlmConfig` to `~/.enclave/models`

## [1.0.0] - 2025-11-30

### Added

- Initial release
- Secure AgentScript execution environment
- Sandboxed VM with controlled API exposure
- Built-in scoring system for AI-generated code
- Integration with ast-guard for code validation
- Local LLM support for offline scoring
