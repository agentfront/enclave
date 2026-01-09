<br/>
<div align="center">
<img src="./assets/logo.dark.svg" alt="Enclave" width="80">

# Enclave

**Secure sandbox runtime for AI agents**

[![npm ast-guard](https://img.shields.io/npm/v/ast-guard.svg?label=ast-guard&color=e8a045)](https://www.npmjs.com/package/ast-guard)
[![npm vectoriadb](https://img.shields.io/npm/v/vectoriadb.svg?label=vectoriadb&color=e8a045)](https://www.npmjs.com/package/vectoriadb)
[![npm enclave-vm](https://img.shields.io/npm/v/enclave-vm.svg?label=enclave-vm&color=e8a045)](https://www.npmjs.com/package/enclave-vm)
<br>
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[Documentation](https://enclave.agentfront.dev) | [GitHub](https://github.com/agentfront/enclave)

</div>

---

## Install

```bash
npm install enclave-vm    # Secure JS execution
npm install ast-guard     # AST validation
npm install vectoriadb    # Vector search
```

## Why Enclave?

- **Bank-grade security** - 1000+ security tests, 100% CVE coverage
- **Defense in depth** - 6 security layers for LLM-generated code
- **Zero-config** - Works out of the box with sensible defaults
- **TypeScript-first** - Full type safety and excellent DX

## Quick Start

```typescript
import { Enclave } from 'enclave-vm';

const enclave = new Enclave({ securityLevel: 'SECURE' });
const result = await enclave.execute('return 1 + 2');

console.log(result.value); // 3
```

**[Read the full documentation →](https://enclave.agentfront.dev)**

---

## License

[Apache-2.0](./LICENSE)
