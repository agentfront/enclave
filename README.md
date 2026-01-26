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
[![npm enclave-vm](https://img.shields.io/npm/v/enclave-vm.svg?label=enclave-vm&color=e8a045)](https://www.npmjs.com/package/enclave-vm)
<br>
[![npm @enclavejs/broker](https://img.shields.io/npm/v/@enclavejs/broker.svg?label=@enclavejs/broker&color=e8a045)](https://www.npmjs.com/package/@enclavejs/broker)
[![npm @enclavejs/client](https://img.shields.io/npm/v/@enclavejs/client.svg?label=@enclavejs/client&color=e8a045)](https://www.npmjs.com/package/@enclavejs/client)
[![npm @enclavejs/react](https://img.shields.io/npm/v/@enclavejs/react.svg?label=@enclavejs/react&color=e8a045)](https://www.npmjs.com/package/@enclavejs/react)
<br>
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[Documentation](https://agentfront.dev/docs/guides/enclave) | [Live Demo](https://enclave.agentfront.dev) | [FrontMCP Framework](https://github.com/agentfront/enclave)

</div>

---

## Why Enclave?

- **Extensive security testing** - See [security audit](./libs/enclave-vm/SECURITY-AUDIT.md) for details
- **Defense in depth** - 6 security layers for LLM-generated code
- **Streaming runtime** - Real-time event streaming with tool call support
- **Zero-config** - Works out of the box with sensible defaults
- **TypeScript-first** - Full type safety and excellent DX

## Install

### Core Packages

```bash
npm install enclave-vm    # Secure JS sandbox
npm install ast-guard     # AST security validation
```

### Streaming Runtime

```bash
npm install @enclavejs/broker   # Tool broker & session management
npm install @enclavejs/client   # Browser/Node client SDK
npm install @enclavejs/react    # React hooks & components
```

## Packages

| Package                                          | Description                                         |
| ------------------------------------------------ | --------------------------------------------------- |
| [`enclave-vm`](./libs/enclave-vm)                | Secure JavaScript sandbox with 6 security layers    |
| [`@enclavejs/broker`](./libs/enclavejs-broker)   | Tool registry, secrets management, session API      |
| [`@enclavejs/client`](./libs/enclavejs-client)   | Browser & Node.js client for streaming sessions     |
| [`@enclavejs/react`](./libs/enclavejs-react)     | React hooks: `useEnclaveSession`, `EnclaveProvider` |
| [`@enclavejs/runtime`](./libs/enclavejs-runtime) | Deployable runtime worker (Lambda, Vercel, etc.)    |
| [`@enclavejs/types`](./libs/enclavejs-types)     | TypeScript types & Zod schemas                      |
| [`@enclavejs/stream`](./libs/enclavejs-stream)   | NDJSON streaming, encryption, reconnection          |
| [`ast-guard`](./libs/ast-guard)                  | AST-based security validator                        |

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

## React Integration

```tsx
import { EnclaveProvider, useEnclaveSession } from '@enclavejs/react';

function App() {
  return (
    <EnclaveProvider brokerUrl="https://your-server.com">
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

- Deployment scenarios (embedded vs extracted runtime)
- Streaming protocol (NDJSON)
- Tool broker pattern
- Reference sidecar & auto-ref
- Security & encryption

## Demo

Run the streaming demo locally:

```bash
npx nx demo streaming-demo
```

This starts 3 servers demonstrating the secure architecture:

- **Client** (port 4100) - Web UI
- **Broker** (port 4101) - Tool execution & session management
- **Runtime** (port 4102) - Sandboxed code execution

**[Read the full documentation →](https://agentfront.dev/docs/guides/enclave)**

---

## License

[Apache-2.0](./LICENSE)
