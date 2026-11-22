<div align="center">

<picture>
  <source width="100" media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/agentfront/enclave/main/assets/logo.dark.svg">
  <img width="100" src="https://raw.githubusercontent.com/agentfront/enclave/main/assets/logo.light.svg" alt="Enclave logo">
</picture>

# Enclave

**A sandbox for JavaScript written by AI agents**

[![npm @enclave-vm/core](https://img.shields.io/npm/v/@enclave-vm/core.svg?label=@enclave-vm/core&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/core)
[![npm @enclave-vm/ast](https://img.shields.io/npm/v/@enclave-vm/ast.svg?label=@enclave-vm/ast&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/ast)
[![npm @enclave-vm/browser](https://img.shields.io/npm/v/@enclave-vm/browser.svg?label=@enclave-vm/browser&color=e8a045)](https://www.npmjs.com/package/@enclave-vm/browser)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

[Documentation](https://agentfront.dev/docs/guides/enclave) | [Live demo](https://enclave.agentfront.dev)

</div>

Enclave runs AgentScript, the subset of JavaScript that a language model writes to call your tools, under your control. A script is checked statically, rewritten so that the runtime can enforce limits, and executed in a sandbox where it reaches nothing but the globals and tools you give it. The packages cover the sandbox for Node.js and for the browser, and a streaming layer that runs scripts behind HTTP routes.

## Packages

| Package                                                                               | What it is                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`@enclave-vm/core`](https://github.com/agentfront/enclave/tree/main/libs/core)       | The sandbox for Node.js: validation, transformation, a reduced realm, limits, an optional worker pool |
| [`@enclave-vm/ast`](https://github.com/agentfront/enclave/tree/main/libs/ast)         | The static layer: validator, presets, pre-scanner and transforms                                      |
| [`@enclave-vm/browser`](https://github.com/agentfront/enclave/tree/main/libs/browser) | The sandbox for browsers, in nested sandboxed iframes                                                 |
| [`@enclave-vm/broker`](https://github.com/agentfront/enclave/tree/main/libs/broker)   | Tool registry, secrets, sessions and their HTTP routes (bring your own authentication)                |
| [`@enclave-vm/client`](https://github.com/agentfront/enclave/tree/main/libs/client)   | Browser and Node.js client for broker sessions (plain JSON over HTTP; use HTTPS)                      |
| [`@enclave-vm/react`](https://github.com/agentfront/enclave/tree/main/libs/react)     | React provider and hooks around the client: `EnclaveProvider`, `useEnclaveSession`                    |
| [`@enclave-vm/types`](https://github.com/agentfront/enclave/tree/main/libs/types)     | TypeScript types and Zod schemas of the streaming protocol                                            |
| [`@enclave-vm/stream`](https://github.com/agentfront/enclave/tree/main/libs/stream)   | NDJSON streaming, reconnection helpers, and encryption primitives the other packages do not use       |
| [`@enclave-vm/runtime`](https://github.com/agentfront/enclave/tree/main/libs/runtime) | Building blocks of a separate runtime worker; it does not execute scripts yet                         |

## Quick Start

```bash
npm install @enclave-vm/core
```

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
} else {
  console.error(result.error);
}

enclave.dispose();
```

To run scripts for clients over HTTP, register your tools with [`@enclave-vm/broker`](https://github.com/agentfront/enclave/tree/main/libs/broker) and connect with [`@enclave-vm/client`](https://github.com/agentfront/enclave/tree/main/libs/client) or [`@enclave-vm/react`](https://github.com/agentfront/enclave/tree/main/libs/react). To run scripts in the user's browser, use [`@enclave-vm/browser`](https://github.com/agentfront/enclave/tree/main/libs/browser).

## How the Layers Fit Together

- **Static layer** (`@enclave-vm/ast`): the pre-scanner checks the source text, and the AgentScript preset accepts only an allowlist of syntax, globals and property keys. Its presets are filters on source text, not a boundary on their own.
- **Node.js runtime** (`@enclave-vm/core`): runs a validated script in a realm that holds only the allowed globals, behind a membrane, with limits on time, iterations, tool calls and memory. It checks at run time what a static rule cannot decide, such as a property name built while the script runs. An optional worker pool adds a heap limit per worker and a hard stop. It is not process isolation: tenants that must not share a process need a process or container each.
- **Browser runtime** (`@enclave-vm/browser`): runs a validated script in two nested iframes with `sandbox="allow-scripts"` and a strict Content Security Policy. Inside the frame, the validator is what keeps a script from the document it runs in.
- **Streaming layer** (`@enclave-vm/broker`, `client`, `react`, `types`, `stream`): runs the Node.js sandbox in the broker's process and streams events to clients. It has no authentication, rate limiting or encryption of its own.

Each package's README states what its layer does and does not guarantee. [README-ARCHITECTURE.md](https://github.com/agentfront/enclave/blob/main/README-ARCHITECTURE.md) describes the streaming architecture, what is implemented and what is design. [SECURITY-TESTS.md](https://github.com/agentfront/enclave/blob/main/SECURITY-TESTS.md) lists the security invariants by layer and the ones that are still open.

## Demos

```bash
npx nx serve enclave-demo     # CLI: arithmetic, loops, tool calls, refused operations
npx nx demo streaming-demo    # Web UI with three servers: client (4100), broker (4101), runtime (4102)
```

The three servers of the streaming demo are written for the demo, on `@enclave-vm/core` and `@enclave-vm/types`. They are not the `@enclave-vm/broker` and `@enclave-vm/runtime` packages: the runtime package does not execute scripts yet.

## Development

The repository is an Nx monorepo and needs Node.js 22 or later (`.nvmrc` pins the version used in development) and Yarn 4.

```bash
yarn install
yarn build
yarn test
yarn lint
yarn format:check
```

The security tests live in a private submodule (`security-tests/`); see [SECURITY-TESTS.md](https://github.com/agentfront/enclave/blob/main/SECURITY-TESTS.md).

## Contributing and Security

Issues and pull requests are welcome on [GitHub](https://github.com/agentfront/enclave). Participation is governed by the [Code of Conduct](https://github.com/agentfront/enclave/blob/main/CODE_OF_CONDUCT.md).

Please do not report vulnerabilities in public issues. Use the private channels described in [SECURITY.md](https://github.com/agentfront/enclave/blob/main/SECURITY.md) (GitHub Security Advisories preferred).

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
