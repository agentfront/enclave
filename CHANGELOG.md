# Changelog

All notable changes to the Enclave monorepo will be documented in this file.

For detailed changes to individual packages, see their respective changelogs:

- [enclave-vm](libs/enclave-vm/CHANGELOG.md)
- [ast-guard](libs/ast-guard/CHANGELOG.md)
- [vectoriadb](libs/vectoriadb/CHANGELOG.md)

## [Unreleased]

## 2026-01-06

Enhanced enclave-vm loop safety and scoring extensibility while ast-guard introduces guarded loop support requiring the new \_\_maxIterations runtime hook.

| Package    | Version | Highlights                                                                                                                                             |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| enclave-vm | 2.3.0   | Adds configurable rapid-enumeration thresholds, exposes the loop-iteration runtime hook, and allows custom analyzers in the local LLM scorer.          |
| ast-guard  | 2.0.0   | Transforms loops with iteration counters, requires runtimes to provide `__maxIterations`, and adds an InfiniteLoopRule for obvious endless constructs. |

## 2026-01-05

enclave-vm now ships memory-aware execution limits and stricter secure proxy errors, while ast-guard fixes template literal handling.

| Package    | Version | Highlights                                                                                        |
| ---------- | ------- | ------------------------------------------------------------------------------------------------- |
| enclave-vm | 2.2.0   | Adds MemoryTracker-based limits and makes blocked-property access raise explicit security errors. |
| ast-guard  | 1.1.2   | Template literal transform no longer rewrites tagged templates.                                   |

## 2026-01-05

Defaulted enclave-vm to the new double VM isolation layer and refreshed docs for the surrounding APIs.

| Package    | Version | Highlights                                                                                                               |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| enclave-vm | 2.1.0   | Double VM wrapper is now the default execution path with configurable parent validation and suspicious-pattern blocking. |

## 2026-01-04

Major enclave-vm update introducing the default double VM isolation layer with operation validation.

| Package    | Version | Highlights                                                                |
| ---------- | ------- | ------------------------------------------------------------------------- |
| enclave-vm | 2.0.0   | Double VM wrapper default, nested isolation, suspicious-pattern detection |

## 2025-12-12

Transformer-dependent features now load Hugging Face models lazily with optional peer dependency.

| Package    | Version | Highlights                                                       |
| ---------- | ------- | ---------------------------------------------------------------- |
| enclave-vm | 1.0.2   | LocalLlmScorer lazy-loads transformers, optional peer dependency |
| vectoriadb | 2.0.0   | EmbeddingService dynamic loading, injection hooks, optional peer |

## 2025-12-11

Hardened ast-guard AgentScript preset with additional browser primitive blocks.

| Package   | Version | Highlights                                                      |
| --------- | ------- | --------------------------------------------------------------- |
| ast-guard | 1.1.0   | Blocks structuredClone/messaging APIs, queueMicrotask, import() |

## 2025-11-30

Initial release of the Enclave monorepo.

| Package    | Version | Highlights                                         |
| ---------- | ------- | -------------------------------------------------- |
| ast-guard  | 1.0.0   | AST-based JavaScript validator with CVE protection |
| vectoriadb | 1.0.0   | In-memory vector database for semantic search      |
| enclave-vm | 1.0.0   | Secure AgentScript execution environment           |
