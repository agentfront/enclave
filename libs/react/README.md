# @enclave-vm/react

[![npm version](https://img.shields.io/npm/v/@enclave-vm/react.svg)](https://www.npmjs.com/package/@enclave-vm/react)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> React hooks and components for the EnclaveJS streaming runtime

The @enclave-vm/react package provides React bindings for EnclaveJS: a provider that shares an `EnclaveClient` with a component tree, and hooks that run code on an EnclaveJS broker and keep the state of the run.

## Features

- **React Hooks**: `useEnclaveSession` and `useEnclaveClient` hooks
- **Context Provider**: Share client instance across components
- **Session State**: State, result, error, stdout and events of a run as React state
- **TypeScript Support**: Full type definitions

## Installation

```bash
npm install @enclave-vm/react @enclave-vm/client
# or
yarn add @enclave-vm/react @enclave-vm/client
# or
pnpm add @enclave-vm/react @enclave-vm/client
```

## Quick Start

```tsx
import { EnclaveProvider, useEnclaveSession } from '@enclave-vm/react';

function App() {
  return (
    <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }}>
      <CodeRunner />
    </EnclaveProvider>
  );
}

function CodeRunner() {
  const { execute, isRunning, result, error } = useEnclaveSession();

  const runCode = () =>
    execute(`
      const user = await callTool('getUser', { id: 1 });
      return user.name;
    `);

  return (
    <div>
      <button onClick={runCode} disabled={isRunning}>
        {isRunning ? 'Running...' : 'Run Code'}
      </button>
      {result?.success && <div>Result: {JSON.stringify(result.value)}</div>}
      {error && <div>Error: {error.message}</div>}
    </div>
  );
}
```

## Hooks

### useEnclaveSession

Main hook for running code and following the run:

```tsx
import { useEnclaveSession } from '@enclave-vm/react';

function MyComponent() {
  const {
    // Execution
    execute,
    cancel,
    reset,

    // State
    state,
    isRunning,
    sessionId,

    // Output
    result,
    error,
    stdout,
    events,
  } = useEnclaveSession({
    // Limits requested for the session
    timeoutMs: 30000,
    maxToolCalls: 20,

    // Callbacks
    onToolCall: (callId, toolName, args) => {
      console.log('Tool called:', toolName, args);
    },
    onComplete: (sessionResult) => {
      console.log('Finished:', sessionResult.success);
    },
    onError: (sessionError) => {
      console.error(sessionError.code, sessionError.message);
    },
  });

  return <div>{state}</div>;
}
```

| Value       | Description                                                                             |
| ----------- | --------------------------------------------------------------------------------------- |
| `execute`   | `(code) => Promise<SessionResult>`: starts a run and resolves with its result           |
| `cancel`    | `(reason?) => Promise<void>`: cancels the running session                               |
| `reset`     | Puts the hook back to `'idle'` and clears its values. Does not cancel a running session |
| `state`     | `'idle'`, `'running'`, `'completed'`, `'error'` or `'cancelled'`                        |
| `isRunning` | `true` while `state` is `'running'`                                                     |
| `sessionId` | ID of the latest session; `null` before the first run and after `reset()`               |
| `result`    | The `SessionResult` of the latest run, once it has ended                                |
| `error`     | `{ code?, message }` when the latest run failed                                         |
| `stdout`    | The stdout of the run so far                                                            |
| `events`    | The events of the run so far                                                            |

The options are `sessionId`, `timeoutMs`, `maxToolCalls`, `heartbeatIntervalMs`, and the callbacks `onStart`, `onStdout`, `onLog`, `onToolCall`, `onToolResultApplied`, `onComplete` and `onError`.

### useEnclaveClient

Hook for using the `EnclaveClient` of the provider directly:

```tsx
import { useEnclaveClient } from '@enclave-vm/react';

function ExecutionComponent() {
  const client = useEnclaveClient();

  const handleClick = async () => {
    const result = await client.execute('return 1 + 1');
    console.log(result.value);
  };

  return <button onClick={handleClick}>Execute</button>;
}
```

### useEnclaveContext

Hook for reading the context value: the client, and the configuration it was built from.

```tsx
import { useEnclaveContext } from '@enclave-vm/react';

function BrokerInfo() {
  const { config } = useEnclaveContext();

  return <div>Broker: {config.baseUrl}</div>;
}
```

All three hooks throw when they are used outside an `EnclaveProvider`.

## Provider Options

```tsx
import { EnclaveProvider } from '@enclave-vm/react';

function Root({ token }: { token: string }) {
  return (
    <EnclaveProvider
      config={{
        baseUrl: 'https://api.example.com',
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
        autoReconnect: true,
        maxReconnectAttempts: 3,
      }}
    >
      <App />
    </EnclaveProvider>
  );
}
```

`config` takes exactly the options of `EnclaveClient`: `baseUrl`, `headers`, `timeout`, `autoReconnect`, `maxReconnectAttempts`, `reconnectDelay`, `maxEventLength` and `fetch`. Any other option, such as `encryption`, `auth` or `serverUrl`, throws when the provider renders.

The provider builds the client from `config`. When a render brings a configuration with other values, for example a renewed token in `headers`, the provider builds a new client from it. A render with an equal configuration, such as the inline object above, keeps the client. A session that was started before the change finishes on the client it was started with.

To use a client that you created yourself, pass it with the `client` prop. The provider then builds none, and `config` is only what `useEnclaveContext()` reports.

The client does not encrypt: requests and events travel as plain JSON over HTTP. Use an `https:` base URL, and send credentials with `headers`.

## Streaming Results

`stdout` and `events` grow while the session runs, and the callbacks are called as the events arrive:

```tsx
import { useState } from 'react';
import { useEnclaveSession } from '@enclave-vm/react';

function StreamingComponent() {
  const [toolNames, setToolNames] = useState<string[]>([]);

  const { execute, isRunning, stdout } = useEnclaveSession({
    onStart: () => setToolNames([]),
    onToolCall: (callId, toolName) => {
      setToolNames((prev) => [...prev, toolName]);
    },
  });

  const runStreaming = () =>
    execute(`
      for (const i of [1, 2, 3, 4, 5]) {
        await callTool('processItem', { id: i });
      }
      return 'done';
    `);

  return (
    <div>
      <button onClick={runStreaming} disabled={isRunning}>
        Start Streaming
      </button>
      <pre>{stdout}</pre>
      <ul>
        {toolNames.map((name, i) => (
          <li key={i}>{name}</li>
        ))}
      </ul>
    </div>
  );
}
```

Tools run on the broker. The hook is told about tool calls; it executes nothing.

## Error Handling

A run that fails does not throw. `execute` resolves with a result whose `success` is `false`, `state` becomes `'error'`, and `error` holds the code and the message. A cancelled run ends in the state `'cancelled'`.

```tsx
import { useEnclaveSession } from '@enclave-vm/react';

function CodeRunner() {
  const { execute, cancel, reset, state, error } = useEnclaveSession();

  return (
    <div>
      <button onClick={() => execute('return 1 + 1')} disabled={state === 'running'}>
        Run
      </button>
      {state === 'running' && <button onClick={() => cancel()}>Cancel</button>}
      {state === 'cancelled' && <p>Cancelled</p>}
      {state === 'error' && (
        <div>
          <p>Something went wrong: {error?.message}</p>
          <button onClick={reset}>Try again</button>
        </div>
      )}
    </div>
  );
}
```

## Server Components (Next.js)

The provider and the hooks use React context and state. For Next.js App Router, use client components:

```tsx
// components/code-runner.tsx
'use client';

import { EnclaveProvider, useEnclaveSession } from '@enclave-vm/react';

export function CodeRunner() {
  return (
    <EnclaveProvider config={{ baseUrl: process.env.NEXT_PUBLIC_ENCLAVE_URL! }}>
      <RunnerInner />
    </EnclaveProvider>
  );
}

function RunnerInner() {
  const { execute, isRunning } = useEnclaveSession();

  return (
    <button onClick={() => execute('return 1 + 1')} disabled={isRunning}>
      Run
    </button>
  );
}
```

## Related Packages

| Package                           | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| [@enclave-vm/types](../types)     | Type definitions and Zod schemas                        |
| [@enclave-vm/client](../client)   | Browser/Node.js client SDK                              |
| [@enclave-vm/stream](../stream)   | Streaming protocol implementation                       |
| [@enclave-vm/runtime](../runtime) | Runtime worker building blocks (not a runnable service) |

## License

Apache-2.0
