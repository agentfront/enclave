# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
