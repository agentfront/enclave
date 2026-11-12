# @enclave-vm/runtime

[![npm version](https://img.shields.io/npm/v/@enclave-vm/runtime.svg)](https://www.npmjs.com/package/@enclave-vm/runtime)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Building blocks of a runtime worker for EnclaveJS: session bookkeeping and channels

The @enclave-vm/runtime package contains the building blocks of a runtime worker: a worker object that keeps track of sessions, a session executor, and the channels between a worker and a broker.

> **This package is not a runnable service.** It does not execute code, starts no server and opens no port. It has no authentication, no TLS, no CORS, no HTTP or WebSocket endpoints, no serverless entry points, and it reads no environment variables. An `execute` request never runs code: it ends with `RuntimeNotImplementedError`. To run scripts use [@enclave-vm/broker](../broker) (sessions, tools and streaming over HTTP) or [@enclave-vm/core](../core) (the sandbox).

## What Is in the Package

- **Runtime worker**: `createRuntimeWorker(config?)` keeps the sessions of the requests that the embedding application hands to it
- **Session executor**: `SessionExecutor` holds one session and forwards its events to a channel
- **Channels**: `MemoryChannel` (in process) and `WebSocketChannel` (client side of a WebSocket connection)
- **`RuntimeNotImplementedError`**: thrown by the operations that are not implemented
- **`enclave-runtime`**: a command line program that says a standalone worker is not implemented and exits with an error

## Installation

```bash
npm install @enclave-vm/runtime
# or
yarn add @enclave-vm/runtime
# or
pnpm add @enclave-vm/runtime
```

## Usage

```typescript
import { createRuntimeWorker, createMemoryChannel, RuntimeNotImplementedError } from '@enclave-vm/runtime';

const worker = createRuntimeWorker({ maxSessions: 10 });
await worker.start(); // marks the worker as running; nothing is listening

const channel = createMemoryChannel();

try {
  await worker.handleRequest({ type: 'execute', sessionId: 's_123', code: 'return 1 + 1' }, channel);
} catch (error) {
  if (error instanceof RuntimeNotImplementedError) {
    console.log(error.code); // 'NOT_IMPLEMENTED'
  }
}

// The channel received a session that started and ended with an error
console.log(channel.getEvents().map((event) => event.type)); // ['session_init', 'final']

// No session is left behind
console.log(worker.getSessions()); // []

await worker.stop();
```

## Runtime Worker

`createRuntimeWorker(config?)` returns a worker (the class is exported as `RuntimeWorkerImpl`).

| Member                            | Description                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `start()`                         | Marks the worker as running, so that `handleRequest()` accepts `execute` requests       |
| `stop()`                          | Cancels and removes the sessions the worker holds                                       |
| `isRunning`                       | Whether the worker is in the `running` state                                            |
| `getStats()`                      | State, session counts, start time, uptime and memory usage of the process               |
| `getSessions()`                   | The sessions the worker holds: `sessionId`, `state`, `createdAt`, `expiresAt`           |
| `handleRequest(request, channel)` | Handles one request (`execute`, `cancel`, `tool_result` or `ping`) from the application |

`handleRequest()` trusts its caller: nothing authenticates a request or checks where it came from.

- **`execute`** never runs the code. A valid request rejects with `RuntimeNotImplementedError` (code `NOT_IMPLEMENTED`): the channel receives `session_init`, then a `final` event with `ok: false` and `error.code: 'NOT_IMPLEMENTED'`, and the session is removed again. A request to a worker that is not running, or without a string `code`, rejects with another error.
- **`cancel`** cancels the session with that id if the worker holds it. Otherwise the request is ignored.
- **`tool_result`** passes the result to the session with that id if the worker holds it. Otherwise the request is ignored.
- **`ping`** is accepted. Nothing is sent back.

### Configuration

| Option                | Default       | Description                                                                             |
| --------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `maxSessions`         | `10`          | Maximum number of sessions the worker holds. A positive integer, otherwise `RangeError` |
| `debug`               | `false`       | Log to the console                                                                      |
| `port`                | `3001`        | Not used: no server is started                                                          |
| `host`                | `'127.0.0.1'` | Not used: no server is started                                                          |
| `wsPath`              | `'/ws'`       | Not used: no server is started                                                          |
| `defaultLimits`       | `{}`          | Accepted, not read by the worker                                                        |
| `heartbeatIntervalMs` | `15000`       | Accepted, not read by the worker                                                        |
| `connectionTimeoutMs` | `30000`       | Accepted, not read by the worker                                                        |

## Session Executor

`createSessionExecutor({ sessionId?, code, limits?, channel, debug? })` creates a `SessionExecutor`. It keeps the code and never runs it.

- `execute()` always rejects with `RuntimeNotImplementedError`. The first call ends the session: the channel receives `session_init` and the `final` event described above.
- `cancel(reason?)` and `submitToolResult(callId, success, value?, error?)` go to the session.
- `getInfo()`, `state` and `isTerminal` describe the session. `dispose()` stops forwarding events to the channel.

## Channels

A channel implements `RuntimeChannel`: `send(event)`, `onMessage(handler)`, `close()` and `isOpen`.

```typescript
import { createMemoryChannel, createMemoryChannelPair, createWebSocketChannel } from '@enclave-vm/runtime';

// In process: keeps the events that were sent
const channel = createMemoryChannel();
channel.getEvents();

// Two connected channels: what one sends, the handlers of the other receive
const { client, server } = createMemoryChannelPair();

// Client side of a WebSocket connection
const remote = createWebSocketChannel({ url: 'wss://worker.example.com/ws' });
await remote.connect();
```

`WebSocketChannel` is the client side only. It connects to a URL and nothing more:

- It sends no credentials. Authenticate the connection in the server behind the URL.
- It parses incoming messages as JSON and hands them to the handlers without validating them against a schema. Validate them in the handler.
- While it is not connected it keeps at most `maxBufferedMessages` events (default 1000) and drops the rest.
- It reconnects with exponential backoff (`reconnect.maxRetries`, default 5).
- Where there is no global `WebSocket`, it needs the `ws` package, which is not installed with this package.

## Command Line

```bash
npx enclave-runtime --help
```

The `enclave-runtime` program does not start a worker. It checks its arguments (`--port`, `--host`, `--max-sessions`, `--debug`), prints that a standalone worker is not implemented, and exits with code 1. `--help` prints the help and exits with code 0.

## Related Packages

| Package                         | Description                        |
| ------------------------------- | ---------------------------------- |
| [@enclave-vm/core](../core)     | Core execution engine              |
| [@enclave-vm/types](../types)   | Type definitions and Zod schemas   |
| [@enclave-vm/stream](../stream) | Streaming protocol implementation  |
| [@enclave-vm/broker](../broker) | Tool broker and session management |
| [@enclave-vm/client](../client) | Browser/Node.js client SDK         |

## License

Apache-2.0
