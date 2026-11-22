# @enclave-vm/stream

Building blocks of the EnclaveJS streaming protocol (NDJSON serialization and parsing, reconnection helpers, and encryption primitives) for code that reads or writes session event streams.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/stream.svg)](https://www.npmjs.com/package/@enclave-vm/stream)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

The package builds on [`@enclave-vm/types`](https://www.npmjs.com/package/@enclave-vm/types) and re-exports all of it. [`@enclave-vm/client`](https://www.npmjs.com/package/@enclave-vm/client) reads broker streams with its NDJSON parser and reconnection state machine, and [`@enclave-vm/runtime`](https://www.npmjs.com/package/@enclave-vm/runtime) serializes events with it. The stream helpers use the WHATWG `TransformStream` and `TextDecoder`; the encryption functions need the Web Crypto API (`globalThis.crypto.subtle`) and throw when it is missing.

> **No EnclaveJS package uses the encryption primitives.** `@enclave-vm/client`, `@enclave-vm/react`, `@enclave-vm/broker` and `@enclave-vm/runtime` do not encrypt, perform no handshake and have no encryption option. A session between the client and the broker is plain JSON, protected only by the transport, so serve it over HTTPS. The encryption functions of this package are for an application that implements both ends of an encrypted channel itself. See [Encryption primitives](#encryption-primitives) for what such an application has to do.

## Install

```bash
npm install @enclave-vm/stream
```

## Quick start

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

The incremental parsers take one option:

| Option          | Type     | Default                           | Meaning                                                                          |
| --------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `maxLineLength` | `number` | `DEFAULT_MAX_LINE_LENGTH` (8 MiB) | Longest line accepted, in characters. A positive integer, otherwise `RangeError` |

When a line is longer:

- `NdjsonStreamParser` reports it once through `onError` and skips it.
- `createNdjsonParseStream` and `parseNdjsonStream` end with an `NdjsonLineTooLongError`.

```typescript
import { parseNdjsonStream } from '@enclave-vm/stream';

const response = await fetch('https://api.example.com/sessions/s_123/stream');
if (!response.body) throw new Error('No response body');

for await (const event of parseNdjsonStream(response.body, { maxLineLength: 1024 * 1024 })) {
  console.log(event.type);
}
```

## Reconnection helpers

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

| Export                     | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `ReconnectionStateMachine` | Connection state and retries with exponential backoff and jitter                    |
| `ConnectionState`          | `Disconnected`, `Connecting`, `Connected`, `Reconnecting`, `Failed`, `Closed`       |
| `SequenceTracker`          | Last sequence number received and the gaps before it                                |
| `EventBuffer`              | Bounded buffer of events (1000 by default); `add()` returns `false` when it is full |
| `HeartbeatMonitor`         | Calls `onTimeout` when no heartbeat was reported for `timeoutMs`                    |

`ReconnectionStateMachine` takes a partial `ReconnectionConfig`; missing fields come from `DEFAULT_RECONNECTION_CONFIG`:

| Field               | Type      | Default | Meaning                                                                                                   |
| ------------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `maxRetries`        | `number`  | `5`     | Retries before the state becomes `Failed`                                                                 |
| `initialDelayMs`    | `number`  | `1000`  | Delay before the first retry                                                                              |
| `maxDelayMs`        | `number`  | `30000` | Upper bound of the delay before jitter; with `jitter` a delay can reach `maxDelayMs * (1 + jitterFactor)` |
| `backoffMultiplier` | `number`  | `2`     | Factor applied to the delay after each retry                                                              |
| `jitter`            | `boolean` | `true`  | Randomize the delay                                                                                       |
| `jitterFactor`      | `number`  | `0.3`   | Share of the delay that is randomized (plus or minus)                                                     |

## Encryption primitives

The package exports ECDH P-256 key exchange helpers, HKDF-SHA-256 key derivation, AES-256-GCM encryption and the `enc` envelope of the protocol. Nothing in EnclaveJS calls them: an application that wants payload encryption has to write both ends, exchange the hello messages and envelopes over its own endpoints, and keep using TLS.

<details>
<summary>Example: key exchange and one envelope, both sides in one process</summary>

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

</details>

## Security notes

What the encryption primitives do, and what is left to the application:

- **The key exchange is not authenticated.** `ServerHello.signatureB64` is neither created nor verified, and there is no key confirmation. The exchange protects against a party that can only read the connection. A party that can change messages can replace both public keys. An application that needs more has to authenticate the hello messages itself (for example by signing them with a key the client pins) or rely on TLS for the identity of the server.
- **There are two keys, one per direction.** `deriveSessionKeys` and `deriveSessionCryptoKeys` return `clientToServerKey` and `serverToClientKey`. Use one `SessionEncryptionContext` per direction, never one context for both.
- **An envelope authenticates its header.** `createEncryptedEnvelope(key, keyId, sessionId, seq, innerEvent, nonce?)` and `context.createEnvelope(sessionId, seq, innerEvent)` authenticate the protocol version, session id, sequence number and key id together with the event. Read envelopes with `openEncryptedEnvelope(key, envelope)` or `context.openEnvelope(envelope)`: they throw `AesGcmError` when the ciphertext or a header field differs.
- **`decryptJson` does not open an envelope.** `decryptJson(key, payload)` and `context.decryptJson(payload)` read payloads made by `encryptJson`. Both forms of `encryptJson` and `decryptJson` take optional additional authenticated data.
- **Replays are for the receiver to detect.** Opening an envelope does not tell whether its sequence number was seen before. Compare it with the last one received, for example with `SequenceTracker`.
- **A context has a message limit.** `SessionEncryptionContext` uses a counter nonce (8 random bytes per context and a 32-bit counter) and refuses to encrypt after 2^30 messages (`needsRotation()` then returns `true`). There is no rotation: exchange keys again.
- **Key material.** `generateKeyPair` returns a private key that cannot be exported. `deriveSessionKeys` returns raw key bytes, and so does `context.toKeyInfo()`: treat both as the key itself.
- **Errors.** `processClientHello` and `processServerHello` throw `EcdhError` for a protocol version, curve, algorithm or key derivation that is not implemented. `fromBase64` throws `AesGcmError` on malformed input. `generateCounterNonce` throws for a counter outside 0 to 2^32 - 1.

For the NDJSON parsers, `maxLineLength` bounds the memory one unfinished line can hold. Lower it when the other end is not trusted and its events are small.

## Related packages

| Package                                                                  | Role                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| [@enclave-vm/types](https://www.npmjs.com/package/@enclave-vm/types)     | Protocol types and Zod schemas (re-exported here)      |
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
