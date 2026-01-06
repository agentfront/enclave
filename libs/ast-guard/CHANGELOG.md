# Changelog

All notable changes to `@anthropic/ast-guard` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-01-06

### Added

- `for`/`while`/`do-while` loops are now transformed with injected iteration counters that enforce the runtime `__maxIterations` limit instead of being rejected outright.
- Agentscript preset now allows the `__maxIterations` global and ships a new `InfiniteLoopRule` that flags obvious infinite-loop syntax.

### Changed

- Loop guards throw a string error when the iteration ceiling is exceeded, so host runtimes must expose `__maxIterations` for transformed scripts to run.

## [1.1.2] - 2026-01-05

### Fixed

- Template literal transforms now skip tagged template expressions so tag functions continue receiving the original raw template strings.

## [1.1.0] - 2025-12-11

### Added

- AgentScript preset now blocks structuredClone, AbortController/AbortSignal, MessageChannel/MessagePort, BroadcastChannel, TextEncoder/TextDecoder, and Intl before code hits runtime (libs/ast-guard/src/presets/agentscript.preset.ts:292).
- AgentScript preset treats queueMicrotask as a disallowed timer primitive to mitigate microtask flooding attacks (libs/ast-guard/src/presets/agentscript.preset.ts:311).

### Security

- NoEvalRule now reports dynamic import() expressions so untrusted code cannot lazy-load modules (libs/ast-guard/src/rules/no-eval.rule.ts:4).

## [1.0.0] - 2025-01-23

### Added

- **Security Presets**: Pre-configured security levels for quick setup
  - `STRICT`: Maximum security (bank-grade) - blocks all dangerous patterns, loops, and async
  - `SECURE`: High security - blocks most dangerous patterns with some flexibility
  - `STANDARD`: Medium security - sensible defaults for most use cases
  - `PERMISSIVE`: Low security - minimal restrictions, only blocks eval
- New `Presets` object with factory functions for each security level
- `createPreset()` function to create presets by level
- Individual preset functions: `createStrictPreset()`, `createSecurePreset()`, `createStandardPreset()`, `createPermissivePreset()`
- Comprehensive preset customization via `PresetOptions` interface
- Support for overriding loop restrictions, async settings, and blocked identifiers
- Built-in API enforcement for required functions and argument validation
- 75+ new tests covering all preset configurations and real-world scenarios
- Extensive README documentation with preset usage examples and comparison matrix

### Changed

- Reorganized preset system into separate files in `src/presets/` directory for better maintainability
- Enhanced type safety by importing `FunctionArgumentConfig` from validation rules

### Security

- **Bank-Level Security Enhancements**: STRICT preset now blocks 90+ dangerous identifiers for maximum protection

  - **Prototype Manipulation**: Blocks `Object`, `Array`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `constructor`, `__proto__`, `prototype`
  - **Error Stack Manipulation**: Blocks all Error types (`Error`, `TypeError`, `ReferenceError`, `SyntaxError`, etc.) to prevent stack trace exploitation
  - **Reflection & Metaprogramming**: Blocks `Proxy` and `Reflect` to prevent property interception and manipulation
  - **Async Primitives**: Blocks `Promise` to prevent timing attacks and race conditions
  - **Pattern Matching**: Blocks `RegExp` to prevent ReDoS (Regular Expression Denial of Service) attacks
  - **Binary Data**: Blocks all TypedArrays, `ArrayBuffer`, `SharedArrayBuffer`, `DataView` to prevent memory manipulation
  - **WebAssembly**: Blocks `WebAssembly` to prevent native code execution
  - **Workers**: Blocks `Worker`, `SharedWorker`, `ServiceWorker` to prevent sandbox escape
  - **Internationalization**: Blocks `Intl` to prevent system information leakage
  - **Atomics**: Blocks `Atomics` to prevent `SharedArrayBuffer` manipulation
  - **Collections**: Blocks `Map`, `Set`, `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry` to prevent memory leaks and prototype pollution
  - **Dates & JSON**: Blocks `Date` (timing attacks) and `JSON` (circular reference attacks)
  - **Browser APIs**: Blocks `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `crypto`, `performance`
  - **Timers**: Blocks `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`
  - **Dynamic Loading**: Blocks `importScripts` (note: `import` keyword handled by parse errors in script mode)

- **Advanced Attack Detection Tests**: 35 comprehensive tests covering sophisticated attack vectors
  - Property access obfuscation (computed properties, string concatenation, template literals, Unicode escapes)
  - Prototype pollution (Object/Array/Symbol prototype manipulation)
  - Function construction bypasses (AsyncFunction, GeneratorFunction)
  - Sandbox escapes (Error stack manipulation, constructor chains)
  - Promise-based code execution and timing attacks
  - Symbol-based property access attacks
  - Proxy-based interception attacks
  - RegExp DoS (ReDoS) patterns
  - Memory exhaustion attacks
  - WebAssembly exploitation
  - Import/dynamic import detection (parse errors in script mode)
  - Worker-based isolation bypass
  - toString/valueOf manipulation
  - Getter/setter traps
  - Comprehensive bank-level lockdown validation
