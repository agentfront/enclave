# Enclave VM Streaming Runtime — Architecture

This document captures the architecture and decisions for turning `enclave-vm` into a **remote, continuous, streaming runtime** that supports `callTool()` roundtrips without requiring developers to run their own VPC runtime.

It is a design document. Parts of it are implemented and parts are not; the table below and the notes marked **Status** say which. Where this document and a package's README disagree, the README describes the code.

The design is for:

- **Browser + server clients on day 1**
- **Continuous sessions** (not "resume per request")
- **Streaming output** + **tool calls** + **tool results**
- **Optional per-session encryption** on top of the transport (not implemented: see [Security](#10-security-authentication--optional-per-session-encryption))
- **Reference sidecar + auto-ref** to avoid moving large/sensitive payloads through the runtime when not needed (the sidecar exists in `@enclave-vm/core`; auto-ref is not implemented)

## Implementation Status

| Package               | Status             | Description                                                                                                 |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `@enclave-vm/core`    | ✅ Done            | Core sandbox VM engine                                                                                      |
| `@enclave-vm/types`   | ✅ Done            | Shared TypeScript types and Zod schemas                                                                     |
| `@enclave-vm/stream`  | ✅ Done            | NDJSON parsing and reconnection helpers. Its encryption primitives are not used by any other package        |
| `@enclave-vm/broker`  | ✅ Done            | Tool broker with sessions and HTTP routes, running the sandbox in process. No authentication, no encryption |
| `@enclave-vm/client`  | ✅ Done            | Browser + Node client SDK. No encryption, no authentication of its own (credentials go in `headers`)        |
| `@enclave-vm/react`   | ✅ Done            | React provider and hooks around the client                                                                  |
| `@enclave-vm/runtime` | ❌ Not implemented | Building blocks only: session bookkeeping and channels. `execute` rejects with `RuntimeNotImplementedError` |

What works today is the **embedded** deployment (scenarios 1 and 3 below): the broker runs the sandbox in its own process. The **extracted** deployment (scenarios 2 and 4), in which a broker hands execution to a separate runtime worker, is a design: the broker has no option to connect to a worker, and the runtime package does not execute scripts.

## Table of contents

1. [Goals & Non‑Goals](#1-goals--nongoals)
2. [Glossary](#2-glossary)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Deployment Scenarios](#4-deployment-scenarios)
5. [Why "continuous sessions" implies statefulness](#5-why-continuous-sessions-implies-statefulness)
6. [Session API](#6-session-api)
7. [Stream Protocol](#7-stream-protocol-versioned-zod-validated)
8. [Tool calls](#8-tool-calls)
9. [Reference Sidecar + auto-ref](#9-reference-sidecar--auto-ref-key-decision)
10. [Security](#10-security-authentication--optional-per-session-encryption)
11. [Platform notes](#11-platform-notes-runtime-placement)
12. [Open questions](#12-open-questions--follow-ups)

---

## 1) Goals & Non‑Goals

### Goals

- Provide a "managed executor" for AgentScript:
  - client sends code
  - runtime executes continuously and streams events
  - runtime can request tool execution (`tool_call`) and continue once it receives `tool_result`
- Support two deployment modes:
  - **Embedded runtime**: the middleware runs `enclave-vm` directly (single app / VPC). Implemented.
  - **Extracted runtime**: the middleware launches/connects to an external runtime worker (Lambda/edge/server) and proxies streaming + tool calls. Not implemented.
- Keep secrets and tool execution in the middleware/tool-broker by default (the runtime worker should not have secrets).
- Keep tool contracts safe and explicit via **zod input/output schemas**.
- Reduce throughput and prevent accidental leakage by supporting **reference sidecar** and **AST-based auto-ref**.

### Non‑Goals (for this phase)

- Running a truly continuous VM inside generic "stateless" platforms that do not provide session stickiness (e.g., pure serverless invocations).
- Preventing the runtime host/provider itself from seeing plaintext (that would require TEEs / enclaves and different threat assumptions).

---

## 2) Glossary

| Term                    | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**             | The component that runs AgentScript continuously (built on `enclave-vm`).                                                             |
| **Client**              | JS SDK used from browser/server to start a session with the middleware and consume the streamed events/results.                       |
| **Middleware / Broker** | Node.js service (often inside a VPC) that owns secrets and executes tool calls. Implemented in `@enclave-vm/broker`.                  |
| **Session**             | A long-lived, continuous execution context for a single piece of code (plus its stream + tool roundtrips).                            |
| **Tool**                | An external action callable from AgentScript via `callTool(name, args)`.                                                              |
| **Reference Sidecar**   | Per-session in-memory store of large/sensitive values addressed by `refId`.                                                           |
| **Auto-ref**            | AST-based decision that a tool result is never accessed/manipulated in runtime code, so it should be stored/passed by reference only. |

---

## 3) High-Level Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Your Application                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐   │
│   │  @enclave-vm/    │     │  @enclave-vm/    │     │  @enclave-vm/    │   │
│   │    client        │────▶│    broker        │────▶│   core (runtime) │   │
│   │  (browser/node)  │     │  (middleware)    │     │   (sandboxed)    │   │
│   └──────────────────┘     └──────────────────┘     └──────────────────┘   │
│          │                        │                         │               │
│          │                        │                         │               │
│          ▼                        ▼                         ▼               │
│   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐   │
│   │  NDJSON Stream   │     │  Tool Registry   │     │  Code Execution  │   │
│   │  Event Parsing   │     │  Secret Store    │     │  callTool() API  │   │
│   │  Reconnection    │     │  Session Mgmt    │     │  Value Sanitizer │   │
│   └──────────────────┘     └──────────────────┘     └──────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Packages

| Package               | npm                   | Description                                                               |
| --------------------- | --------------------- | ------------------------------------------------------------------------- |
| `@enclave-vm/core`    | `@enclave-vm/core`    | Core sandbox VM engine. Executes untrusted code safely.                   |
| `@enclave-vm/types`   | `@enclave-vm/types`   | Shared TypeScript types, Zod schemas, protocol constants.                 |
| `@enclave-vm/stream`  | `@enclave-vm/stream`  | NDJSON streaming protocol, event parsing, reconnection logic.             |
| `@enclave-vm/broker`  | `@enclave-vm/broker`  | Middleware: tool registry, secret management, session API, HTTP handlers. |
| `@enclave-vm/client`  | `@enclave-vm/client`  | Browser + Node SDK for connecting to middleware.                          |
| `@enclave-vm/runtime` | `@enclave-vm/runtime` | Building blocks of an extracted runtime worker. Does not execute yet.     |
| `@enclave-vm/react`   | `@enclave-vm/react`   | React hooks for session management.                                       |

---

## 4) Deployment Scenarios

### Scenario 1: Web → VPC (Embedded Runtime)

Browser connects to your VPC where middleware runs the runtime in-process. **Simplest deployment.**

```
┌─────────────┐        HTTPS/NDJSON        ┌──────────────────────────────┐
│   Browser   │ ◄────────────────────────► │       VPC / Your Server      │
│  (Client)   │    POST /sessions          │                              │
│             │    Stream events           │  ┌─────────────────────────┐ │
└─────────────┘                            │  │     @enclave-vm/broker   │ │
                                           │  │  • Tool Registry        │ │
                                           │  │  • Secrets (API keys)   │ │
                                           │  │  • Session Manager      │ │
                                           │  │                         │ │
                                           │  │  ┌───────────────────┐  │ │
                                           │  │  │  Embedded Runtime │  │ │
                                           │  │  │   (enclave-vm)    │  │ │
                                           │  │  └───────────────────┘  │ │
                                           │  └─────────────────────────┘ │
                                           └──────────────────────────────┘
```

**Example (Server):**

```typescript
import express from 'express';
import { createBroker, createSessionHandler, registerExpressRoutes } from '@enclave-vm/broker';
import { z } from 'zod';

const broker = createBroker()
  .secret('OPENAI_KEY', process.env.OPENAI_KEY!)
  .tool('gpt', {
    argsSchema: z.object({ prompt: z.string() }),
    secrets: ['OPENAI_KEY'],
    handler: async ({ prompt }, { secrets }) => {
      // Tool has access to secrets
      return await openai.chat({ prompt, apiKey: secrets['OPENAI_KEY'] });
    },
  });

const app = express();
app.use(express.json());
app.use(authenticate); // your authentication: the broker has none
registerExpressRoutes(
  app,
  createSessionHandler({
    broker,
    // Tells the routes who the caller is, so that a session belongs to the caller that created it
    identify: (request) => (request.raw as { user?: { id: string } }).user?.id,
  }),
);
app.listen(3000);
```

The broker does not authenticate callers. Without an `identify` hook its routes do not tell callers apart: whoever can reach them can list, read, replay and end every session (see the broker's README).

**Example (Browser):**

```typescript
const response = await fetch('https://your-server.com/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: `
      const answer = await callTool('gpt', { prompt: 'Hello!' });
      return answer;
    `,
  }),
});

// Parse NDJSON stream
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.trim()) {
      const event = JSON.parse(line);
      console.log(event.type, event.payload);
    }
  }
}
```

---

### Scenario 2: Web → VPC (Middleware) → Lambda/Vercel (Runtime)

> **Status: design, not implemented.** `@enclave-vm/broker` has no option to connect to a runtime worker, and `@enclave-vm/runtime` does not execute scripts: its `execute` request ends with `RuntimeNotImplementedError`.

Browser connects to middleware, but code execution happens on a separate Lambda/Vercel worker. **Intended for isolation and scale.**

```
┌─────────────┐    HTTPS/NDJSON    ┌─────────────────────┐    WebSocket    ┌─────────────────┐
│   Browser   │ ◄────────────────► │   VPC Middleware    │ ◄─────────────► │  Lambda/Vercel  │
│  (Client)   │  POST /sessions    │   @enclave-vm/broker │  session channel │    Runtime      │
│             │  Stream events     │                     │                  │                 │
└─────────────┘                    │  • Tool Registry    │                  │  • enclave-vm   │
                                   │  • Secrets          │                  │  • NO secrets   │
                                   │  • Session Manager  │                  │                 │
                                   └─────────────────────┘                  └─────────────────┘
```

**What the design is for:**

- **Scalability**: Lambda/Vercel scales horizontally for compute
- **Cost**: Pay-per-execution for runtime
- **Security**: Secrets never leave VPC middleware
- **Isolation**: Untrusted code runs in isolated Lambda environment

**Flow:**

```
Browser              VPC Middleware              Lambda Runtime
   │                      │                           │
   │─ POST /sessions ────►│                           │
   │                      │─── Invoke Lambda ────────►│
   │◄─ session_init ──────│◄── connected ─────────────│
   │                      │                           │
   │                      │─── execute(code) ────────►│
   │◄─ stdout ────────────│◄── stdout ────────────────│
   │                      │                           │
   │                      │◄── tool_call(gpt, args) ──│  // Runtime needs a tool
   │◄─ tool_call ─────────│                           │
   │                      │    [Execute with secrets] │
   │                      │─── tool_result ──────────►│  // Send result back
   │◄─ tool_result_applied│◄── applied ──────────────│
   │                      │                           │
   │◄─ final ─────────────│◄── final ────────────────│
```

---

### Scenario 3: Server → Embedded Runtime

Your backend server (Node.js) executes code directly. No HTTP/browser involved. **Best for backend automation.**

```
┌─────────────────────────────────────────────────────────┐
│                  Your Server (Node.js)                  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           Application Code                       │   │
│  │                                                  │   │
│  │   const result = await broker.execute(`         │   │
│  │     const users = await callTool('db_query',    │   │
│  │       { sql: 'SELECT * FROM users' });          │   │
│  │     return users;                               │   │
│  │   `);                                           │   │
│  └─────────────────────────────────────────────────┘   │
│                          │                              │
│                          ▼                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │              @enclave-vm/broker                   │   │
│  │   • Tool Registry    • Secrets                  │   │
│  │   • enclave-vm (sandboxed execution)            │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Example:**

```typescript
import { createBroker } from '@enclave-vm/broker';
import { z } from 'zod';

const broker = createBroker()
  .secret('DATABASE_URL', process.env.DATABASE_URL!)
  .tool('db_query', {
    argsSchema: z.object({ sql: z.string() }),
    secrets: ['DATABASE_URL'],
    handler: async ({ sql }, { secrets }) => {
      const db = new Database(secrets['DATABASE_URL']);
      return db.query(sql);
    },
  })
  .tool('send_email', {
    argsSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    handler: async (args) => sendgrid.send(args),
  });

// Execute AI-generated code safely
async function runAgentCode(agentCode: string) {
  const result = await broker.execute(agentCode, {
    onEvent: (event) => {
      if (event.type === 'tool_call') {
        console.log(`Agent calling: ${event.payload.toolName}`);
      }
    },
  });

  if (result.success) {
    return result.value;
  } else {
    throw new Error(result.error?.message);
  }
}

// Usage
const output = await runAgentCode(`
  const users = await callTool('db_query', {
    sql: 'SELECT email FROM users WHERE active = true'
  });

  for (const user of users) {
    await callTool('send_email', {
      to: user.email,
      subject: 'Weekly Update',
      body: 'Here is your summary...'
    });
  }

  return { notified: users.length };
`);
```

---

### Scenario 4: Server → Lambda/Vercel (Extracted Runtime)

> **Status: design, not implemented.** See the note on scenario 2.

Your server orchestrates but offloads code execution to Lambda/Vercel. **Intended for untrusted code isolation.**

```
┌──────────────────────────┐         WebSocket/HTTP        ┌─────────────────────┐
│    Your Server (Node)    │ ◄───────────────────────────► │   Lambda Runtime    │
│    @enclave-vm/broker     │                               │   @enclave-vm/runtime│
│                          │    session channel            │                     │
│  • Tool Registry         │    (tool_call/tool_result)    │  • enclave-vm       │
│  • Secrets               │                               │  • NO secrets       │
│  • Session coordination  │                               │  • Sandboxed exec   │
│                          │                               │                     │
└──────────────────────────┘                               └─────────────────────┘
```

**What the design is for:**

- **Security isolation**: Untrusted code runs in isolated Lambda
- **Resource isolation**: Lambda memory/CPU limits prevent abuse
- **Cost efficiency**: Only pay when code is running
- **Secrets protection**: Your server keeps all API keys/credentials

---

### Deployment Comparison

| Scenario                     | Client  | Middleware | Runtime       | Secrets Location | Best For                 | Status          |
| ---------------------------- | ------- | ---------- | ------------- | ---------------- | ------------------------ | --------------- |
| **1. Web→Embedded**          | Browser | VPC        | In-process    | VPC              | Simple deployments       | Implemented     |
| **2. Web→Middleware→Lambda** | Browser | VPC        | Lambda/Vercel | VPC only         | Scale + isolation        | Not implemented |
| **3. Server→Embedded**       | None    | Server     | In-process    | Server           | Backend automation       | Implemented     |
| **4. Server→Lambda**         | None    | Server     | Lambda/Vercel | Server only      | Untrusted code isolation | Not implemented |

**Key Principle**: Secrets always stay in the middleware/broker. The runtime only sees tool call requests and results, never the credentials used to execute them.

In the embedded deployments a session runs in the broker's own process and thread: a script that computes without calling a tool holds the thread, and with it every other session, until it ends or reaches its timeout. Run the broker in a process of its own, or give its sandbox the worker-pool adapter, when you serve callers you do not trust.

---

## 5) Why "continuous sessions" implies statefulness

If a session must be truly continuous and keep an in-memory sidecar, then all session I/O must reach the same live session host(s).

In this architecture, that typically means:

- **Embedded runtime**: the middleware is the session host (it owns the sidecar and runs `enclave-vm`), so it must be stateful for the session lifetime.
- **Extracted runtime** (design, not implemented): the middleware and the runtime worker both hold session state and communicate over a per-session channel; each side must be reachable for the duration.

### What does NOT work by itself

- "Pure" **stateless edge/serverless functions** as the session host:
  - no guarantee the next tool-result/cancel message lands on the same instance
  - no reliable in-memory sidecar across invocations

In those environments, the runtime must either:

- run on a **stateful** host (server/container or Durable Object), or
- use a **single per-session channel** (typically WebSocket) so messages are delivered to the correct live session without relying on load balancer affinity.

With the embedded runtime that exists today, this means: a session lives in the memory of the broker that created it. Behind a load balancer, a session's later requests (a reconnect to `GET /sessions/:sessionId/stream`, a cancel) have to reach that broker; another one answers with 404.

### How does the middleware deliver tool results to the right live session?

This question belongs to the extracted runtime (design). Because the sidecar and execution are in-memory, the runtime must route inbound messages to the correct live worker/actor:

- **Durable Objects**: route by `sessionId` → the platform delivers all requests to the same object instance.
- **Sticky load balancer**: consistent hashing / cookie affinity so the same `sessionId` lands on the same runtime node.
- **Gateway + session directory**: a gateway looks up `sessionId -> runtimeNode` in a directory store and forwards the request.
- **Single bidirectional session channel (WebSocket)**: avoids instance routing entirely by sending tool calls/results over the same session-bound connection.

---

## 6) Session API

The middleware API is designed so the **first request starts the session and returns a streamed response**.

### HTTP Endpoints

| Method   | Path                          | Description                                                  |
| -------- | ----------------------------- | ------------------------------------------------------------ |
| `GET`    | `/sessions`                   | List sessions (the caller's own, with an `identify` hook)    |
| `POST`   | `/sessions`                   | Create session and execute code (streams NDJSON)             |
| `GET`    | `/sessions/:sessionId`        | Get session information                                      |
| `GET`    | `/sessions/:sessionId/stream` | Replay the kept events from `?fromSeq=N` and follow the rest |
| `DELETE` | `/sessions/:sessionId`        | Terminate a session                                          |
| `POST`   | `/sessions/:sessionId/cancel` | Terminate a session (the `cancelUrl` of `session_init`)      |

There is no route for submitting a tool result: tools run in the broker, which applies their results itself.

### Streaming format

Day-1 recommendation: `application/x-ndjson`

- Works well with browser `fetch()` streaming (POST + readable stream)
- Easy framing (1 JSON object per line)

### Example: Create Session Request

```http
POST /sessions
Content-Type: application/json
Accept: application/x-ndjson
```

```json
{
  "code": "const users = await callTool('get_users', {}); return users;",
  "config": {
    "maxExecutionMs": 60000,
    "maxToolCalls": 50
  }
}
```

### Example: Streamed Response (NDJSON)

```jsonl
{"protocolVersion":2,"sessionId":"s_abc123","seq":1,"type":"session_init","payload":{"cancelUrl":"/sessions/s_abc123/cancel","expiresAt":"2024-01-01T00:01:00Z","encryption":{"enabled":false}}}
{"protocolVersion":2,"sessionId":"s_abc123","seq":2,"type":"tool_call","payload":{"callId":"c_xyz","toolName":"get_users","args":{}}}
{"protocolVersion":2,"sessionId":"s_abc123","seq":3,"type":"tool_result_applied","payload":{"callId":"c_xyz"}}
{"protocolVersion":2,"sessionId":"s_abc123","seq":4,"type":"final","payload":{"ok":true,"result":[{"id":1,"name":"Alice"}]}}
```

---

## 7) Stream Protocol (versioned, zod-validated)

Every message includes:

- `protocolVersion` - Protocol version (currently `2`; `1` is still accepted by the schemas)
- `sessionId` - Session identifier (`s_` prefix)
- `seq` - Monotonic sequence number
- `type` - Event type
- `payload` - Type-specific data

### Event Types

| Type                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `session_init`        | Session started, includes expiry and config |
| `stdout`              | Console output from user code               |
| `log`                 | Log message (debug/info/warn/error)         |
| `tool_call`           | Runtime requesting tool execution           |
| `tool_result_applied` | Tool result received by runtime             |
| `final`               | Session completed (success or failure)      |
| `heartbeat`           | Keep-alive signal                           |
| `error`               | Non-fatal error during execution            |
| `partial_result`      | Part of a result, with a path (version 2)   |
| `tool_progress`       | Progress of a tool call (version 2)         |
| `deadline_exceeded`   | The session's deadline passed (version 2)   |
| `catalog_changed`     | The tool catalog changed (version 2)        |
| `enc`                 | Encrypted envelope (defined, not produced)  |

### TypeScript Types (from `@enclave-vm/types`)

```typescript
import type { StreamEvent, SessionId, CallId } from '@enclave-vm/types';

// Event union type
type StreamEvent =
  | SessionInitEvent
  | StdoutEvent
  | LogEvent
  | ToolCallEvent
  | ToolResultAppliedEvent
  | FinalEvent
  | HeartbeatEvent
  | ErrorEvent
  | PartialResultEvent
  | ToolProgressEvent
  | DeadlineExceededEvent
  | CatalogChangedEvent;

// Base event structure
interface BaseEvent {
  protocolVersion: 2 | 1;
  sessionId: SessionId; // `s_${string}`
  seq: number;
  type: string;
}

// Final event payload
interface FinalPayload {
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
  stats?: { durationMs: number; toolCallCount: number; stdoutBytes: number };
}
```

---

## 8) Tool calls

Runtime code calls tools via the built-in `callTool` function:

```typescript
const result = await callTool('toolName', { arg1: 'value' });
```

### Tool Registration

```typescript
import { createBroker } from '@enclave-vm/broker';
import { z } from 'zod';

const broker = createBroker()
  .tool('get_user', {
    description: 'Fetch user by ID',
    argsSchema: z.object({ userId: z.string() }),
    handler: async ({ userId }) => {
      return await db.users.findById(userId);
    },
  })
  .tool('send_notification', {
    argsSchema: z.object({
      userId: z.string(),
      message: z.string(),
    }),
    secrets: ['TWILIO_KEY'], // Declare required secrets
    handler: async ({ userId, message }, { secrets }) => {
      return await twilio.send(userId, message, secrets['TWILIO_KEY']);
    },
  });
```

### Tool Broker Flow

1. Runtime emits `tool_call` event with `callId`, `toolName`, `args`
2. Broker validates args against Zod schema
3. Broker executes handler with resolved secrets
4. Broker sends result back to runtime
5. Runtime receives result and continues execution
6. `tool_result_applied` event emitted to stream

### Runtime Execution State Machine

```
                    ┌─────────────┐
                    │   Starting  │
                    └──────┬──────┘
                           │ session_init
                           ▼
                    ┌─────────────┐
            ┌──────►│   Running   │◄──────┐
            │       └──────┬──────┘       │
            │              │              │
            │   tool_call  │              │ tool_result
            │              ▼              │
            │       ┌─────────────┐       │
            └───────│WaitingForTool│──────┘
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
   ┌───────────┐    ┌───────────┐    ┌───────────┐
   │ Completed │    │ Cancelled │    │  Failed   │
   └───────────┘    └───────────┘    └───────────┘
```

---

## 9) Reference Sidecar + auto-ref (key decision)

> **Status.** `@enclave-vm/core` has a reference sidecar (`sidecar: { enabled: true }`): a tool result that is a string as a whole, of at least the extraction threshold, is stored outside the sandbox, the script holds a token of the form `__REF_<uuid>__`, and the token is resolved when the script passes it to another tool. The rest of this section is design and is **not implemented**: no AST-based auto-ref, no `{ $ref: { id } }` tokens in tool results (the `RefToken` type of `@enclave-vm/types` is not produced by any package), and a reference a script returns is not resolved for the caller.

### The problem

- Tool outputs can be large (throughput) and/or sensitive (secrets/PII).
- Many scripts only pass tool outputs into other tools or return them directly, without reading them in runtime code.

### Decision

- If a tool output is **not accessed or manipulated** by runtime code, it should be handled by **reference**:
  - stored in a per-session in-memory sidecar
  - replaced with a `{ $ref: { id } }` token
  - usable as an input to subsequent `callTool()` calls (ref-preserving)
  - returnable as final output (still by ref)

### Ref token format

```json
{ "$ref": { "id": "ref_abc123" } }
```

### Auto-ref via AST (conservative)

If a tool result is never accessed/manipulated, keep it by reference:

```typescript
// Auto-ref: users is only passed through, never accessed
const users = await callTool('get_users', {});
return await callTool('process_users', { users });

// Materialize: users.length is accessed
const users = await callTool('get_users', {});
return users.length;
```

---

## 10) Security: authentication + optional per-session encryption

### What the packages provide

- **Transport.** Requests and events travel as plain JSON. Always use TLS (`https`/`wss`): nothing else protects them.
- **Authentication.** None of the packages authenticates a caller. `@enclave-vm/broker` leaves it to the middleware you put in front of its routes; `@enclave-vm/client` sends the `headers` you give it and has no authentication option of its own.
- **Who may see a session.** With the `identify` hook of the broker's session routes, a session belongs to the caller that created it: another caller gets the answer of an id that does not exist, and a request without an identity is answered with 401. Without the hook the routes do not tell callers apart.
- **Limits.** The limits the embedder gives the broker (lifetime, tool calls, tool result size, per-tool deadline) bound every session; a request may lower `maxToolCalls` and the lifetime and cannot raise them.
- **Rate limiting.** Not provided. The broker bounds the registered sessions (`sessions.maxSessions`) and the streams per session.

### Authorization model

- `sessionId` is not a secret; treat it as a routing key.
- Every endpoint that mutates/observes session state requires authorization. In the broker this is the `identify` hook together with your authentication.
- The middleware ↔ runtime session channel must be authenticated (design: there is no such channel in the packages today, and `WebSocketChannel` of `@enclave-vm/runtime` sends no credentials).

### Optional per-session encryption

> **Status: not implemented as a protocol.** `@enclave-vm/stream` exports primitives (ephemeral ECDH on P-256, HKDF-SHA-256, AES-256-GCM, an envelope whose header is authenticated), and `@enclave-vm/types` defines the hello messages and the `enc` envelope. No client or broker of this repository uses them: the client refuses an `encryption` option and ends a session that receives an encrypted event, and the broker refuses a request that requires encryption. The key exchange of the primitives is not authenticated, so by themselves they protect against a party that can only read the connection, not against one that can change messages.

The design is per-hop encryption using:

- Ephemeral ECDH key exchange
- HKDF key derivation
- AES-GCM for message payloads
- Sequence numbers + nonces for replay protection

---

## 11) Platform notes (runtime placement)

### Capability Matrix

| Platform                       | Continuous Session         | Bidirectional Channel    | Recommended Role  |
| ------------------------------ | -------------------------- | ------------------------ | ----------------- |
| **Server/Container (Node)**    | ✅ Yes                     | WebSocket or NDJSON      | Universal runtime |
| **Cloudflare Durable Objects** | ✅ Yes (actor per session) | WebSocket                | Edge runtime      |
| **AWS Lambda**                 | ⚠️ Bounded (≤15 min)       | Outbound WS/HTTP         | Short sessions    |
| **Vercel Edge/Serverless**     | ❌ Not reliable            | Don't rely on inbound WS | Gateway only      |

### Recommendations

- **Server/container**: Best for most deployments. Run Node.js with `@enclave-vm/broker`. This is the placement the packages support today.
- **Cloudflare DO**: A candidate for edge deployment with global distribution (design; no package targets it).
- **Lambda**: A candidate for short-lived sessions or as extracted runtime with middleware coordination (design; the extracted runtime is not implemented).
- **Vercel Edge**: Use only as gateway/proxy to stateful runtime.

---

## 12) Open questions / follow-ups

- [ ] Do we standardize on NDJSON first and add WebSocket later, or ship both from day 1?
- [ ] Should middleware resolve refs automatically for browser clients (size/policy based)?
- [ ] How do we expose a safe "return refs" UX (auto-resolve vs explicit `resolveRefs()` API)?
- [ ] What's the recommended packaging path for hosted broker vs hosted runtime?
