# Changelog

All notable changes to the Enclave monorepo will be documented in this file.

For detailed changes to individual packages, see their respective changelogs:

- [enclave-vm](libs/enclave-vm/CHANGELOG.md)
- [ast-guard](libs/ast-guard/CHANGELOG.md)
- [vectoriadb](libs/vectoriadb/CHANGELOG.md)

## [Unreleased]

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
