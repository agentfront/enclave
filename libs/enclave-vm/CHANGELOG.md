# Changelog

All notable changes to `enclave-vm` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.1] - 2026-01-08

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
