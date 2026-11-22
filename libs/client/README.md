# @enclave-vm/client

A client for an EnclaveJS broker, for browser and Node.js applications that send scripts to a broker and follow their sessions.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/client.svg)](https://www.npmjs.com/package/@enclave-vm/client)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

The client talks to the HTTP routes of [`@enclave-vm/broker`](https://www.npmjs.com/package/@enclave-vm/broker): it creates a session with the script, reads the session's events as they arrive (NDJSON over `fetch`), reconnects when the stream is lost, and gives you the result. It builds on [`@enclave-vm/stream`](https://www.npmjs.com/package/@enclave-vm/stream) and [`@enclave-vm/types`](https://www.npmjs.com/package/@enclave-vm/types), and [`@enclave-vm/react`](https://www.npmjs.com/package/@enclave-vm/react) wraps it for React.

Tools run on the broker. The client is told about tool calls (`onToolCall`, `onToolResultApplied`), but it executes nothing and has no API to register tools.

## Install

```bash
npm install @enclave-vm/client
```

## Quick start

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

// Runs on the broker; `getUser` is a tool registered there
const result = await client.execute(`
  const user = await callTool('getUser', { id: '123' });
  return { name: user.name };
`);

if (result.success) {
  console.log(result.value); // what the script returned
} else {
  console.error(result.error?.code, result.error?.message);
}
```

`await client.execute(code, options)` is the same as `await client.executeStream(code, options).wait()`.

## Configuration

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({
  baseUrl: 'https://api.example.com',
  headers: { Authorization: 'Bearer your-api-token' },
  timeout: 60000,
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectDelay: 1000,
  maxEventLength: 8388608,
});
```

| Option                 | Type                     | Default        | Meaning                                                                                                                                                                                                                            |
| ---------------------- | ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | `string`                 | Required       | Base URL of the broker's routes (a trailing `/` is removed)                                                                                                                                                                        |
| `headers`              | `Record<string, string>` | none           | Headers sent with every request                                                                                                                                                                                                    |
| `timeout`              | `number`                 | `60000`        | How long the client waits for the server, in milliseconds: for the answer to a request, and for the next event on an open stream (there, never less than two heartbeat intervals). When it runs out the connection counts as lost. |
| `autoReconnect`        | `boolean`                | `true`         | Reconnect when the connection is lost                                                                                                                                                                                              |
| `maxReconnectAttempts` | `number`                 | `3`            | Reconnection attempts in a row before the session fails                                                                                                                                                                            |
| `reconnectDelay`       | `number`                 | `1000`         | Base delay before a reconnection attempt, in milliseconds; it grows with each attempt in a row                                                                                                                                     |
| `maxEventLength`       | `number`                 | `8388608`      | Largest event the client accepts, in characters (8 MiB). A longer event ends the session with `PARSE_ERROR`.                                                                                                                       |
| `fetch`                | `typeof fetch`           | global `fetch` | Custom fetch implementation. Required where there is no global `fetch`.                                                                                                                                                            |

These are all the options. Any other option makes the constructor throw a `TypeError` that names it: the client has no `encryption`, `auth`, `serverUrl` or `reconnect` option. A value the client cannot use, such as a `timeout` of `0`, throws as well.

## Executing a script

`execute(code, options?)` and `executeStream(code, options?)` take the same options: the event handlers below plus `sessionId`, `limits` and `signal`.

| Option      | Type                     | Meaning                                                             |
| ----------- | ------------------------ | ------------------------------------------------------------------- |
| `sessionId` | `SessionId`              | Id of the session; generated (`s_` and a UUID) when left out        |
| `limits`    | `Partial<SessionLimits>` | Limits to ask the broker for; see [Session limits](#session-limits) |
| `signal`    | `AbortSignal`            | Aborting it cancels the session, like `cancel()`                    |

### Event handlers

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const result = await client.execute('return 1 + 1', {
  onSessionInit: (event) => console.log('Session started:', event.sessionId),
  onLog: (level, message, data) => console.log(`[${level}]`, message, data),
  onToolCall: (callId, toolName, args) => console.log(`Tool called: ${toolName}`, args),
  onToolResultApplied: (callId) => console.log(`Tool result applied: ${callId}`),
  onError: (code, message) => console.error(`${code}: ${message}`),
});
```

| Handler               | Arguments                                 | Called for                                                                          |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `onEvent`             | `(event)`                                 | Every event                                                                         |
| `onSessionInit`       | `(event)`                                 | `session_init`                                                                      |
| `onStdout`            | `(chunk)`                                 | `stdout`                                                                            |
| `onLog`               | `(level, message, data?)`                 | `log`                                                                               |
| `onToolCall`          | `(callId, toolName, args)`                | `tool_call`                                                                         |
| `onToolResultApplied` | `(callId)`                                | `tool_result_applied`                                                               |
| `onHeartbeat`         | `()`                                      | `heartbeat`                                                                         |
| `onError`             | `(code, message)`                         | An `error` event, or `CANCEL_FAILED` when the broker did not confirm a cancellation |
| `onPartialResult`     | `(path, data?, error?, hasNext?)`         | `partial_result`                                                                    |
| `onToolProgress`      | `(callId, phase, elapsedMs)`              | `tool_progress`                                                                     |
| `onDeadlineExceeded`  | `(elapsedMs, budgetMs)`                   | `deadline_exceeded`                                                                 |
| `onCatalogChanged`    | `(version, addedActions, removedActions)` | `catalog_changed`                                                                   |

The end of the session has no handler of its own: the result comes from the promise of `execute()`, or from `wait()` on the handle.

### Session handles

`executeStream()` returns a `SessionHandle` at once:

```typescript
import { EnclaveClient } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const session = client.executeStream('return 1 + 1', { onStdout: (chunk) => console.log(chunk) });

console.log('Session ID:', session.sessionId);
console.log('Active:', session.isActive());
console.log('Events so far:', session.getEvents().length);

const result = await session.wait();
```

| Member            | Description                                      |
| ----------------- | ------------------------------------------------ |
| `sessionId`       | Id of the session                                |
| `wait()`          | Resolves with the `SessionResult`                |
| `cancel(reason?)` | Cancels the session (see below)                  |
| `getEvents()`     | A copy of the events received so far             |
| `isActive()`      | Whether the session has not ended on this client |

`SessionResult` has `success`, `sessionId`, `value`, `error` (`{ code?, message }`), `errors` (per-path errors), `stats` (`durationMs`, `toolCallCount`, `stdoutBytes`) and `events`.

### Session ids and the broker

Every session has an id that starts with `s_`. An id that does not, or an id that is already running on this client, is refused before a request is made (`SESSION_ERROR`).

```typescript
// Ask the broker about a session (null if it does not know the session)
const info = await client.getSession(session.sessionId);
console.log(info?.state, info?.stats.toolCallCount);

// Cancel
await session.cancel('User cancelled');
// or: await client.cancelSession(session.sessionId, 'User cancelled');
```

`cancel()`, `cancelSession()` and aborting the `signal` option all do the same: the session ends in the client as `CANCELLED`, and the broker is asked to end it with `DELETE {baseUrl}/sessions/:sessionId`. They do not reject. If the broker does not confirm the stop, `onError` is called with the code `CANCEL_FAILED`: the script may still be running. `cancelSession()` acts only on a session this client is running; for any other id it does nothing.

### Session limits

The client sends three fields of `limits` to the broker, as the `config` of `POST /sessions`: `sessionTtlMs` (as `maxExecutionMs`), `maxToolCalls` and `heartbeatIntervalMs`. The other fields of `SessionLimits` are not sent. The broker can lower `maxExecutionMs` and `maxToolCalls` to its own limits but never raise them, and keeps `heartbeatIntervalMs` within its bounds.

### Reconnection

When the stream is lost and `autoReconnect` is on, the client reconnects with `GET {baseUrl}/sessions/:sessionId/stream?fromSeq=N`, asking for the events after the last one it received. Events at or below the last sequence number received are dropped as replays, so no event is delivered twice. If the attempts are used up, the session fails with the code of the last failure.

## Error handling

A session that fails is not a rejected promise. `execute()` and `wait()` resolve with `success: false` and an `error`:

```typescript
import { EnclaveClient, EnclaveClientError } from '@enclave-vm/client';

const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });

const result = await client.execute('return 1 + 1');

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

## Security notes

- **No encryption.** Requests and events travel as plain JSON over HTTP, protected only by the transport. Use an `https:` base URL. An encrypted (`enc`) event ends the session with `PARSE_ERROR`.
- **No authentication of its own.** Send credentials with `headers`; the broker, or what is in front of it, has to check them. Without an `identify` hook on the broker, any caller that can reach the broker's routes can read and end every session (see the broker's README).
- **Tool calls are visible.** Tool names, arguments and the result of the script reach the client in the events.

## Related packages

| Package                                                                | Role                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| [@enclave-vm/broker](https://www.npmjs.com/package/@enclave-vm/broker) | The server side: tools, sessions and HTTP routes |
| [@enclave-vm/react](https://www.npmjs.com/package/@enclave-vm/react)   | React provider and hooks on top of this client   |
| [@enclave-vm/stream](https://www.npmjs.com/package/@enclave-vm/stream) | NDJSON and reconnection helpers                  |
| [@enclave-vm/types](https://www.npmjs.com/package/@enclave-vm/types)   | Protocol types and Zod schemas                   |

## Documentation

- Documentation: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Architecture: https://github.com/agentfront/enclave/blob/main/README-ARCHITECTURE.md
- Security policy: https://github.com/agentfront/enclave/blob/main/SECURITY.md

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
