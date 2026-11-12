# @enclave-vm/broker

[![npm version](https://img.shields.io/npm/v/@enclave-vm/broker.svg)](https://www.npmjs.com/package/@enclave-vm/broker)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Tool broker and session management for the EnclaveJS streaming runtime

`@enclave-vm/broker` runs scripts in an [`@enclave-vm/core`](../core) sandbox on a server, gives them the tools you register, and streams what happens as events. It can serve sessions over HTTP for [`@enclave-vm/client`](../client).

## What it provides

- **A tool registry**: tools with a Zod schema for their arguments, and secrets that only tool handlers see.
- **Sessions**: one sandbox per session, with limits (tool calls, lifetime, deadline, per-tool timeout) and a stream of events (`session_init`, `tool_call`, `tool_progress`, `tool_result_applied`, `partial_result`, `heartbeat`, `final`, ...).
- **HTTP routes** for creating, reading, replaying and ending sessions, with an adapter for Express.
- **Event filters** that decide which events a client is sent.
- **Tools from an OpenAPI specification**, kept up to date by polling.

It does not provide authentication, rate limiting or transport encryption. Authentication is yours to put in front of the routes; the routes can then bind every session to its caller (see [Who may see a session](#who-may-see-a-session)).

## Installation

```bash
npm install @enclave-vm/broker
```

## Quick start

```typescript
import { createBroker } from '@enclave-vm/broker';
import { z } from 'zod';

const broker = createBroker({
  // Options of the sandbox go under `enclave`
  enclave: { securityLevel: 'SECURE' },
  // Limits of every session
  limits: { maxToolCalls: 20, sessionTtlMs: 60_000 },
});

broker.secret('API_KEY', process.env.API_KEY!);

broker.tool('getUser', {
  description: 'Look a user up by id',
  argsSchema: z.object({ id: z.string() }),
  secrets: ['API_KEY'],
  handler: async ({ id }, { secrets, signal }) => {
    const response = await fetch(`https://api.example.com/users/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${secrets.API_KEY}` },
      signal,
    });
    return response.json();
  },
});

const result = await broker.execute(
  `
  const user = await callTool('getUser', { id: '42' });
  return user.name;
`,
  { onEvent: (event) => console.log(event.type) },
);

if (result.success) console.log(result.value);

await broker.dispose();
```

`createBroker` reads `sessions`, `enclave`, `limits` and `history`. A key it does not know is ignored and reported with a warning: a sandbox option such as `securityLevel` has no effect at the top level.

## Serving sessions over HTTP

```typescript
import express from 'express';
import { createBroker, createSessionHandler, registerExpressRoutes } from '@enclave-vm/broker';

