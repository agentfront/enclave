# @enclave-vm/stream

[![npm version](https://img.shields.io/npm/v/@enclave-vm/stream.svg)](https://www.npmjs.com/package/@enclave-vm/stream)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Streaming protocol implementation for EnclaveJS runtime (NDJSON, encryption, reconnection)

The @enclave-vm/stream package provides the core streaming protocol implementation for EnclaveJS. It handles NDJSON serialization, end-to-end encryption using ECDH/AES-GCM, and automatic reconnection with state recovery.

## Features

- **NDJSON Streaming**: Newline-delimited JSON for efficient message streaming
- **End-to-End Encryption**: ECDH key exchange with AES-GCM encryption
- **Automatic Reconnection**: Built-in reconnection with exponential backoff
- **State Recovery**: Resume sessions after disconnection
- **Backpressure Handling**: Flow control for high-throughput scenarios
- **Cross-Platform**: Works in Node.js and browsers

## Installation

```bash
npm install @enclave-vm/stream
# or
yarn add @enclave-vm/stream
# or
pnpm add @enclave-vm/stream
```

## Quick Start

```typescript
import { StreamEncoder, StreamDecoder, createEncryptedChannel } from '@enclave-vm/stream';

// Basic NDJSON encoding/decoding
const encoder = new StreamEncoder();
const decoder = new StreamDecoder();

// Encode messages
const encoded = encoder.encode({ type: 'tool_call', name: 'getData', args: {} });

// Decode messages
decoder.on('message', (message) => {
  console.log('Received:', message);
});
decoder.write(encoded);
```

## Encrypted Channels

Create end-to-end encrypted communication channels:

```typescript
import { createEncryptedChannel } from '@enclave-vm/stream';

// Server side
const serverChannel = await createEncryptedChannel({
  role: 'server',
  onMessage: (message) => {
    console.log('Decrypted message:', message);
  },
});

// Get server's public key to send to client
const serverPublicKey = serverChannel.getPublicKey();

// Client side
const clientChannel = await createEncryptedChannel({
  role: 'client',
  remotePublicKey: serverPublicKey,
  onMessage: (message) => {
    console.log('Decrypted message:', message);
  },
});

// Send encrypted messages
await clientChannel.send({ type: 'tool_call', name: 'secretOp', args: {} });
```

## Reconnection

Handle connection drops gracefully:

```typescript
import { ReconnectingStream } from '@enclave-vm/stream';

const stream = new ReconnectingStream({
  url: 'wss://runtime.example.com',
  sessionId: 'session_123',
  reconnect: {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
  },
  onReconnect: (attempt) => {
    console.log(`Reconnecting (attempt ${attempt})...`);
  },
  onMessage: (message) => {
    handleMessage(message);
  },
});

await stream.connect();
```

## NDJSON Utilities

```typescript
import { parseNDJSON, stringifyNDJSON } from '@enclave-vm/stream';

// Parse NDJSON string
const messages = parseNDJSON(ndjsonString);

// Stringify to NDJSON
const ndjson = stringifyNDJSON([
  { type: 'start', sessionId: '123' },
  { type: 'tool_call', name: 'getData', args: {} },
  { type: 'end' },
]);
```

## Encryption Details

The encryption implementation uses:

- **Key Exchange**: ECDH (Elliptic Curve Diffie-Hellman) with P-256 curve
- **Symmetric Encryption**: AES-256-GCM with random IV per message
- **Key Derivation**: HKDF for deriving encryption keys from shared secret

```typescript
import { generateKeyPair, deriveSharedSecret, encrypt, decrypt } from '@enclave-vm/stream';

// Generate key pairs
const serverKeys = await generateKeyPair();
const clientKeys = await generateKeyPair();

// Derive shared secret
const serverSecret = await deriveSharedSecret(serverKeys.privateKey, clientKeys.publicKey);
const clientSecret = await deriveSharedSecret(clientKeys.privateKey, serverKeys.publicKey);

// Encrypt/decrypt messages
const encrypted = await encrypt(serverSecret, JSON.stringify(message));
const decrypted = await decrypt(clientSecret, encrypted);
```

## Related Packages

| Package                                     | Description                        |
| ------------------------------------------- | ---------------------------------- |
| [@enclave-vm/types](../enclavejs-types)     | Type definitions and Zod schemas   |
| [@enclave-vm/broker](../enclavejs-broker)   | Tool broker and session management |
| [@enclave-vm/client](../enclavejs-client)   | Browser/Node.js client SDK         |
| [@enclave-vm/react](../enclavejs-react)     | React hooks and components         |
| [@enclave-vm/runtime](../enclavejs-runtime) | Standalone runtime worker          |

## License

Apache-2.0
