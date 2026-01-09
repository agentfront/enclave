<br/>
<div align="center">

<picture>
  <!-- Source for dark mode -->
  <source width="100" media="(prefers-color-scheme: dark)" srcset="https://github.com/agentfront/enclave/blob/main/assets/logo.dark.svg">
  <!-- Fallback image for light mode and unsupported browsers -->
  <img width="100" src="https://github.com/agentfront/enclave/blob/main/assets/logo.light.svg" alt="An image that changes based on the user's light or dark mode preference.">
</picture>

# Enclave

**Secure sandbox runtime for AI agents**

[![npm ast-guard](https://img.shields.io/npm/v/ast-guard.svg?label=ast-guard&color=e8a045)](https://www.npmjs.com/package/ast-guard)
[![npm vectoriadb](https://img.shields.io/npm/v/vectoriadb.svg?label=vectoriadb&color=e8a045)](https://www.npmjs.com/package/vectoriadb)
[![npm enclave-vm](https://img.shields.io/npm/v/enclave-vm.svg?label=enclave-vm&color=e8a045)](https://www.npmjs.com/package/enclave-vm)
<br>
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[Documentation](https://agentfront.dev/docs/guides/enclave) | [Live Demo](https://enclave.agentfront.dev) | [FrontMCP Framework](https://github.com/agentfront/enclave)

</div>

---

## Install

```bash
npm install enclave-vm    # Secure JS execution
npm install ast-guard     # AST validation
npm install vectoriadb    # Vector search
```

## Why Enclave?

- **Extensive security testing** - See [security audit](./libs/enclave-vm/SECURITY-AUDIT.md) for details
- **Defense in depth** - 6 security layers for LLM-generated code
- **Zero-config** - Works out of the box with sensible defaults
- **TypeScript-first** - Full type safety and excellent DX

## Quick Start

```typescript
import { Enclave } from 'enclave-vm';

const enclave = new Enclave({
  securityLevel: 'SECURE',
  toolHandler: async (name, args) => {
    if (name === 'getUser') return { id: args.id, name: 'Alice' };
    throw new Error(`Unknown tool: ${name}`);
  },
});

const result = await enclave.run(`
  const user = await callTool('getUser', { id: 123 });
  return { greeting: 'Hello, ' + user.name };
`);

if (result.success) {
  console.log(result.value); // { greeting: 'Hello, Alice' }
}

enclave.dispose();
```

**[Read the full documentation →](https://agentfront.dev/docs/guides/enclave)**

---

## License

[Apache-2.0](./LICENSE)
