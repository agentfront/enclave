# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-01-04

Major enclave-vm update introducing the default double VM isolation layer with new validation capabilities.

### Updated Libraries

- **enclave-vm** v2.0.0 - Double VM wrapper is now the default runtime, adding nested VM isolation plus suspicious-pattern enforcement.

## [2.0.0] - 2025-12-12

Transformer-dependent features now load Hugging Face models lazily, with enclave-vm fixing its scorer import path and vectoriadb requiring explicit opt-in for transformer embeddings.

### Updated Libraries

- **enclave-vm** v1.0.2 - LocalLlmScorer lazily imports @huggingface/transformers and treats it as an optional peer dependency.
- **vectoriadb** v2.0.0 - EmbeddingService now loads transformers dynamically, adds injection hooks, and requires you to install the optional peer when using transformer embeddings.

## [1.1.0] - 2025-12-11

Hardened ast-guard’s AgentScript preset with additional browser primitive blocks and dynamic import enforcement.

### Updated Libraries

- **ast-guard** v1.1.0 - AgentScript preset now blocks structuredClone/messaging APIs, queueMicrotask, and import() expressions for parity with the Enclave sandbox.

### Changed

- Updated the documented cache directory default for `LocalLlmConfig` to `~/.enclave/models` in `libs/enclave-vm/src/scoring/types.ts:377` to match the new Enclave pathing.
- Added Local LLM scoring guidance (including the new cacheDir default) to the library docs in `docs/live/docs/libraries/enclave.mdx:96` and `docs/draft/docs/libraries/enclave.mdx:96`.

## [1.0.0] - 2025-11-30

### Added

- Initial release of the Enclave monorepo
- Migrated `ast-guard`, `vectoriadb`, and `enclave-vm` from FrontMCP monorepo
- Set up Nx workspace with independent versioning for ast-guard and vectoriadb
- Set up synchronized versioning for enclave-vm
- CI/CD workflows for build, test, and publish

### Libraries Included

- **ast-guard** v1.0.0 - AST-based JavaScript validator with 100% CVE protection
- **vectoriadb** v1.0.0 - In-memory vector database for semantic search
- **enclave-vm** v1.0.0 - Secure AgentScript execution environment
