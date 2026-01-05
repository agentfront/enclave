# Changelog

All notable changes to `@anthropic/enclave` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-01-05

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
