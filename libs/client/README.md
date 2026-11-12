# @enclave-vm/client

[![npm version](https://img.shields.io/npm/v/@enclave-vm/client.svg)](https://www.npmjs.com/package/@enclave-vm/client)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Browser and Node.js client SDK for the EnclaveJS streaming runtime

The @enclave-vm/client package is a client for an EnclaveJS broker, for browsers and Node.js applications. It sends a script to the broker over HTTP, reads the events of the session as they arrive, and gives you the result.

## Features

- **Cross-Platform**: Works in browsers and Node.js, on top of `fetch`
- **Streaming Support**: Session events are passed to your handlers as they arrive
- **Auto-Reconnection**: A lost connection is resumed after the last event received, so every event is delivered once and in order
- **Cancellation**: Stop a session with its handle, by its id, or with an `AbortSignal`
- **Type-Safe**: Full TypeScript support

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
  baseUrl: 'https://api.example.com',
});

// Execute code and wait for the result
const result = await client.execute(`
  const user = await callTool('getUser', { id: 123 });
  return { name: user.name };
`);

if (result.success) {
  console.log(result.value); // what the script returned
} else {
  console.error(result.error?.code, result.error?.message);
}
```

Tools run on the broker. The client is told about tool calls (`onToolCall`, `onToolResultApplied`), but it executes nothing and has no API to register tools.

## Event Handling

Pass handlers with the options of `execute()` or `executeStream()`:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const result = await client.execute(code, {
  onSessionInit: (event) => {
    console.log('Session started:', event.sessionId);
  },
  onStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  onLog: (level, message, data) => {
    console.log(`[${level}]`, message, data);
  },
  onToolCall: (callId, toolName, args) => {
    console.log(`Tool called: ${toolName}`, args);
  },
  onToolResultApplied: (callId) => {
    console.log(`Tool result applied: ${callId}`);
  },
  onError: (errorCode, message) => {
    console.error(`${errorCode}: ${message}`);
  },
});
```

The handlers are `onEvent` (every event), `onSessionInit`, `onStdout`, `onLog`, `onToolCall`, `onToolResultApplied`, `onHeartbeat`, `onError`, `onPartialResult`, `onToolProgress`, `onDeadlineExceeded` and `onCatalogChanged`. The end of the session has no handler of its own: the result comes from the promise of `execute()`, or from `wait()` on the handle.

## Streaming Execution

`executeStream()` returns a handle for the running session at once:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const session = client.executeStream(code, {
  onStdout: (chunk) => {
    process.stdout.write(chunk);
  },
});

console.log('Session ID:', session.sessionId);
console.log('Active:', session.isActive());
console.log('Events so far:', session.getEvents().length);

// Wait for the result
const result = await session.wait();
```

`await client.execute(code, options)` is the same as `await client.executeStream(code, options).wait()`.

## Configuration Options

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({
  // Connection
  baseUrl: 'https://api.example.com',

  // Headers sent with every request (for example credentials)
  headers: {
    Authorization: 'Bearer your-api-token',
  },

  // Waiting for the server
  timeout: 60000,

  // Reconnection
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectDelay: 1000,

  // Largest event accepted
  maxEventLength: 8388608,
});
```

| Option                 | Default        | Description                                                                                                                                                                                                                        |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | Required       | Base URL of the broker                                                                                                                                                                                                             |
| `headers`              | none           | Headers sent with every request                                                                                                                                                                                                    |
| `timeout`              | `60000`        | How long the client waits for the server, in milliseconds: for the answer to a request, and for the next event on an open stream (there, never less than two heartbeat intervals). When it runs out the connection counts as lost. |
| `autoReconnect`        | `true`         | Reconnect when the connection is lost                                                                                                                                                                                              |
| `maxReconnectAttempts` | `3`            | Reconnection attempts in a row before the session fails                                                                                                                                                                            |
| `reconnectDelay`       | `1000`         | Base delay before a reconnection attempt, in milliseconds; it grows with each attempt in a row                                                                                                                                     |
| `maxEventLength`       | `8388608`      | Largest event the client accepts, in characters (8 MiB). A longer event ends the session with `PARSE_ERROR`.                                                                                                                       |
| `fetch`                | global `fetch` | Custom fetch implementation. Required where there is no global `fetch`.                                                                                                                                                            |

