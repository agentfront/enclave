# Changelog

All notable changes to `vectoriadb` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.2] - 2026-01-07

### Fixed

- Regex vulnerability detection now trims analyzed patterns to 500 characters and evaluates them through bounded helper regexes to avoid the analyzer triggering ReDoS.
- Redis namespace sanitization bounds the namespace prior to regex processing and swaps in precompiled `SAFE_PATTERNS` to strip control characters and unsafe symbols deterministically.

### Security

- Hardened both the regex analyzer and namespace sanitizer so untrusted input can no longer leverage those code paths for ReDoS attacks.

## [2.0.0] - 2025-12-12

### Added

- Added EmbeddingService.setTransformersModule() and clearTransformersModule() to allow injecting custom transformer pipelines (primarily for testing).

### Changed

- Transformer embeddings now lazy-load @huggingface/transformers and emit a ConfigurationError with installation guidance when the package is not installed.
- @huggingface/transformers is now distributed as an optional peer dependency and must be added explicitly when using transformer embeddings.

## [1.0.0] - 2025-11-30

### Added

- Initial release
- In-memory vector database for semantic search
- Cosine similarity and Euclidean distance metrics
- Namespace support for multi-tenant use cases
- Configurable embedding dimensions
- Efficient nearest neighbor search