const broker = createBroker();
const handler = createSessionHandler({
  broker,
  // Who is calling? See "Who may see a session".
  identify: (request) => (request.raw as { user?: { id: string } }).user?.id,
  allowedOrigins: ['https://app.example.com'],
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(authenticate); // your authentication, before the routes
registerExpressRoutes(app, handler);
app.listen(3000);
```

| Route                              | What it does                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /sessions`                   | Creates a session, runs `code`, answers with the events as NDJSON until the `final` event |
| `GET /sessions`                    | Lists sessions (`sessionList: false` switches it off)                                     |
| `GET /sessions/:sessionId`         | State of one session                                                                      |
| `GET /sessions/:sessionId/stream`  | Replays the kept events from `?fromSeq=N` on and follows the session until it ends        |
| `DELETE /sessions/:sessionId`      | Ends a session                                                                            |
| `POST /sessions/:sessionId/cancel` | The same; this is the `cancelUrl` a session announces in its `session_init` event         |

For another framework, call `handler.getRoutes()` and adapt its request and response to `BrokerRequest` and `BrokerResponse`. `createExpressRouter` is deprecated: it registers no route.

### The request body of `POST /sessions`

```jsonc
{
  "code": "return 1;",
  "sessionId": "s_...", // optional; generated when left out
  "config": { "maxExecutionMs": 30000, "maxToolCalls": 10, "heartbeatIntervalMs": 15000 }, // optional
  "filter": { "mode": "exclude", "rules": [{ "types": { "types": ["heartbeat"] } }] }, // optional
}
```

The body is validated as a whole, and a request that does not pass is answered with `400` before a session exists:

- `config` values are positive integers. A request can **lower** `maxToolCalls` and `maxExecutionMs` (the session's lifetime) and can never raise them above the broker's `limits` (or the package defaults when you set none). `heartbeatIntervalMs` is kept between 1 second and 5 minutes.
- `sessionId` is `s_` followed by 1 to 128 characters of `A-Z a-z 0-9 . _ : ~ -`. An id that is in use is answered with `409 SESSION_EXISTS`.
- `filter` is checked against fixed bounds (16 rules, 32 patterns, 256 characters per pattern); see [Event filters](#event-filters).
- A request with `encryption.mode: "required"` is refused: this broker does not encrypt sessions.

Other answers: `401 UNAUTHORIZED` (no caller identity), `404 NOT_FOUND`, `410 EVENTS_GONE`, `429 TOO_MANY_STREAMS`, `503 MAX_SESSIONS_REACHED`, `500 SESSION_CREATE_ERROR`. An error answer holds a `code` and a fixed `message`.

## Security

### Who may see a session

**Without an `identify` hook the routes do not tell callers apart.** Whoever can reach them can list every session, read its state, replay its events (tool arguments and the final result included) and end it. That is acceptable only where every caller is trusted alike, for example a broker that a single backend talks to. Authentication in front of the routes does not change it: an authenticated caller still reaches the sessions of every other caller.

With `identify`, every session belongs to the caller that created it:

```typescript
const handler = createSessionHandler({
  broker,
  identify: (request) => {
    // `request.raw` is the framework's request object, `request.headers` the headers.
    const user = (request.raw as { user?: { id: string } }).user;
    return user?.id; // a stable, non-empty string per caller; nothing when there is none
  },
});
```

- `GET /sessions` lists the caller's own sessions.
- Reading, replaying and ending a session is answered only for its owner. Another caller gets `404`, the answer of an id that does not exist.
- A request for which the hook returns nothing, or throws, is answered with `401`.
- A session created in process (`broker.createSession()`) has no owner and is not reachable over the routes, unless you pass `owner`.

The hook identifies; it does not authenticate. Verify the credential in your own middleware, or in the hook itself.

It separates sessions, not data: a tool handler receives its arguments and a context with the id of its session, not the caller. A tool that reads data restricted per caller applies that restriction itself, with the owner of its session (`broker.getSession(context.sessionId as SessionId)?.owner`, the caller the hook returned), or leaves it to the data store.

### Cross-origin requests

CORS headers are on by default with `Access-Control-Allow-Origin: *`, so a page of any origin can call a broker its visitor's browser can reach, including one on `localhost` or an internal network. Set `allowedOrigins` to the origins of your application, or `cors: false`, for anything that is not a public demo.

A cross-origin page may send `Content-Type`, `Accept`, `Last-Event-ID` and `Authorization`. If your clients send another header (an API-key header through the client's `headers` option, say), name it in `allowedHeaders`: a browser does not send a header the preflight answer does not list.

The routes answer the preflight (`OPTIONS`) themselves, and a browser sends it without the credential: authentication in front of the routes has to let `OPTIONS` requests through to them.

### Limits

`limits` (see `SessionLimits` in `@enclave-vm/types`) bound every session of a broker. A session created in process may name its own value for a limit; a session created over HTTP may only lower `maxToolCalls` and the lifetime.

| Limit                 | Default  | What it bounds                                                                                           |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `maxToolCalls`        | 50       | Tool calls of one session                                                                                |
| `toolTimeoutMs`       | 30000    | The run time of the script (it is passed to the sandbox as its timeout)                                  |
| `perToolDeadlineMs`   | 30000    | One tool call: the handler's `signal` is aborted. A tool's own `config.timeout` applies when it is lower |
| `deadlineMs`          | 0 (none) | The whole session, counted from its creation                                                             |
| `sessionTtlMs`        | 60000    | How long a session stays registered; a session past it is cancelled at the next cleanup                  |
| `maxToolResultBytes`  | 5 MB     | A tool result, as serialized JSON; a larger one fails the call with `TOOL_RESULT_TOO_LARGE`              |
| `heartbeatIntervalMs` | 15000    | Interval of `heartbeat` events                                                                           |
| `cancelOnFirstError`  | false    | Whether the first failed tool call cancels the session                                                   |

`maxStdoutBytes` is not used: the broker emits no `stdout` events.

`sessions.maxSessions` (default 100) bounds the registered sessions. A finished session stays registered, so that it can be replayed, until the next cleanup (`sessions.cleanupIntervalMs`, default 60 s).

What a session keeps and writes is bounded as well:

- `history: { maxEvents, maxBytes }` (default 10,000 events and 4 MB) bounds the events a session keeps for a replay. When a bound is reached the oldest events are dropped, and a replay that would start below the kept events is answered with `410 EVENTS_GONE`.
- `maxStreamsPerSession` (handler option, default 8) bounds the streams one session has open; a further one is answered with `429`.
- `maxBufferedBytes` (handler option, default 8 MB): a reader that falls behind by more is disconnected, and when it is the creator of the session, the session is cancelled. A custom adapter takes part by implementing `bufferedBytes()` and `destroy()` on its `BrokerResponse`.

### What cancelling does, and what one script can hold

A session runs in the broker's own process and thread. A script that computes without calling a tool holds the thread, and with it every other session, until it ends or reaches `toolTimeoutMs`. Cancelling a session (`DELETE`, a caller that disconnects, `deadlineMs`, `session.cancel()`) aborts the tool call in flight and refuses every later one; it does not interrupt a script that is computing. Keep `toolTimeoutMs` low, and run the broker in a process of its own (or give the sandbox the worker-pool adapter through `enclave`) when you serve callers you do not trust.

### Event filters

A filter decides which events a client is sent: by type, or by content with `exact`, `prefix`, `regex` and `glob` patterns.

```typescript
import { createEventFilter } from '@enclave-vm/broker';

const filter = createEventFilter({
  config: {
    mode: 'exclude',
    rules: [{ types: { types: ['heartbeat', 'tool_progress'] } }],
  },
});

session.onEvent((event) => {
  if (filter.shouldSend(event)) send(event);
});
```

- Evaluating one event takes a bounded time: regular expressions and globs run under `regexTimeoutMs` (100 ms by default). `budgetMs` bounds all evaluations of one filter together.
- An event a filter could not evaluate (a pattern that does not compile, an evaluation that ran out of time) is **not sent**, in either mode.
- In exclude mode a glob is matched as text: `*` also matches `/` and a leading dot. In include mode a glob follows path rules, as before.
- A filter that arrives in a request is validated, gets at most 100 ms per event and 500 ms per stream, and its globs are matched without brace and extglob expansion.

A filter is a convenience for the client. **It is not a confidentiality control**: data a client must not see has to stay out of the events, that is, out of tool arguments and results.

### Tools from OpenAPI

```typescript
const source = broker.openapi({
  name: 'users',
  url: 'https://api.example.com/openapi.json',
  baseUrl: 'https://api.example.com',
  auth: { type: 'bearer', token: process.env.API_TOKEN! },
  intervalMs: 60_000,
});

source.on('error', (error) => console.error('users API:', error.message));
await source.start();
```

- A failure while polling is reported with the `error` event when it has a listener, and in `source.getStats()` (`pollHealth`, `lastError`) either way. The tools of the last specification that was applied stay registered. Tools are replaced in one step, and a source never replaces a tool it does not manage.
- A path parameter fills its own segment of the path: a value that would leave the segment empty or turn it into `.` or `..` fails the call.
- The credential (`auth`) and `loaderOptions.headers` go to the origin of `baseUrl` only. They are not sent with the request for the specification when it is on another origin (use `headers` of the source for what the specification host needs), and a redirect to another origin is followed without them. A header parameter of the specification cannot replace them.
- Upstream responses are read up to `loaderOptions.maxResponseBytes` (10 MB), specifications up to `maxSpecBytes` (32 MB), and fetching a specification is bounded by `fetchTimeoutMs`.

A script decides the arguments of a generated tool, so whatever an operation of the upstream does with its arguments is within reach of a script. Generate tools only for the operations a script may call (`loaderOptions.includeOperations`, `loaderOptions.excludeOperations`).

### Secrets and tool arguments

Secrets are resolved per tool and handed to the handler only; they are not part of any event. Tool arguments and the result of the script are part of the events: do not put a secret into them, and do not return one from a tool.

## Related packages

| Package                           | Description                                                   |
| --------------------------------- | ------------------------------------------------------------- |
| [@enclave-vm/core](../core)       | The sandbox                                                   |
| [@enclave-vm/types](../types)     | Protocol types and Zod schemas                                |
| [@enclave-vm/client](../client)   | Browser and Node.js client                                    |
| [@enclave-vm/stream](../stream)   | NDJSON and reconnection helpers                               |
| [@enclave-vm/runtime](../runtime) | Runtime worker building blocks (does not execute scripts yet) |

## License

Apache-2.0
