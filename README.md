<div align="center">

# Enclave

**Secure JavaScript execution and vector search libraries for AI agents**

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

</div>

---

## Overview

Enclave is a monorepo containing security-focused libraries for building safe AI agent systems:

| Library                             | Description                                                    | Version                                                                                         |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [**ast-guard**](./libs/ast-guard)   | AST-based JavaScript validator with 100% CVE protection        | [![npm](https://img.shields.io/npm/v/ast-guard.svg)](https://www.npmjs.com/package/ast-guard)   |
| [**vectoriadb**](./libs/vectoriadb) | Lightweight in-memory vector database for semantic search      | [![npm](https://img.shields.io/npm/v/vectoriadb.svg)](https://www.npmjs.com/package/vectoriadb) |
| [**enclavejs**](./libs/enclave)     | Secure AgentScript execution environment with defense-in-depth | [![npm](https://img.shields.io/npm/v/enclavejs.svg)](https://www.npmjs.com/package/enclavejs)   |

---

## Libraries

### ast-guard

Production-ready AST security guard for JavaScript validation and code safety. Blocks all known vm2/isolated-vm/node-vm CVE exploits.

```typescript
import { validate, PRESETS } from 'ast-guard';

const result = validate('const x = 1 + 2;', PRESETS.SECURE);
console.log(result.valid); // true
```

**Features:**

- 100% CVE coverage for vm2, isolated-vm, and node-vm exploits
- 613+ security tests with 95%+ code coverage
- Four security presets: STRICT, SECURE, STANDARD, PERMISSIVE
- Zero runtime dependencies (only acorn for parsing)

[Read more →](./libs/ast-guard)

---

### vectoriadb

Lightweight, production-ready in-memory vector database for semantic search with HNSW indexing.

```typescript
import { VectoriaDB } from 'vectoriadb';

const db = new VectoriaDB();
await db.initialize();

await db.insert({ id: '1', text: 'Hello world', metadata: {} });
const results = await db.search('greeting', 5);
```

**Features:**

- HNSW (Hierarchical Navigable Small World) indexing
- Multiple embedding options (TF-IDF, transformer-based)
- Persistence adapters (File, Redis)
- Built-in security validation

[Read more →](./libs/vectoriadb)

---

### enclavejs

Secure AgentScript execution environment with defense-in-depth architecture for running LLM-generated JavaScript safely.

```typescript
import { Enclave } from 'enclavejs';

const enclave = new Enclave({ securityLevel: 'SECURE' });

const result = await enclave.execute(`
  const sum = 1 + 2;
  return sum;
`);
console.log(result.value); // 3
```

**Features:**

- Bank-grade security: 516+ security tests, 81+ blocked attack vectors
- Defense-in-depth: 6 security layers
- Worker Pool Adapter for isolated execution
- Reference Sidecar for sandboxed environments

[Read more →](./libs/enclave)

---

## Getting Started

### Prerequisites

- **Node.js**: >= 22.0.0
- **Package Manager**: yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/agentfront/enclave.git
cd enclave

# Install dependencies
yarn install

# Build all libraries
yarn build

# Run tests
yarn test
```

### Using Individual Libraries

```bash
# ast-guard
npm install ast-guard

# vectoriadb
npm install vectoriadb

# enclave
npm install enclavejs
```

---

## Development

```bash
# Build all projects
nx run-many -t build

# Test all projects
nx run-many -t test

# Lint all projects
nx run-many -t lint

# Build specific project
nx build ast-guard
nx build vectoriadb
nx build enclave
```

---

## Contributing

PRs welcome! Please:

1. Keep changes focused
2. Add/adjust tests for your changes
3. Run `yarn build && yarn test && yarn lint` before submitting

---

## License

[Apache-2.0](./LICENSE)
