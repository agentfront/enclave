# @enclave-vm/runtime

Building blocks of an EnclaveJS runtime worker (session bookkeeping and channels), for developers who want to build a worker of their own. It does not execute code.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/runtime.svg)](https://www.npmjs.com/package/@enclave-vm/runtime)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

The package builds on [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core) (sessions), [`@enclave-vm/stream`](https://www.npmjs.com/package/@enclave-vm/stream) and [`@enclave-vm/types`](https://www.npmjs.com/package/@enclave-vm/types). It contains a worker object that keeps track of sessions, a session executor, and the channels between a worker and a broker.

> **This package is not a runnable service.** It does not execute code, starts no server and opens no port. It has no authentication, no TLS, no CORS, no HTTP or WebSocket endpoints, no serverless entry points, and it reads no environment variables. An `execute` request never runs code: it ends with `RuntimeNotImplementedError`. To run scripts, use [`@enclave-vm/broker`](https://www.npmjs.com/package/@enclave-vm/broker) (sessions, tools and streaming over HTTP) or [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core) (the sandbox).

## Install

```bash
npm install @enclave-vm/runtime
```

Requires Node.js 18 or later. `WebSocketChannel` also needs the `ws` package where there is no global `WebSocket` (see [Channels](#channels)).

## Quick start

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

## Runtime worker

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

- **`execute`** never runs the code. A valid request rejects with `RuntimeNotImplementedError` (code `NOT_IMPLEMENTED`): the channel receives `session_init`, then a `final` event with `ok: false` and `error.code: 'NOT_IMPLEMENTED'`, and the session is removed again. A request to a worker that is not running, a request without a string `code`, a session id that is in use, or a worker at `maxSessions` rejects with another error.
- **`cancel`** cancels the session with that id if the worker holds it. Otherwise the request is ignored.
- **`tool_result`** passes the result to the session with that id if the worker holds it. Otherwise the request is ignored.
- **`ping`** is accepted. Nothing is sent back.

### Configuration

| Option                | Type                     | Default       | Meaning                                                                                 |
| --------------------- | ------------------------ | ------------- | --------------------------------------------------------------------------------------- |
| `maxSessions`         | `number`                 | `10`          | Maximum number of sessions the worker holds. A positive integer, otherwise `RangeError` |
| `debug`               | `boolean`                | `false`       | Log to the console                                                                      |
| `port`                | `number`                 | `3001`        | Not used: no server is started                                                          |
| `host`                | `string`                 | `'127.0.0.1'` | Not used: no server is started                                                          |
| `wsPath`              | `string`                 | `'/ws'`       | Not used: no server is started                                                          |
| `defaultLimits`       | `Partial<SessionLimits>` | `{}`          | Accepted, not read by the worker                                                        |
| `heartbeatIntervalMs` | `number`                 | `15000`       | Accepted, not read by the worker                                                        |
| `connectionTimeoutMs` | `number`                 | `30000`       | Accepted, not read by the worker                                                        |

## Session executor

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
- It reconnects with exponential backoff (`reconnect.maxRetries`, default 5). `connectionTimeoutMs` defaults to 10000.
- Where there is no global `WebSocket`, it needs the `ws` package, which is not installed with this package.

## Command line

```bash
npx enclave-runtime --help
```

The `enclave-runtime` program does not start a worker. It checks its arguments (`--port`, `--host`, `--max-sessions`, `--debug`), prints that a standalone worker is not implemented, and exits with code 1. `--help` prints the help and exits with code 0.

## Security notes

- Nothing in this package authenticates or authorizes: `handleRequest()` acts on every request it is given, and `WebSocketChannel` sends no credentials.
- There is no transport security of its own: no TLS and no encryption. Use a `wss:` URL and authenticate in the server you connect to.
- Messages received over a `WebSocketChannel` are not validated.
- No code is executed, so no sandbox is involved. For sandboxed execution see `@enclave-vm/core` and `@enclave-vm/broker`.

## Related packages

| Package                                                                | Role                                    |
| ---------------------------------------------------------------------- | --------------------------------------- |
| [@enclave-vm/core](https://www.npmjs.com/package/@enclave-vm/core)     | The sandbox that executes scripts       |
| [@enclave-vm/broker](https://www.npmjs.com/package/@enclave-vm/broker) | Tool broker, sessions and HTTP routes   |
| [@enclave-vm/types](https://www.npmjs.com/package/@enclave-vm/types)   | Protocol types and Zod schemas          |
| [@enclave-vm/stream](https://www.npmjs.com/package/@enclave-vm/stream) | NDJSON and reconnection helpers         |
| [@enclave-vm/client](https://www.npmjs.com/package/@enclave-vm/client) | Browser and Node.js client for a broker |

## Documentation

- Documentation: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Architecture: https://github.com/agentfront/enclave/blob/main/README-ARCHITECTURE.md
- Security policy: https://github.com/agentfront/enclave/blob/main/SECURITY.md

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
