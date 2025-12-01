# Changelog

All notable changes to `@anthropic/enclave` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
