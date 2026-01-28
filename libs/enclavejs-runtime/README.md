# @enclave-vm/runtime

[![npm version](https://img.shields.io/npm/v/@enclave-vm/runtime.svg)](https://www.npmjs.com/package/@enclave-vm/runtime)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Standalone runtime worker for EnclaveJS - deployable execution environment

The @enclave-vm/runtime package provides a standalone, deployable runtime worker for EnclaveJS. It can run as a standalone process, in a container, or as a serverless function, providing secure code execution with the EnclaveJS streaming protocol.

## Features

- **Standalone Deployment**: Run as a standalone Node.js process
- **Container Ready**: Docker support with minimal image size
- **Serverless Compatible**: Deploy to AWS Lambda, Vercel, etc.
- **WebSocket Support**: Real-time streaming via WebSocket
- **HTTP API**: REST-like HTTP interface for simple integrations
- **Configurable Security**: Multiple security levels and resource limits

## Installation

```bash
npm install @enclave-vm/runtime
# or
yarn add @enclave-vm/runtime
# or
pnpm add @enclave-vm/runtime
```

## Quick Start

### CLI Usage

```bash
# Start runtime server
npx enclave-runtime --port 3000

# With configuration file
npx enclave-runtime --config runtime.config.json

# With environment variables
ENCLAVE_PORT=3000 ENCLAVE_SECURITY_LEVEL=strict npx enclave-runtime
```

### Programmatic Usage

```typescript
import { createRuntime } from '@enclave-vm/runtime';

const runtime = await createRuntime({
  port: 3000,
  securityLevel: 'strict',
  timeout: 30000,
  maxToolCalls: 100,
  tools: {
    'data:fetch': async (args) => {
      return await fetchData(args.url);
    },
  },
});

await runtime.start();
console.log('Runtime listening on port 3000');

// Graceful shutdown
process.on('SIGTERM', () => runtime.stop());
```

## Configuration

### Configuration File

Create `runtime.config.json`:

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "securityLevel": "strict",
  "timeout": 30000,
  "maxToolCalls": 100,
  "maxIterations": 10000,
  "cors": {
    "origin": ["https://app.example.com"],
    "credentials": true
  },
  "auth": {
    "type": "bearer",
    "tokens": ["token1", "token2"]
  },
  "tls": {
    "cert": "/path/to/cert.pem",
    "key": "/path/to/key.pem"
  }
}
```

### Environment Variables

| Variable                 | Description                               | Default    |
| ------------------------ | ----------------------------------------- | ---------- |
| `ENCLAVE_PORT`           | Server port                               | `3000`     |
| `ENCLAVE_HOST`           | Server host                               | `0.0.0.0`  |
| `ENCLAVE_SECURITY_LEVEL` | Security level                            | `standard` |
| `ENCLAVE_TIMEOUT`        | Execution timeout (ms)                    | `30000`    |
| `ENCLAVE_MAX_TOOL_CALLS` | Max tool calls                            | `100`      |
| `ENCLAVE_AUTH_TOKEN`     | Auth token (comma-separated for multiple) | -          |

## Docker Deployment

```dockerfile
FROM node:22-slim

WORKDIR /app
RUN npm install @enclave-vm/runtime

EXPOSE 3000
CMD ["npx", "enclave-runtime"]
```

Build and run:

```bash
docker build -t enclave-runtime .
docker run -p 3000:3000 enclave-runtime
```

## WebSocket API

Connect to `ws://localhost:3000/ws`:

```typescript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onopen = () => {
  // Start session
  ws.send(
    JSON.stringify({
      type: 'start',
      code: `
      const user = await callTool('getUser', { id: 1 });
      return user;
    `,
    }),
  );
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  switch (message.type) {
    case 'tool_call':
      console.log('Tool called:', message.name);
      // Handle tool call and send result
      ws.send(
        JSON.stringify({
          type: 'tool_result',
          id: message.id,
          data: {
            /* result */
          },
        }),
      );
      break;
    case 'result':
      console.log('Execution result:', message.value);
      break;
    case 'error':
      console.error('Error:', message.error);
      break;
  }
};
```

## HTTP API

### Execute Code

```bash
POST /execute
Content-Type: application/json

{
  "code": "return 1 + 1",
  "timeout": 5000
}
```

Response:

```json
{
  "success": true,
  "value": 2,
  "stats": {
    "duration": 15,
    "toolCallCount": 0
  }
}
```

### Health Check

```bash
GET /health
```

Response:

```json
{
  "status": "healthy",
  "uptime": 3600,
  "activeSessions": 5
}
```

## Tool Handlers

Register tool handlers programmatically:

```typescript
import { createRuntime } from '@enclave-vm/runtime';

const runtime = await createRuntime({
  tools: {
    // Simple handler
    'math:add': async ({ a, b }) => a + b,

    // Handler with validation
    'users:get': {
      handler: async ({ id }) => {
        return await db.users.findById(id);
      },
      schema: {
        id: { type: 'number', required: true },
      },
    },

    // Async generator for streaming
    'data:stream': async function* ({ items }) {
      for (const item of items) {
        yield await processItem(item);
      }
    },
  },
});
```

## Serverless Deployment

### AWS Lambda

```typescript
import { createLambdaHandler } from '@enclave-vm/runtime/lambda';

export const handler = createLambdaHandler({
  securityLevel: 'strict',
  timeout: 10000,
  tools: {
    // Tool handlers
  },
});
```

### Vercel Edge

```typescript
import { createEdgeHandler } from '@enclave-vm/runtime/edge';

export default createEdgeHandler({
  securityLevel: 'strict',
  tools: {
    // Tool handlers
  },
});

export const config = { runtime: 'edge' };
```

## Monitoring

```typescript
import { createRuntime } from '@enclave-vm/runtime';

const runtime = await createRuntime({
  metrics: {
    enabled: true,
    endpoint: '/metrics', // Prometheus format
  },
  logging: {
    level: 'info',
    format: 'json',
  },
});

// Access metrics
runtime.on('execution:complete', (stats) => {
  console.log(`Execution completed in ${stats.duration}ms`);
});

runtime.on('execution:error', (error) => {
  console.error('Execution failed:', error);
});
```

## Related Packages

| Package                                   | Description                        |
| ----------------------------------------- | ---------------------------------- |
| [@enclave-vm/core](../enclave-vm)         | Core execution engine              |
| [@enclave-vm/types](../enclavejs-types)   | Type definitions and Zod schemas   |
| [@enclave-vm/stream](../enclavejs-stream) | Streaming protocol implementation  |
| [@enclave-vm/broker](../enclavejs-broker) | Tool broker and session management |
| [@enclave-vm/client](../enclavejs-client) | Browser/Node.js client SDK         |

## License

Apache-2.0
