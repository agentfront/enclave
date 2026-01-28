# Changelog

All notable changes to the Enclave monorepo will be documented in this file.

For detailed changes to individual packages, see their respective changelogs:

- [enclave-vm](libs/enclave-vm/CHANGELOG.md)
- [ast-guard](libs/ast-guard/CHANGELOG.md)

## [Unreleased]

## [2.8.0] - 2026-01-28

## 2026-01-09

Security-focused updates to enclave-vm plus a new AST Guard option for controlled Array.fill usage.

| Package    | Version | Highlights                                                                                    |
| ---------- | ------- | --------------------------------------------------------------------------------------------- |
| enclave-vm | 2.7.0   | Adds the JSON tool bridge, serialized size enforcement, and multiple security hardenings.     |
| ast-guard  | 2.4.0   | Adds the allowDynamicArrayFill option to the resource exhaustion rule and AgentScript preset. |

## 2026-01-08

Security-hardening release with stricter enclave VM sandboxing and new AST guards against JSON callback walkers.

| Package    | Version | Highlights                                                                                                                                      |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| enclave-vm | 2.6.0   | Introduced stack-trace sanitization controls, policy-violation reporting, and safer error/memory handling across single and double VM adapters. |
| ast-guard  | 2.3.0   | Added the JSON callback guard and expanded resource-exhaustion detection in the AgentScript preset.                                             |

## 2026-01-07

Security-focused release aligning enclave sandbox globals with AST guard while hardening regex analysis and namespace sanitization.

| Package    | Version | Highlights                                                                                     |
| ---------- | ------- | ---------------------------------------------------------------------------------------------- |
| enclave-vm | 2.5.0   | Sandbox now enforces security-level-specific globals and the double-VM bootstrap was hardened. |
| ast-guard  | 2.2.0   | Introduced security-level-aware AgentScript globals plus safer regex pre-scanning.             |

## 2026-01-06

Sandbox security was hardened in enclave-vm and ast-guard now blocks resource-exhaustion patterns by default.

| Package    | Version | Highlights                                                                                      |
| ---------- | ------- | ----------------------------------------------------------------------------------------------- |
| enclave-vm | 2.4.0   | Blocks Function/eval/Object.\* attacks and adds pre-allocation memory guards for all sandboxes. |
| ast-guard  | 2.1.0   | Ships the new ResourceExhaustionRule and enables it in the AgentScript preset.                  |

## 2026-01-06

Enhanced enclave-vm loop safety and scoring extensibility while ast-guard introduces guarded loop support requiring the new \_\_maxIterations runtime hook.

| Package    | Version | Highlights                                                                                                                                             |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| enclave-vm | 2.3.0   | Adds configurable rapid-enumeration thresholds, exposes the loop-iteration runtime hook, and allows custom analyzers in the local LLM scorer.          |
| ast-guard  | 2.0.0   | Transforms loops with iteration counters, requires runtimes to provide `__maxIterations`, and adds an InfiniteLoopRule for obvious endless constructs. |

## 2025-12-12

Transformer-dependent features now load Hugging Face models lazily with optional peer dependency.

| Package    | Version | Highlights                                                       |
| ---------- | ------- | ---------------------------------------------------------------- |
| enclave-vm | 1.0.2   | LocalLlmScorer lazy-loads transformers, optional peer dependency |

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
| enclave-vm | 1.0.0   | Secure AgentScript execution environment           |
