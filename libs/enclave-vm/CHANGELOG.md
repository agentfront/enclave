# Changelog

All notable changes to `@anthropic/enclave` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
