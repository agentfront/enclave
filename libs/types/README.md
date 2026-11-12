# @enclave-vm/types

[![npm version](https://img.shields.io/npm/v/@enclave-vm/types.svg)](https://www.npmjs.com/package/@enclave-vm/types)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Type definitions and Zod schemas for the EnclaveJS streaming runtime protocol

The @enclave-vm/types package provides TypeScript type definitions and runtime validation schemas for the EnclaveJS streaming protocol. It serves as the foundation for type-safe communication between EnclaveJS components.

## Features

- **TypeScript-First**: Full TypeScript support with strict typing
- **Zod Schemas**: Runtime validation for all protocol messages
- **Protocol Types**: Complete type definitions for streaming messages
- **Session Types**: Types for session management and state
- **Tool Types**: Type definitions for tool calls and responses

## Installation

```bash
npm install @enclave-vm/types
# or
yarn add @enclave-vm/types
# or
pnpm add @enclave-vm/types
```

## Quick Start

```typescript
import { isToolCallEvent, isFinalEvent, type StreamEvent } from '@enclave-vm/types';

// Type-safe event handling
function handleEvent(event: StreamEvent) {
  if (isToolCallEvent(event)) {
    console.log(`Tool: ${event.payload.toolName}, Args:`, event.payload.args);
  } else if (isFinalEvent(event)) {
    console.log(event.payload.ok ? 'Result:' : 'Error:', event.payload.result ?? event.payload.error);
  }
}
```

## Protocol

### Stream Events

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

The event types are `session_init`, `stdout`, `log`, `tool_call`, `tool_result_applied`, `final`, `heartbeat`, `error`, and since protocol version 2 `partial_result`, `tool_progress`, `deadline_exceeded` and `catalog_changed`. Each has a type (`ToolCallEvent`), a schema (`ToolCallEventSchema`) and a type guard (`isToolCallEvent`).

### Identifiers and Session State

```typescript
import {
  generateSessionId,
  generateCallId,
  isSessionId,
  SessionState,
  DEFAULT_SESSION_LIMITS,
} from '@enclave-vm/types';

const sessionId = generateSessionId(); // 's_' followed by a UUID
const callId = generateCallId(); // 'c_' followed by a UUID

isSessionId(sessionId); // true

SessionState.Running; // 'running'
// 'starting' | 'running' | 'waiting_for_tool' | 'completed' | 'cancelled' | 'failed'

DEFAULT_SESSION_LIMITS.maxToolCalls; // 50
```

## Zod Schemas

The types have corresponding Zod schemas for runtime validation:

```typescript
import { StreamEventSchema, parseStreamEvent } from '@enclave-vm/types';

// Parse and validate
const parsed = StreamEventSchema.safeParse(untrustedData);
if (parsed.success) {
  // parsed.data is typed as StreamEvent
  handleEvent(parsed.data);
} else {
  console.error('Invalid event:', parsed.error);
}

// The same, as a helper
const result = parseStreamEvent(untrustedData);
```

## What the Package Does Not Do

The package defines types for an encrypted envelope and a key exchange (`EncryptedEnvelope`, `ClientHello`, `ServerHello`). They are definitions: no client or broker of this repository encrypts a session, and the key exchange they describe is not authenticated. Sessions are plain JSON protected by the transport.

## Related Packages

| Package                           | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| [@enclave-vm/stream](../stream)   | Streaming protocol implementation                       |
| [@enclave-vm/broker](../broker)   | Tool broker and session management                      |
| [@enclave-vm/client](../client)   | Browser/Node.js client SDK                              |
| [@enclave-vm/react](../react)     | React hooks and components                              |
| [@enclave-vm/runtime](../runtime) | Runtime worker building blocks (not a runnable service) |

## License

Apache-2.0
