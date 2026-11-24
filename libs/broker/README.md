# @enclave-vm/broker

The server side of EnclaveJS streaming: it runs scripts in an `@enclave-vm/core` sandbox, gives them the tools you register, and streams what happens as events, for Node.js services that execute scripts on behalf of clients.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/broker.svg)](https://www.npmjs.com/package/@enclave-vm/broker)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

The broker builds on [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core) (the sandbox) and [`@enclave-vm/types`](https://www.npmjs.com/package/@enclave-vm/types) (the protocol). It can be used in process, or serve sessions over HTTP for [`@enclave-vm/client`](https://www.npmjs.com/package/@enclave-vm/client) and [`@enclave-vm/react`](https://www.npmjs.com/package/@enclave-vm/react). It provides:

- a tool registry: tools with a Zod schema for their arguments, and secrets that only tool handlers see;
- sessions: one sandbox per session, with limits (tool calls, lifetime, deadline, per-tool timeout) and a stream of events;
- HTTP routes for creating, reading, replaying and ending sessions, with an adapter for Express;
- event filters that decide which events a client is sent;
- tools generated from an OpenAPI specification, kept up to date by polling.

It does not provide authentication, rate limiting or transport encryption. Authentication is yours to put in front of the routes; the routes can then bind every session to its caller (see [Who may see a session](#who-may-see-a-session)).

## Install

```bash
npm install @enclave-vm/broker zod
```

`zod` (version 4) is needed for the argument schemas of your tools.

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

broker.tool('getUser', {
  description: 'Look a user up by id',
  argsSchema: z.object({ id: z.string() }),
  handler: async ({ id }) => ({ id, name: 'Ada' }),
});

const result = await broker.execute(
  `
  const user = await callTool('getUser', { id: '42' });
  return user.name;
`,
  { onEvent: (event) => console.log(event.type) },
);

if (result.success) console.log(result.value); // 'Ada'

await broker.dispose();
```

## Broker

`createBroker(config?)` (or `new Broker(config?)`) reads these options. A key it does not know is ignored and reported with a warning: a sandbox option such as `securityLevel` has no effect at the top level.

| Option     | Type                     | Default                                          | Meaning                                                                            |
| ---------- | ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `enclave`  | `CreateEnclaveOptions`   | sandbox defaults                                 | Options of the `@enclave-vm/core` sandbox of every session                         |
| `limits`   | `Partial<SessionLimits>` | `DEFAULT_SESSION_LIMITS`                         | Limits of every session (see [Limits](#limits))                                    |
| `sessions` | `SessionManagerConfig`   | `{ maxSessions: 100, cleanupIntervalMs: 60000 }` | Number of registered sessions, and how often finished and expired ones are removed |
| `history`  | `SessionHistoryLimits`   | `{ maxEvents: 10000, maxBytes: 4194304 }`        | Events each session keeps for a replay                                             |

Main methods:

| Method                                                     | Description                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `tool(name, definition)` / `tools(definitions)`            | Register tools                                                        |
| `hasTool`, `listTools`, `removeTool`                       | Inspect and remove tools                                              |
| `secret(key, value)` / `secrets(values)`                   | Store secrets for tool handlers                                       |
| `hasSecret`, `removeSecret`                                | Inspect and remove secrets                                            |
| `execute(code, { session?, onEvent? })`                    | Run a script in a new session and resolve with its result             |
| `createSession(config?)`                                   | Create a `BrokerSession` to drive yourself                            |
| `getSession(id)`, `listSessions()`, `listActiveSessions()` | Look sessions up                                                      |
| `terminateSession(id, reason?)`                            | End a session                                                         |
| `openapi(config)`                                          | Add an OpenAPI source (see [Tools from OpenAPI](#tools-from-openapi)) |
| `stats()`, `cleanup()`, `dispose()`                        | Statistics, removal of finished sessions, shutdown                    |

### Tools and secrets

```typescript
broker.secret('API_KEY', process.env.API_KEY!);

broker.tool('getRemoteUser', {
  description: 'Look a user up in the users API',
  argsSchema: z.object({ id: z.string() }),
  secrets: ['API_KEY'],
  config: { timeout: 5_000 },
  handler: async ({ id }, { secrets, signal }) => {
    const response = await fetch(`https://api.example.com/users/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${secrets.API_KEY}` },
      signal,
    });
    return response.json();
  },
});
```

A tool definition has `handler` (required), `description`, `argsSchema`, `secrets` (names of the secrets the handler receives) and `config` (`ToolConfig`; only `timeout` has an effect). The handler receives the validated arguments and a context with `sessionId`, `callId`, `secrets` and `signal`. The signal is aborted when the call times out or the session is cancelled.

## Serving sessions over HTTP

```typescript
import express from 'express';
import { createBroker, createSessionHandler, registerExpressRoutes } from '@enclave-vm/broker';
import { authenticate } from './auth.js'; // your authentication middleware

const broker = createBroker();
const handler = createSessionHandler({
  broker,
  // Who is calling? See "Who may see a session".
  identify: (request) => (request.raw as { user?: { id: string } }).user?.id,
  allowedOrigins: ['https://app.example.com'],
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(authenticate); // before the routes; let OPTIONS requests through (see "Cross-origin requests")
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

### Handler options

| Option                 | Type               | Default          | Meaning                                                                                                                                                                                                                 |
| ---------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker`               | `Broker`           | Required         | The broker whose sessions the routes serve                                                                                                                                                                              |
| `identify`             | `CallerIdentifier` | none             | Returns the caller of a request; binds every session to its creator (see below)                                                                                                                                         |
| `cors`                 | `boolean`          | `true`           | Send CORS headers                                                                                                                                                                                                       |
| `allowedOrigins`       | `string[]`         | `['*']`          | Origins CORS headers are sent for                                                                                                                                                                                       |
| `allowedHeaders`       | `string[]`         | `[]`             | Request headers a cross-origin page may send, besides the fixed ones                                                                                                                                                    |
| `sessionList`          | `boolean`          | `true`           | Serve `GET /sessions`                                                                                                                                                                                                   |
| `maxStreamsPerSession` | `number`           | `8`              | Streams one session may have open; a further one is answered with `429`                                                                                                                                                 |
| `maxBufferedBytes`     | `number`           | `8388608` (8 MB) | How far a reader may fall behind before its stream is dropped; dropping the creator's stream cancels the session. A custom adapter takes part by implementing `bufferedBytes()` and `destroy()` on its `BrokerResponse` |

An unknown option is ignored and reported with a warning.

### The request body of `POST /sessions`

```jsonc
{
  "code": "return 1;",
  "sessionId": "s_...", // optional; generated when left out
  "config": { "maxExecutionMs": 30000, "maxToolCalls": 10, "heartbeatIntervalMs": 15000 }, // optional
  "filter": { "mode": "exclude", "rules": [{ "types": { "types": ["heartbeat"] } }] }, // optional
}
```

`CreateSessionRequest` and `CreateSessionRequestSchema` of `@enclave-vm/types` describe this body; `@enclave-vm/client` sends it. The broker checks the body against bounds of its own: narrower than the schema for the session id, the limits and the filter (below), and more lenient where a field is `null` (it counts as left out), where a filter names an event type the protocol does not define (no event has it), and for fields it does not read, which it ignores. It validates the body as a whole and answers a request that does not pass with `400` before a session exists:

- `config` values are positive integers. A request can **lower** `maxToolCalls` and `maxExecutionMs` (the session's lifetime, `sessionTtlMs`) and can never raise them above the broker's `limits` (or the package defaults when you set none). `heartbeatIntervalMs` is kept between 1 second and 5 minutes.
- `sessionId` is `s_` followed by 1 to 128 characters of `A-Z a-z 0-9 . _ : ~ -`. An id that is in use is answered with `409 SESSION_EXISTS`.
- `filter` is checked against fixed bounds (16 rules, 32 patterns, 256 characters per pattern); see [Event filters](#event-filters).
- A request with `encryption.mode: "required"` is refused: this broker does not encrypt sessions.

<details>
<summary>Error answers</summary>

An error answer holds a `code` and a fixed `message`.

| Status | Code                           | When                                                                       |
| ------ | ------------------------------ | -------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`              | Invalid body, session id or `X-Session-Instance-ID` header                 |
| 400    | `INVALID_FILTER`               | Invalid `filter`, in the body of `POST /sessions` or the query of a stream |
| 401    | `UNAUTHORIZED`                 | `identify` returned no caller, or threw                                    |
| 404    | `NOT_FOUND`                    | Unknown session, a session of another caller, or the list is switched off  |
| 409    | `SESSION_EXISTS`               | The session id is in use                                                   |
| 409    | `SESSION_INSTANCE_UNAVAILABLE` | A conditional stop for a session that was created without an instance id   |
| 410    | `EVENTS_GONE`                  | A replay that starts below the events the session still keeps              |
| 412    | `SESSION_INSTANCE_MISMATCH`    | A conditional stop for a session that was replaced                         |
| 429    | `TOO_MANY_STREAMS`             | The session has `maxStreamsPerSession` streams open                        |
| 500    | `SESSION_CREATE_ERROR`         | The session could not be created                                           |
| 500    | `INTERNAL_ERROR`               | The session list could not be produced                                     |
| 503    | `MAX_SESSIONS_REACHED`         | The broker holds `sessions.maxSessions` sessions                           |
| 503    | `SERVICE_UNAVAILABLE`          | The broker is disposed                                                     |

`X-Session-Instance-ID` is an optional header that `@enclave-vm/client` sends: a stop that carries it ends the session only if it is the creation that sent the same value.

</details>

## Limits

`limits` (see `SessionLimits` in `@enclave-vm/types`) bound every session of a broker. A session created in process may name its own value for a limit; a session created over HTTP may only lower `maxToolCalls` and the lifetime.

| Limit                 | Default  | What it bounds                                                                                                                                                               |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxToolCalls`        | 50       | Tool calls of one session                                                                                                                                                    |
| `toolTimeoutMs`       | 30000    | The run time of the script (it is passed to the sandbox as its timeout)                                                                                                      |
| `perToolDeadlineMs`   | 30000    | One tool call: the handler's `signal` is aborted. A tool's own `config.timeout` applies when it is lower                                                                     |
| `deadlineMs`          | 0 (none) | The whole session, counted from its creation                                                                                                                                 |
| `sessionTtlMs`        | 60000    | How long a session lives: a session still running when it is reached is cancelled then (its tool calls get the abort signal), and an idle one is removed at the next cleanup |
| `maxToolResultBytes`  | 5 MB     | A tool result, as serialized JSON; a larger one fails the call with `TOOL_RESULT_TOO_LARGE`                                                                                  |
| `heartbeatIntervalMs` | 15000    | Interval of `heartbeat` events                                                                                                                                               |
| `cancelOnFirstError`  | false    | Whether the first failed tool call cancels the session                                                                                                                       |

`maxStdoutBytes` is not used: the broker emits no `stdout` events.

`sessions.maxSessions` (default 100) bounds the registered sessions. A finished session stays registered, so that it can be replayed, until the next cleanup (`sessions.cleanupIntervalMs`, default 60 s).

What a session keeps and writes is bounded as well:

- `history: { maxEvents, maxBytes }` (default 10,000 events and 4 MB) bounds the events a session keeps for a replay. When a bound is reached the oldest events are dropped, and a replay that would start below the kept events is answered with `410 EVENTS_GONE`.
- `maxStreamsPerSession` and `maxBufferedBytes` (handler options above) bound the streams of a session and how far a reader may fall behind.

## Event filters

A filter decides which events a client is sent: by type, or by content with `exact`, `prefix`, `regex` and `glob` patterns.

```typescript
import { createEventFilter } from '@enclave-vm/broker';

const filter = createEventFilter({
  config: {
    mode: 'exclude',
    rules: [{ types: { types: ['heartbeat', 'tool_progress'] } }],
  },
});

const session = broker.createSession();
session.onEvent((event) => {
  if (filter.shouldSend(event)) console.log(event.type);
});
```

`createEventFilter` takes `config` (`EventFilterConfig`), and optionally `onError`, `budgetMs` (total time for regular expressions and globs over the filter's life; no budget by default) and `expandGlobs` (default `true`). `createTypeFilter` and `createContentFilter` build a `config`.

- Evaluating one event takes a bounded time: regular expressions and globs run under `regexTimeoutMs` (100 ms by default).
- An event a filter could not evaluate (a pattern that does not compile, an evaluation that ran out of time) is **not sent**, in either mode.
- In exclude mode a glob is matched as text: `*` also matches `/` and a leading dot. In include mode a glob follows path rules.
- A filter that arrives in a request is validated, gets at most 100 ms per event and 500 ms per stream, and its globs are matched without brace and extglob expansion.

## Tools from OpenAPI

```typescript
const source = broker.openapi({
  name: 'users',
  url: 'https://api.example.com/openapi.json',
  baseUrl: 'https://api.example.com',
  auth: { type: 'bearer', token: process.env.API_TOKEN! },
  intervalMs: 60_000,
  loaderOptions: { includeOperations: ['getUser', 'listUsers'] },
});

source.on('error', (error) => console.error('users API:', error.message));
await source.start();
```

<details>
<summary>OpenAPI source options</summary>

| Option                                                  | Type                                                          | Default        | Meaning                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| `name`                                                  | `string`                                                      | Required       | Name of the source                                         |
| `url`                                                   | `string`                                                      | Required       | URL of the specification                                   |
| `baseUrl`                                               | `string`                                                      | Required       | Base URL of the upstream API that the generated tools call |
| `auth`                                                  | `{ type: 'bearer' \| 'api-key' \| 'basic', token?, header? }` | none           | Credential for the upstream API                            |
| `intervalMs`                                            | `number`                                                      | `60000`        | Polling interval                                           |
| `fetchTimeoutMs`                                        | `number`                                                      | `10000`        | Time limit for fetching the specification                  |
| `headers`                                               | `Record<string, string>`                                      | none           | Headers for the specification request                      |
| `maxSpecBytes`                                          | `number`                                                      | 32 MB          | Largest specification read                                 |
| `changeDetection`, `retry`, `unhealthyThreshold`        | see `OpenApiPollerConfig`                                     |                | Polling behaviour                                          |
| `loaderOptions.includeOperations` / `excludeOperations` | `string[]`                                                    | all operations | Operations that become tools                               |
| `loaderOptions.headers`                                 | `Record<string, string>`                                      | none           | Headers sent to the upstream API                           |
| `loaderOptions.maxResponseBytes`                        | `number`                                                      | 10 MB          | Largest upstream response read                             |
| `loaderOptions.perToolDeadlineMs`, `namingStrategy`     | see `LoaderOptions`                                           |                | Per-tool timeout, tool naming                              |

</details>

- A failure while polling is reported with the `error` event when it has a listener, and in `source.getStats()` (`pollHealth`, `lastError`) either way. The tools of the last specification that was applied stay registered. Tools are replaced in one step, and a source never replaces a tool it does not manage.
- A path parameter fills its own segment of the path: a value that would leave the segment empty or turn it into `.` or `..` fails the call.
- The credential (`auth`) and `loaderOptions.headers` go to the origin of `baseUrl` only. They are not sent with the request for the specification when it is on another origin (use `headers` of the source for what the specification host needs), and a redirect to another origin is followed without them. A header parameter of the specification cannot replace them.

## Security notes

### What it does not do

- **No authentication and no rate limiting.** Put both in front of the routes.
- **No encryption.** Events are plain JSON; a request that requires encryption is refused. Serve the routes over HTTPS.
- **No separate process per session.** Sessions run in the broker's own process and thread, each in its own sandbox (see [What cancelling does](#what-cancelling-does-and-what-one-script-can-hold)).

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

A cross-origin page may send `Content-Type`, `Accept`, `Last-Event-ID`, `Authorization` and `X-Session-Instance-ID`. If your clients send another header (an API-key header through the client's `headers` option, say), name it in `allowedHeaders`: a browser does not send a header the preflight answer does not list.

The routes answer the preflight (`OPTIONS`) themselves, and a browser sends it without the credential: authentication in front of the routes has to let `OPTIONS` requests through to them.

### What cancelling does, and what one script can hold

A session runs in the broker's own process and thread. A script that computes without calling a tool holds the thread, and with it every other session, until it ends or reaches `toolTimeoutMs`. Cancelling a session (`DELETE`, a caller that disconnects, `deadlineMs`, `session.cancel()`) aborts the tool call in flight and refuses every later one; it does not interrupt a script that is computing. Keep `toolTimeoutMs` low, and run the broker in a process of its own (or give the sandbox the worker-thread adapter with `enclave: { adapter: 'worker_threads' }`) when you serve callers you do not trust.

### Event filters are not access control

A filter is a convenience for the client. **It is not a confidentiality control**: data a client must not see has to stay out of the events, that is, out of tool arguments and results.

### Tools from OpenAPI

A script decides the arguments of a generated tool, so whatever an operation of the upstream does with its arguments is within reach of a script. Generate tools only for the operations a script may call (`loaderOptions.includeOperations`, `loaderOptions.excludeOperations`). Upstream responses are read up to `loaderOptions.maxResponseBytes`, specifications up to `maxSpecBytes`.

### Secrets and tool arguments

Secrets are resolved per tool and handed to the handler only; they are not part of any event. Tool arguments and the result of the script are part of the events: do not put a secret into them, and do not return one from a tool.

The message and code of an exception a handler throws are passed on to the script, and to the final event when the script does not catch it, with the value of each secret the handler was given replaced by `[REDACTED]`. Only the value as it is is recognised, not an encoded or partial form of it: a handler does not put a secret into an error.

## Related packages

| Package                                                                  | Role                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| [@enclave-vm/core](https://www.npmjs.com/package/@enclave-vm/core)       | The sandbox                                            |
| [@enclave-vm/client](https://www.npmjs.com/package/@enclave-vm/client)   | Browser and Node.js client for these routes            |
| [@enclave-vm/react](https://www.npmjs.com/package/@enclave-vm/react)     | React provider and hooks on top of the client          |
| [@enclave-vm/types](https://www.npmjs.com/package/@enclave-vm/types)     | Protocol types and Zod schemas                         |
| [@enclave-vm/stream](https://www.npmjs.com/package/@enclave-vm/stream)   | NDJSON and reconnection helpers                        |
| [@enclave-vm/runtime](https://www.npmjs.com/package/@enclave-vm/runtime) | Runtime worker building blocks (does not execute code) |

## Documentation

- Documentation: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Architecture: https://github.com/agentfront/enclave/blob/main/README-ARCHITECTURE.md
- Security policy: https://github.com/agentfront/enclave/blob/main/SECURITY.md

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
