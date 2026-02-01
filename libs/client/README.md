# @enclave-vm/client

[![npm version](https://img.shields.io/npm/v/@enclave-vm/client.svg)](https://www.npmjs.com/package/@enclave-vm/client)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Browser and Node.js client SDK for the EnclaveJS streaming runtime

The @enclave-vm/client package provides a client SDK for connecting to EnclaveJS runtime servers from browsers and Node.js applications. It handles connection management, message streaming, and provides a simple API for executing code and handling tool calls.

## Features

- **Cross-Platform**: Works in browsers and Node.js
- **Streaming Support**: Real-time message streaming with backpressure handling
- **Auto-Reconnection**: Automatic reconnection with configurable retry strategy
- **Type-Safe**: Full TypeScript support
- **Event-Based**: Rich event system for monitoring execution
- **Encryption Ready**: Built-in support for encrypted channels

## Installation

```bash
npm install @enclave-vm/client
# or
yarn add @enclave-vm/client
# or
pnpm add @enclave-vm/client
```

## Quick Start

```typescript
import { EnclaveClient } from '@enclave-vm/client';

// Create client
const client = new EnclaveClient({
  url: 'wss://runtime.example.com',
});

// Connect and execute code
await client.connect();

const result = await client.execute(`
  const user = await callTool('getUser', { id: 123 });
  return { name: user.name };
`);

console.log(result.value); // { name: 'Alice' }

// Disconnect when done
await client.disconnect();
```

## Event Handling

Listen to execution events:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ url: 'wss://runtime.example.com' });

client.on('connected', () => {
  console.log('Connected to runtime');
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
});

client.on('tool_call', (call) => {
  console.log(`Tool called: ${call.name}`, call.args);
});

client.on('tool_result', (result) => {
  console.log(`Tool result:`, result.data);
});

client.on('error', (error) => {
  console.error('Error:', error);
});

client.on('log', (log) => {
  console.log(`[${log.level}]`, ...log.args);
});
```

## Streaming Execution

Handle streaming responses:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ url: 'wss://runtime.example.com' });
await client.connect();

// Stream execution with callbacks
await client.stream(
  `
  for (const id of [1, 2, 3]) {
    const user = await callTool('getUser', { id });
    yield user;
  }
  return 'done';
`,
  {
    onYield: (value) => {
      console.log('Yielded:', value);
    },
    onComplete: (result) => {
      console.log('Completed:', result);
    },
    onError: (error) => {
      console.error('Error:', error);
    },
  },
);
```

## Configuration Options

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({
  // Connection
  url: 'wss://runtime.example.com',
  protocols: ['enclavejs-v1'],

  // Authentication
  auth: {
    token: 'your-api-token',
    // or
    apiKey: 'your-api-key',
  },

  // Reconnection
  reconnect: {
    enabled: true,
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
  },

  // Encryption
  encryption: {
    enabled: true,
    // Key exchange happens automatically
  },

  // Timeouts
  timeout: 30000, // Execution timeout
  connectionTimeout: 10000,

  // Debug
  debug: true,
});
```

## Session Management

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ url: 'wss://runtime.example.com' });
await client.connect();

// Create a persistent session
const session = await client.createSession({
  timeout: 60000,
  maxToolCalls: 100,
  metadata: { userId: 'user_123' },
});

console.log('Session ID:', session.id);

// Execute within session
const result1 = await client.execute('const x = 1; return x;', { sessionId: session.id });
const result2 = await client.execute('return x + 1;', { sessionId: session.id }); // x is still available

// Destroy session when done
await client.destroySession(session.id);
```

## Error Handling

```typescript
import { EnclaveClient, EnclaveError, TimeoutError, ValidationError } from '@enclave-vm/client';

const client = new EnclaveClient({ url: 'wss://runtime.example.com' });

try {
  await client.connect();
  const result = await client.execute('invalid code {{{{');
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Code validation failed:', error.issues);
  } else if (error instanceof TimeoutError) {
    console.error('Execution timed out');
  } else if (error instanceof EnclaveError) {
    console.error('Enclave error:', error.code, error.message);
  } else {
    throw error;
  }
}
```

## Browser Usage

```html
<script type="module">
  import { EnclaveClient } from 'https://esm.sh/@enclave-vm/client';

  const client = new EnclaveClient({
    url: 'wss://runtime.example.com',
  });

  async function runCode() {
    await client.connect();
    const result = await client.execute(`
      const data = await callTool('fetchData', { url: '/api/users' });
      return data;
    `);
    console.log(result);
  }

  runCode();
</script>
```

## Related Packages

| Package                                     | Description                       |
| ------------------------------------------- | --------------------------------- |
| [@enclave-vm/types](../enclavejs-types)     | Type definitions and Zod schemas  |
| [@enclave-vm/stream](../enclavejs-stream)   | Streaming protocol implementation |
| [@enclave-vm/react](../enclavejs-react)     | React hooks and components        |
| [@enclave-vm/runtime](../enclavejs-runtime) | Standalone runtime worker         |

## License

Apache-2.0
