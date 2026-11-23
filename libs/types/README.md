# @enclave-vm/types

TypeScript types, Zod schemas and small helpers for the EnclaveJS streaming protocol, for code that produces or consumes session events.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/types.svg)](https://www.npmjs.com/package/@enclave-vm/types)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

This package is the base of the streaming packages: [`@enclave-vm/stream`](https://www.npmjs.com/package/@enclave-vm/stream) re-exports all of it, and [`@enclave-vm/broker`](https://www.npmjs.com/package/@enclave-vm/broker), [`@enclave-vm/client`](https://www.npmjs.com/package/@enclave-vm/client) and [`@enclave-vm/runtime`](https://www.npmjs.com/package/@enclave-vm/runtime) build on it. Its only dependency is `zod`.

## Install

```bash
npm install @enclave-vm/types
```

## Quick start

```typescript
import { parseStreamEvent, isToolCallEvent, isFinalEvent, type StreamEvent } from '@enclave-vm/types';

function handleEvent(event: StreamEvent): void {
  if (isToolCallEvent(event)) {
    console.log(`Tool: ${event.payload.toolName}, args:`, event.payload.args);
  } else if (isFinalEvent(event)) {
    console.log(event.payload.ok ? 'Result:' : 'Error:', event.payload.result ?? event.payload.error);
  }
}

// Validate data that came from the network before using it
const untrusted: unknown = JSON.parse(
  '{"protocolVersion":2,"sessionId":"s_1","seq":1,"type":"stdout","payload":{"chunk":"Hello"}}',
);
const parsed = parseStreamEvent(untrusted); // StreamEventSchema.safeParse(untrusted)
if (parsed.success) {
  // The schemas type ids as `string`, the interfaces as `s_${string}`: hence the cast
  handleEvent(parsed.data as StreamEvent);
} else {
  console.error('Invalid event:', parsed.error);
}
```

## Stream events

Every event has `protocolVersion`, `sessionId`, a sequence number `seq`, a `type` and a `payload`:

```typescript
import { PROTOCOL_VERSION, type ToolCallEvent, type FinalEvent } from '@enclave-vm/types';

const toolCall: ToolCallEvent = {
  protocolVersion: PROTOCOL_VERSION, // 2
  sessionId: 's_3f0e2f6e-1c1b-4c57-9a55-0a8b5a3d2c11',
  seq: 2,
  type: 'tool_call',
  payload: {
    callId: 'c_9a55e2f6-4c57-1c1b-3f0e-0a8b5a3d2c11',
    toolName: 'getUser',
    args: { userId: 1 },
  },
};

const final: FinalEvent = {
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 's_3f0e2f6e-1c1b-4c57-9a55-0a8b5a3d2c11',
  seq: 4,
  type: 'final',
  payload: {
    ok: true,
    result: { name: 'Alice' },
    stats: { durationMs: 120, toolCallCount: 1, stdoutBytes: 0 },
  },
};
```

Each event type has a TypeScript type, a Zod schema and a type guard:

| `type`                | Type                     | Schema                         | Guard                      |
| --------------------- | ------------------------ | ------------------------------ | -------------------------- |
| `session_init`        | `SessionInitEvent`       | `SessionInitEventSchema`       | `isSessionInitEvent`       |
| `stdout`              | `StdoutEvent`            | `StdoutEventSchema`            | `isStdoutEvent`            |
| `log`                 | `LogEvent`               | `LogEventSchema`               | `isLogEvent`               |
| `tool_call`           | `ToolCallEvent`          | `ToolCallEventSchema`          | `isToolCallEvent`          |
| `tool_result_applied` | `ToolResultAppliedEvent` | `ToolResultAppliedEventSchema` | `isToolResultAppliedEvent` |
| `final`               | `FinalEvent`             | `FinalEventSchema`             | `isFinalEvent`             |
| `heartbeat`           | `HeartbeatEvent`         | `HeartbeatEventSchema`         | `isHeartbeatEvent`         |
| `error`               | `ErrorEvent`             | `ErrorEventSchema`             | `isErrorEvent`             |
| `partial_result`      | `PartialResultEvent`     | `PartialResultEventSchema`     | `isPartialResultEvent`     |
| `tool_progress`       | `ToolProgressEvent`      | `ToolProgressEventSchema`      | `isToolProgressEvent`      |
| `deadline_exceeded`   | `DeadlineExceededEvent`  | `DeadlineExceededEventSchema`  | `isDeadlineExceededEvent`  |
| `catalog_changed`     | `CatalogChangedEvent`    | `CatalogChangedEventSchema`    | `isCatalogChangedEvent`    |

The last four were added in protocol version 2. `StreamEvent` and `StreamEventSchema` are the union of all of them. `EventType` holds the type names as constants, including `Encrypted` (`'enc'`) for the encrypted envelope described below.

## Identifiers, session state and limits

```typescript
import {
  generateSessionId,
  generateCallId,
  isSessionId,
  SessionState,
  DEFAULT_SESSION_LIMITS,
} from '@enclave-vm/types';

const sessionId = generateSessionId(); // 's_' followed by crypto.randomUUID()
const callId = generateCallId(); // 'c_' followed by crypto.randomUUID()

isSessionId(sessionId); // true: checks the 's_' prefix only

SessionState.Running; // 'running'
// 'starting' | 'running' | 'waiting_for_tool' | 'completed' | 'cancelled' | 'failed'
```

`generateRefId`, `isCallId`, `isRefId`, `createRefToken` and `isRefToken` work the same way for call ids and `ref_` reference ids.

`SessionLimits` describes the limits of a session. `DEFAULT_SESSION_LIMITS` holds the defaults that `@enclave-vm/broker` applies:

| Field                 | Default           | Meaning                                                                                                    |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `sessionTtlMs`        | `60000`           | How long a session lives                                                                                   |
| `maxToolCalls`        | `50`              | Tool calls per session                                                                                     |
| `maxStdoutBytes`      | `262144`          | Output bytes (the broker emits no `stdout` events and does not use it)                                     |
| `maxToolResultBytes`  | `5242880`         | Size of one tool result                                                                                    |
| `toolTimeoutMs`       | `30000`           | How long the script may run (the name is historical; the broker passes it to the sandbox as its `timeout`) |
| `heartbeatIntervalMs` | `15000`           | Interval of `heartbeat` events                                                                             |
| `deadlineMs`          | `0` (no deadline) | Deadline for the whole session                                                                             |
| `perToolDeadlineMs`   | `30000`           | Time one tool call may take                                                                                |
| `cancelOnFirstError`  | `false`           | Whether the first failed tool call cancels the session                                                     |

`ToolConfig` has four fields. Only `timeout` has an effect; `retryable`, `maxRetries` and `runtimeReadable` are part of the protocol design and no package acts on them.

## Other definitions

- **Runtime channel messages**: `ToolResultSubmitMessage`, `CancelMessage` and `RuntimeChannelMessage`, with schemas and `parseRuntimeChannelMessage`.
- **Event filters**: `EventFilterConfig`, `FilterRule`, `ContentPattern`, `FilterMode`, `PatternType` and `DEFAULT_ALWAYS_ALLOW` (`['session_init', 'final']`). `@enclave-vm/broker` implements filters from these definitions.
- **Validation helpers**: `parseStreamEvent`, `parseEncryptedEnvelope`, `parseRuntimeChannelMessage`, `parseCreateSessionRequest` and `parseStreamEventOrEncrypted`. Each returns the result of Zod's `safeParse`.
- **Create-session request**: `CreateSessionRequest` and `CreateSessionRequestSchema` (`code`, `sessionId?`, `config?`, `filter?`), with `CreateSessionConfig` / `CreateSessionConfigSchema` (`maxExecutionMs`, `maxToolCalls`, `heartbeatIntervalMs`) and `EventFilterConfigSchema`. This is the body of `POST /sessions`: `@enclave-vm/client` sends it and `@enclave-vm/broker` reads it. The broker accepts less than the schema allows (its bounds are in the broker's README).

## Security notes

The package defines types for an encrypted envelope and a key exchange (`EncryptedEnvelope`, `ClientHello`, `ServerHello`, `EncryptionRequest`, and constants such as `AES_GCM_NONCE_SIZE`). They are only definitions. No client or broker in this repository encrypts a session, and the key exchange they describe is not authenticated. Sessions are plain JSON, protected only by the transport.

The type guards (`isToolCallEvent` and the others) check the `type` field only. To check data you received, use a schema or a `parse*` helper.

## Related packages

| Package                                                                  | Role                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| [@enclave-vm/stream](https://www.npmjs.com/package/@enclave-vm/stream)   | NDJSON, reconnection helpers, encryption primitives    |
| [@enclave-vm/broker](https://www.npmjs.com/package/@enclave-vm/broker)   | Tool broker, sessions and HTTP routes                  |
| [@enclave-vm/client](https://www.npmjs.com/package/@enclave-vm/client)   | Browser and Node.js client for a broker                |
| [@enclave-vm/react](https://www.npmjs.com/package/@enclave-vm/react)     | React provider and hooks on top of the client          |
| [@enclave-vm/runtime](https://www.npmjs.com/package/@enclave-vm/runtime) | Runtime worker building blocks (does not execute code) |

## Documentation

- Documentation: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Architecture: https://github.com/agentfront/enclave/blob/main/README-ARCHITECTURE.md
- Security policy: https://github.com/agentfront/enclave/blob/main/SECURITY.md

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