These are all the options. Any other option makes the constructor throw a `TypeError` that names it: the client has no `encryption`, `auth`, `serverUrl` or `reconnect` option. A value the client cannot use, such as a `timeout` of `0`, throws as well.

The client does not encrypt. Requests and events travel as plain JSON over HTTP and are protected only by the transport: use an `https:` base URL, and send credentials with `headers`.

## Session Management

Every execution is a session with an id that starts with `s_`. The client generates the id unless you pass one with the `sessionId` option; an id that does not start with `s_` is refused before a request is made.

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const session = client.executeStream(code, {
  // Limits requested for the session
  limits: {
    sessionTtlMs: 60000,
    maxToolCalls: 100,
  },
});

console.log('Session ID:', session.sessionId);

// Ask the broker about the session (null if it does not know the session)
const info = await client.getSession(session.sessionId);
console.log(info?.state, info?.stats.toolCallCount);

// Cancel the session
await session.cancel('User cancelled');
// or: await client.cancelSession(session.sessionId, 'User cancelled');

const result = await session.wait();
console.log(result.error?.code); // 'CANCELLED'
```

`cancel()`, `cancelSession()` and aborting the `signal` option all do the same: the session ends in the client as `CANCELLED`, and the broker is asked to end it with `DELETE {baseUrl}/sessions/:sessionId`. They do not reject. If the broker does not confirm the stop, `onError` is called with the code `CANCEL_FAILED`: the script may still be running.

## Error Handling

A session that fails is not a rejected promise. `execute()` and `wait()` resolve with `success: false` and an `error`:

```typescript
import { EnclaveClient, EnclaveClientError } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const result = await client.execute(code);

if (!result.success) {
  switch (result.error?.code) {
    case 'CANCELLED':
      console.error('Execution was cancelled');
      break;
    case 'TIMEOUT':
      console.error('The broker did not answer in time');
      break;
    case 'NETWORK_ERROR':
    case 'RECONNECT_FAILED':
      console.error('Connection lost:', result.error?.message);
      break;
    default:
      console.error('Execution failed:', result.error?.code, result.error?.message);
  }
}

// getSession() is the one method that rejects, with an EnclaveClientError
try {
  const info = await client.getSession(result.sessionId);
  console.log(info?.state);
} catch (error) {
  if (error instanceof EnclaveClientError) {
    console.error('Enclave client error:', error.code, error.message);
  } else {
    throw error;
  }
}
```

`error.code` is one of the client's codes, or the code that the broker sent with the end of the session:

| Code               | Meaning                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `CANCELLED`        | The session was cancelled with `cancel()`, `cancelSession()` or the `signal`                                       |
| `TIMEOUT`          | The broker did not answer, or sent no event, within the time the client waits                                      |
| `NETWORK_ERROR`    | A request failed, or the stream ended before the session was complete                                              |
| `PARSE_ERROR`      | The answer cannot be read: an event longer than `maxEventLength`, an encrypted event, or a response without a body |
| `SESSION_ERROR`    | The broker refused to start the session, the session id is not valid, or the id is already running on this client  |
| `RECONNECT_FAILED` | The broker refused a reconnection                                                                                  |

When the connection is lost and `autoReconnect` is on, the client reconnects first. If the attempts are used up, the session fails with the code of the last failure.

## Browser Usage

In the browser the client uses the global `fetch`:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({
  baseUrl: 'https://api.example.com',
});

async function runCode() {
  const result = await client.execute(
    `
      const data = await callTool('fetchData', { url: '/api/users' });
      return data;
    `,
    {
      onStdout: (chunk) => {
        document.body.append(chunk);
      },
    },
  );
  console.log(result);
}

runCode();
```

## Related Packages

| Package                           | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| [@enclave-vm/types](../types)     | Type definitions and Zod schemas                        |
| [@enclave-vm/stream](../stream)   | Streaming protocol implementation                       |
| [@enclave-vm/react](../react)     | React hooks and components                              |
| [@enclave-vm/runtime](../runtime) | Runtime worker building blocks (not a runnable service) |

## License

Apache-2.0
