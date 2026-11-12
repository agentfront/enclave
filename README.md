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

[![npm ast-guard](https://img.shields.io/npm/v/@enclave-vm/ast.svg?label=@enclave-vm/ast&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/ast)
[![npm @enclave-vm/core](https://img.shields.io/npm/v/@enclave-vm/core.svg?label=@enclave-vm/core&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/core)
<br>
[![npm @enclave-vm/broker](https://img.shields.io/npm/v/@enclave-vm/broker.svg?label=@enclave-vm/broker&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/broker)
[![npm @enclave-vm/client](https://img.shields.io/npm/v/@enclave-vm/client.svg?label=@enclave-vm/client&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/client)
[![npm @enclave-vm/react](https://img.shields.io/npm/v/@enclave-vm/react.svg?label=@enclave-vm/react&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/react)
<br>
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[Documentation](https://agentfront.dev/docs/guides/enclave) | [Live Demo](https://enclave.agentfront.dev) | [FrontMCP Framework](https://github.com/agentfront/enclave)

</div>

---

## Why Enclave?

- **Extensive security testing** - See [security audit](./libs/core/SECURITY-AUDIT.md) for details
- **Defense in depth** - 6 security layers for LLM-generated code
- **Streaming runtime** - Real-time event streaming with tool call support
- **Zero-config** - Works out of the box with sensible defaults
- **TypeScript-first** - Full type safety and excellent DX

## Install

### Core Packages

```bash
npm install @enclave-vm/core    # Secure JS sandbox
npm install @enclave-vm/ast     # AST security validation
```

### Streaming Runtime

```bash
npm install @enclave-vm/broker   # Tool broker & session management
npm install @enclave-vm/client   # Browser/Node client SDK
npm install @enclave-vm/react    # React hooks & components
```

## Packages

| Package                                 | Description                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`@enclave-vm/core`](./libs/core)       | Secure JavaScript sandbox with 6 security layers                                            |
| [`@enclave-vm/ast`](./libs/ast)         | AST-based security validator                                                                |
| [`@enclave-vm/browser`](./libs/browser) | The sandbox for browsers, in nested iframes                                                 |
| [`@enclave-vm/broker`](./libs/broker)   | Tool registry, secrets, sessions and their HTTP routes (bring your own authentication)      |
| [`@enclave-vm/client`](./libs/client)   | Browser & Node.js client for streaming sessions (plain JSON over HTTP; use HTTPS)           |
| [`@enclave-vm/react`](./libs/react)     | React hooks: `useEnclaveSession`, `EnclaveProvider`                                         |
| [`@enclave-vm/types`](./libs/types)     | TypeScript types & Zod schemas                                                              |
| [`@enclave-vm/stream`](./libs/stream)   | NDJSON streaming, reconnection helpers, encryption primitives the other packages do not use |
| [`@enclave-vm/runtime`](./libs/runtime) | Building blocks of a runtime worker; it does not execute scripts yet                        |

## Quick Start

```typescript
import { Enclave } from '@enclave-vm/core';

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

## React Integration

```tsx
import { EnclaveProvider, useEnclaveSession } from '@enclave-vm/react';

function App() {
  return (
    <EnclaveProvider config={{ baseUrl: 'https://your-server.com' }}>
      <CodeRunner />
    </EnclaveProvider>
  );
}

function CodeRunner() {
  const { execute, state, result, stdout } = useEnclaveSession();

  const runCode = () =>
    execute(`
    const data = await callTool('fetchData', { id: 123 });
    return data;
  `);

  return (
    <div>
      <button onClick={runCode} disabled={state === 'running'}>
        {state === 'running' ? 'Running...' : 'Run Code'}
      </button>
      {stdout && <pre>{stdout}</pre>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
```

## Architecture

See [README-ARCHITECTURE.md](./README-ARCHITECTURE.md) for detailed architecture documentation covering:

- Deployment scenarios (what is implemented today, and the design for a separate runtime)
- Streaming protocol (NDJSON)
- Tool broker pattern
- Reference sidecar
- Security: what the transport has to provide, and what the packages do not

## Demos

### Enclave Demo (basic sandbox)

```bash
npx nx serve enclave-demo
```

A CLI script that demonstrates core sandbox features: arithmetic, loops, tool calls, and security blocking of disallowed operations.

### Streaming Demo (full architecture)

```bash
npx nx demo streaming-demo
```

Starts a 3-server architecture with a web UI, covering embedded, lambda, and direct execution modes:

- **Client** (port 4100) — Web UI
- **Broker** (port 4101) — Tool execution & session management
- **Runtime** (port 4102) — Sandboxed code execution

The three servers are written for the demo, on `@enclave-vm/core` and `@enclave-vm/types`. They are not the `@enclave-vm/broker` and `@enclave-vm/runtime` packages: the runtime package does not execute scripts yet.

**[Read the full documentation →](https://agentfront.dev/docs/guides/enclave)**

---

## License

[Apache-2.0](./LICENSE)
