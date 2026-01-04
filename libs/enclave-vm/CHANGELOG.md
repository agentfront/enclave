# Changelog

All notable changes to `@anthropic/enclave` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
