# @enclave-vm/stream

[![npm version](https://img.shields.io/npm/v/@enclave-vm/stream.svg)](https://www.npmjs.com/package/@enclave-vm/stream)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> Streaming protocol building blocks for EnclaveJS (NDJSON, reconnection helpers, encryption primitives)

The @enclave-vm/stream package provides the building blocks of the EnclaveJS streaming protocol: NDJSON serialization and parsing, helpers for reconnection, and encryption primitives built on the Web Crypto API. It also re-exports everything from `@enclave-vm/types`.

> **No EnclaveJS package uses the encryption primitives.** `@enclave-vm/client`, `@enclave-vm/react`, `@enclave-vm/broker` and `@enclave-vm/runtime` do not encrypt, perform no handshake and have no encryption option. A session between the client and the broker is plain JSON protected only by the transport, so serve it over HTTPS. The encryption functions of this package are for an application that implements both ends of an encrypted channel itself. See [Encryption Primitives](#encryption-primitives) for what such an application has to do.

## Features

- **NDJSON**: Serialize and parse stream events, one JSON object per line, with a limit on the line length
- **Reconnection Helpers**: Backoff state machine, sequence tracker, event buffer and heartbeat monitor
- **Encryption Primitives**: ECDH P-256 key exchange helpers, HKDF-SHA-256 key derivation, AES-256-GCM and the `enc` envelope
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
import { serializeEvent, NdjsonStreamParser } from '@enclave-vm/stream';

// One event per line
const line = serializeEvent({
  protocolVersion: 2,
  sessionId: 's_123',
  seq: 1,
  type: 'stdout',
  payload: { chunk: 'Hello\n' },
});

// Incremental parsing: a chunk may end in the middle of a line
const parser = new NdjsonStreamParser({
  onEvent: (event) => console.log('Received:', event.type),
  onError: (error) => console.error(`Line ${error.line}: ${error.error}`),
});

parser.feed(line.slice(0, 20));
parser.feed(line.slice(20) + '\n');

// When the stream ends
parser.flush();
```

## NDJSON

| Export                                | Description                                                              |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `serializeEvent(event)`               | One event as one line (no trailing newline)                              |
| `serializeEvents(events)`             | Several events, joined with `\n`                                         |
| `parseLine(line)`                     | Parse and validate one line: `{ success, data }` or `{ success, error }` |
| `parseLines(data)`                    | Parse several lines: `{ events, errors }`                                |
| `NdjsonStreamParser`                  | Incremental parser (`feed`, `flush`) with `onEvent` and `onError`        |
| `createNdjsonParseStream(options?)`   | `TransformStream` from text chunks to events                             |
| `createNdjsonSerializeStream()`       | `TransformStream` from events to lines                                   |
| `parseNdjsonStream(stream, options?)` | Async generator over a `ReadableStream<Uint8Array>` (a `fetch()` body)   |

Lines are validated against the event schemas of `@enclave-vm/types`. `NdjsonStreamParser` reports a line that is not an event through `onError`; `createNdjsonParseStream` and `parseNdjsonStream` skip it.

The incremental parsers take a `maxLineLength` option, in characters. The default is `DEFAULT_MAX_LINE_LENGTH` (8 MiB). When a line is longer:

- `NdjsonStreamParser` reports it once through `onError` and skips it.
- `createNdjsonParseStream` and `parseNdjsonStream` end with an `NdjsonLineTooLongError`.

A `maxLineLength` that is not a positive integer throws a `RangeError`.

```typescript
import { parseNdjsonStream } from '@enclave-vm/stream';

const response = await fetch('https://api.example.com/sessions/s_123/stream');
if (!response.body) throw new Error('No response body');

for await (const event of parseNdjsonStream(response.body, { maxLineLength: 1024 * 1024 })) {
  console.log(event.type);
}
```

## Reconnection Helpers

The package does not open connections. These classes keep the state of a connection that the application opens:

```typescript
import { ConnectionState, ReconnectionStateMachine, SequenceTracker } from '@enclave-vm/stream';

const tracker = new SequenceTracker();

const connection = new ReconnectionStateMachine({
  config: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
  onEvent: (event) => {
    if (event.type === 'state_change' && event.state === ConnectionState.Connecting) {
      // Open the connection here, asking for the events after tracker.getLastSeq()
    }
    if (event.type === 'retry_scheduled') {
      console.log(`Reconnecting in ${event.delayMs}ms (attempt ${event.attempt})`);
    }
  },
});

connection.connect();

// Report what happens to the connection
connection.onConnected();
connection.onDisconnected('network error'); // schedules a retry with exponential backoff

// For every event received
function track(event: { seq: number }): void {
  const { gap, missingStart, missingEnd } = tracker.receive(event.seq);
  if (gap) console.log(`Missing events ${missingStart} to ${missingEnd}`);
}
```

| Export                        | Description                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `ReconnectionStateMachine`    | Connection state and retries with exponential backoff and jitter                    |
| `ConnectionState`             | `Disconnected`, `Connecting`, `Connected`, `Reconnecting`, `Failed`, `Closed`       |
| `DEFAULT_RECONNECTION_CONFIG` | 5 retries, 1 s initial delay, 30 s maximum delay, multiplier 2, jitter factor 0.3   |
| `SequenceTracker`             | Last sequence number received and the gaps before it                                |
| `EventBuffer`                 | Bounded buffer of events (1000 by default); `add()` returns `false` when it is full |
| `HeartbeatMonitor`            | Calls `onTimeout` when no heartbeat was reported for `timeoutMs`                    |

## Encryption Primitives

The package exports ECDH P-256 key exchange helpers, HKDF-SHA-256 key derivation, AES-256-GCM encryption and the `enc` envelope of the protocol. Nothing in EnclaveJS calls them: an application that wants payload encryption has to write both ends, exchange the hello messages and envelopes over its own endpoints, and keep using TLS.

```typescript
import {
  generateKeyPair,
  createClientHello,
  processClientHello,
  processServerHello,
  deriveSharedSecret,
  deriveSessionKeys,
  SessionEncryptionContext,
} from '@enclave-vm/stream';

const sessionId = 's_123';

// Client: ephemeral key pair and hello
const clientKeyPair = await generateKeyPair();
const clientHello = await createClientHello(clientKeyPair);

// Server: answer the hello, derive the session keys
const { serverKeyPair, peerPublicKey: clientPublicKey, serverHello, keyId } = await processClientHello(clientHello);
const serverSecret = await deriveSharedSecret(serverKeyPair.privateKey, clientPublicKey);
const serverKeys = await deriveSessionKeys(serverSecret, sessionId);

// Client: read the server hello, derive the same session keys
const { peerPublicKey: serverPublicKey } = await processServerHello(serverHello);
const clientSecret = await deriveSharedSecret(clientKeyPair.privateKey, serverPublicKey);
const clientKeys = await deriveSessionKeys(clientSecret, sessionId);

// One context per direction, on each side
const serverSends = await SessionEncryptionContext.fromKeyBytes(serverKeys.serverToClientKey, keyId);
const clientReceives = await SessionEncryptionContext.fromKeyBytes(clientKeys.serverToClientKey, keyId);

// Server: wrap an event in an `enc` envelope
const envelope = await serverSends.createEnvelope(sessionId, 1, { type: 'stdout', payload: { chunk: 'Hello\n' } });

// Client: open it
const event = await clientReceives.openEnvelope(envelope);
```

What the primitives do, and what is left to the application:

- **The key exchange is not authenticated.** `ServerHello.signatureB64` is neither created nor verified, and there is no key confirmation. The exchange protects against a party that can only read the connection. A party that can change messages can replace both public keys. An application that needs more has to authenticate the hello messages itself (for example by signing them with a key the client pins) or rely on TLS for the identity of the server.
- **There are two keys, one per direction.** `deriveSessionKeys` and `deriveSessionCryptoKeys` return `clientToServerKey` and `serverToClientKey`. Use one `SessionEncryptionContext` per direction, never one context for both.
- **An envelope authenticates its header.** `createEncryptedEnvelope(key, keyId, sessionId, seq, innerEvent, nonce?)` and `context.createEnvelope(sessionId, seq, innerEvent)` authenticate the protocol version, session id, sequence number and key id together with the event. Read envelopes with `openEncryptedEnvelope(key, envelope)` or `context.openEnvelope(envelope)`: they throw `AesGcmError` when the ciphertext or a header field differs.
- **`decryptJson` does not open an envelope.** `decryptJson(key, payload)` and `context.decryptJson(payload)` read payloads made by `encryptJson`. Both forms of `encryptJson` and `decryptJson` take optional additional authenticated data.
- **Replays are for the receiver to detect.** Opening an envelope does not tell whether its sequence number was seen before. Compare it with the last one received, for example with `SequenceTracker`.
- **A context has a message limit.** `SessionEncryptionContext` uses a counter nonce (8 random bytes per context and a 32-bit counter) and refuses to encrypt after 2^30 messages (`needsRotation()` then returns `true`). There is no rotation: exchange keys again.
- **Key material.** `generateKeyPair` returns a private key that cannot be exported. `deriveSessionKeys` returns raw key bytes, and so does `context.toKeyInfo()`: treat both as the key itself.
- **Errors.** `processClientHello` and `processServerHello` throw `EcdhError` for a protocol version, curve, algorithm or key derivation that is not implemented. `fromBase64` throws `AesGcmError` on malformed input. `generateCounterNonce` throws for a counter outside 0 to 2^32 - 1.

## Related Packages

| Package                                     | Description                                             |
| ------------------------------------------- | ------------------------------------------------------- |
| [@enclave-vm/types](../enclavejs-types)     | Type definitions and Zod schemas                        |
| [@enclave-vm/broker](../enclavejs-broker)   | Tool broker and session management                      |
| [@enclave-vm/client](../enclavejs-client)   | Browser/Node.js client SDK                              |
| [@enclave-vm/react](../enclavejs-react)     | React hooks and components                              |
| [@enclave-vm/runtime](../enclavejs-runtime) | Runtime worker building blocks (not a runnable service) |

## License

Apache-2.0
