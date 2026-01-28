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
import { StreamMessage, ToolCallMessage, ToolResultMessage, SessionState } from '@enclave-vm/types';

// Type-safe message handling
function handleMessage(message: StreamMessage) {
  switch (message.type) {
    case 'tool_call':
      const toolCall = message as ToolCallMessage;
      console.log(`Tool: ${toolCall.name}, Args:`, toolCall.args);
      break;
    case 'tool_result':
      const result = message as ToolResultMessage;
      console.log(`Result:`, result.data);
      break;
  }
}
```

## Protocol Messages

### Stream Messages

```typescript
import { StreamMessageSchema, StreamMessage } from '@enclave-vm/types';

// Validate incoming messages
const message = StreamMessageSchema.parse(rawMessage);
```

### Tool Calls

```typescript
import { ToolCallMessage, ToolResultMessage } from '@enclave-vm/types';

const toolCall: ToolCallMessage = {
  type: 'tool_call',
  id: 'call_123',
  name: 'getUser',
  args: { userId: 1 },
};

const toolResult: ToolResultMessage = {
  type: 'tool_result',
  id: 'call_123',
  data: { name: 'Alice', email: 'alice@example.com' },
};
```

### Session State

```typescript
import { SessionState, SessionStatus } from '@enclave-vm/types';

const session: SessionState = {
  id: 'session_abc',
  status: 'running',
  createdAt: new Date(),
  toolCallCount: 5,
};
```

## Zod Schemas

All types have corresponding Zod schemas for runtime validation:

```typescript
import { StreamMessageSchema, ToolCallMessageSchema, SessionStateSchema } from '@enclave-vm/types';

// Parse and validate
const message = StreamMessageSchema.safeParse(untrustedData);
if (message.success) {
  // message.data is typed correctly
  handleMessage(message.data);
} else {
  console.error('Invalid message:', message.error);
}
```

## Related Packages

| Package                                     | Description                        |
| ------------------------------------------- | ---------------------------------- |
| [@enclave-vm/stream](../enclavejs-stream)   | Streaming protocol implementation  |
| [@enclave-vm/broker](../enclavejs-broker)   | Tool broker and session management |
| [@enclave-vm/client](../enclavejs-client)   | Browser/Node.js client SDK         |
| [@enclave-vm/react](../enclavejs-react)     | React hooks and components         |
| [@enclave-vm/runtime](../enclavejs-runtime) | Standalone runtime worker          |

## License

Apache-2.0
