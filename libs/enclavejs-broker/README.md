# @enclave-vm/broker

[![npm version](https://img.shields.io/npm/v/@enclave-vm/broker.svg)](https://www.npmjs.com/package/@enclave-vm/broker)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Tool broker and session management for the EnclaveJS streaming runtime

The @enclave-vm/broker package provides server-side components for managing EnclaveJS sessions, routing tool calls, and handling the streaming protocol. It acts as the middleware between clients and the secure execution environment.

## Features

- **Session Management**: Create, manage, and clean up execution sessions
- **Tool Routing**: Route tool calls to appropriate handlers with pattern matching
- **Access Control**: Fine-grained tool permissions using glob patterns
- **Rate Limiting**: Configurable rate limits per session
- **State Management**: Track session state and tool call history
- **Middleware Support**: Extensible middleware pipeline for tool calls

## Installation

```bash
npm install @enclave-vm/broker
# or
yarn add @enclave-vm/broker
# or
pnpm add @enclave-vm/broker
```

## Quick Start

```typescript
import { Broker, createSession } from '@enclave-vm/broker';

// Create a broker with tool handlers
const broker = new Broker({
  tools: {
    'users:get': async (args) => {
      return { id: args.id, name: 'Alice' };
    },
    'users:list': async () => {
      return [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
    },
  },
});

// Create a session
const session = await broker.createSession({
  allowedTools: ['users:*'], // Glob pattern for allowed tools
  timeout: 30000,
  maxToolCalls: 100,
});

// Handle incoming messages
session.on('tool_call', async (call) => {
  const result = await broker.executeToolCall(session.id, call);
  session.send({ type: 'tool_result', id: call.id, data: result });
});
```

## Session Management

```typescript
import { SessionManager } from '@enclave-vm/broker';

const manager = new SessionManager({
  maxConcurrentSessions: 100,
  sessionTimeout: 60000, // 1 minute
  cleanupInterval: 10000, // 10 seconds
});

// Create session
const session = await manager.create({
  userId: 'user_123',
  metadata: { source: 'api' },
});

// Get session
const retrieved = manager.get(session.id);

// List active sessions
const sessions = manager.list({ userId: 'user_123' });

// Destroy session
await manager.destroy(session.id);
```

## Tool Routing

Route tool calls with pattern matching:

```typescript
import { ToolRouter } from '@enclave-vm/broker';

const router = new ToolRouter();

// Register tools with glob patterns
router.register('db:*', {
  handler: async (name, args) => {
    const operation = name.split(':')[1];
    return await database[operation](args);
  },
  rateLimit: { maxCalls: 100, windowMs: 60000 },
});

router.register('api:external:*', {
  handler: async (name, args) => {
    return await externalApi.call(name, args);
  },
  requiresAuth: true,
});

// Execute tool call
const result = await router.execute('db:query', { sql: 'SELECT * FROM users' });
```

## Access Control

```typescript
import { AccessController } from '@enclave-vm/broker';

const access = new AccessController({
  defaultPolicy: 'deny',
  rules: [
    { pattern: 'public:*', allow: true },
    { pattern: 'admin:*', allow: false, unless: { role: 'admin' } },
    { pattern: 'user:*:read', allow: true },
    { pattern: 'user:*:write', allow: false, unless: { owner: true } },
  ],
});

// Check access
const canAccess = access.check('admin:delete', { role: 'user' }); // false
const canRead = access.check('user:profile:read', {}); // true
```

## Middleware

Add middleware for cross-cutting concerns:

```typescript
import { Broker } from '@enclave-vm/broker';

const broker = new Broker({
  middleware: [
    // Logging middleware
    async (call, next) => {
      console.log(`Tool call: ${call.name}`);
      const start = Date.now();
      const result = await next(call);
      console.log(`Completed in ${Date.now() - start}ms`);
      return result;
    },
    // Validation middleware
    async (call, next) => {
      if (!isValidArgs(call.name, call.args)) {
        throw new Error('Invalid arguments');
      }
      return next(call);
    },
  ],
  tools: {
    // ... tool handlers
  },
});
```

## Rate Limiting

```typescript
import { RateLimiter } from '@enclave-vm/broker';

const limiter = new RateLimiter({
  global: { maxCalls: 1000, windowMs: 60000 },
  perSession: { maxCalls: 100, windowMs: 60000 },
  perTool: {
    'expensive:*': { maxCalls: 10, windowMs: 60000 },
  },
});

// Check rate limit before execution
if (!limiter.allow(sessionId, toolName)) {
  throw new Error('Rate limit exceeded');
}
```

## Related Packages

| Package                                     | Description                       |
| ------------------------------------------- | --------------------------------- |
| [@enclave-vm/types](../enclavejs-types)     | Type definitions and Zod schemas  |
| [@enclave-vm/stream](../enclavejs-stream)   | Streaming protocol implementation |
| [@enclave-vm/core](../enclave-vm)           | Secure execution environment      |
| [@enclave-vm/client](../enclavejs-client)   | Browser/Node.js client SDK        |
| [@enclave-vm/runtime](../enclavejs-runtime) | Standalone runtime worker         |

## License

Apache-2.0
