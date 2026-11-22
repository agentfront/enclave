# @enclave-vm/react

React bindings for EnclaveJS: a provider that shares an `EnclaveClient` with a component tree, and a hook that runs a script on a broker and keeps the state of the run, for React applications.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/react.svg)](https://www.npmjs.com/package/@enclave-vm/react)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

The package is a thin layer over [`@enclave-vm/client`](https://www.npmjs.com/package/@enclave-vm/client), which talks to the HTTP routes of [`@enclave-vm/broker`](https://www.npmjs.com/package/@enclave-vm/broker). Scripts and tools run on the broker; the hooks only start runs and report what happens.

## Install

```bash
npm install @enclave-vm/react react
```

`react` (18 or later) is a peer dependency. `@enclave-vm/client` is installed as a dependency; add it to your own dependencies as well if you import from it directly, for example to create a client for the `client` prop.

## Quick start

```tsx
import { EnclaveProvider, useEnclaveSession } from '@enclave-vm/react';

export function App() {
  return (
    <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }}>
      <CodeRunner />
    </EnclaveProvider>
  );
}

function CodeRunner() {
  const { execute, isRunning, result, error } = useEnclaveSession();

  // `getUser` is a tool registered on the broker
  const runCode = () =>
    execute(`
      const user = await callTool('getUser', { id: '1' });
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

## EnclaveProvider

```tsx
import type { ReactNode } from 'react';
import { EnclaveProvider } from '@enclave-vm/react';

function Root({ token, children }: { token: string; children: ReactNode }) {
  return (
    <EnclaveProvider
      config={{
        baseUrl: 'https://api.example.com',
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
      }}
    >
      {children}
    </EnclaveProvider>
  );
}
```

| Prop       | Type                  | Meaning                                                                                      |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `config`   | `EnclaveClientConfig` | Required. Options of the `EnclaveClient` the provider builds                                 |
| `client`   | `EnclaveClient`       | Optional. A client you created; the provider then builds none, and `config` is only reported |
| `children` | `ReactNode`           | The component tree                                                                           |

`config` takes exactly the options of `EnclaveClient`: `baseUrl`, `headers`, `timeout`, `autoReconnect`, `maxReconnectAttempts`, `reconnectDelay`, `maxEventLength` and `fetch` (see the [client's README](https://github.com/agentfront/enclave/tree/main/libs/client#configuration)). Any other option, such as `encryption`, `auth` or `serverUrl`, throws when the provider renders.

Without a `client` prop, the provider builds the client from `config`. When a render brings a configuration with other values, for example a renewed token in `headers`, the provider builds a new client from it. A render with an equal configuration, such as an inline object literal, keeps the client (`headers` are compared by their entries, every other option by identity). A session that was started before the change finishes on the client it was started with, but it no longer reaches the hook: its callbacks (`onStdout`, `onLog`, `onToolCall`, `onToolResultApplied`, `onError`, `onComplete`) are not called, and its output and result do not appear in `state`, `result`, `error`, `stdout` or `events`, which start from `'idle'` for the new client. The promise `execute` returned still resolves with the session's result; use it to get that result. With a `client` prop, the provider uses that client as it is: a change to `config`, a renewed token in `headers` included, does not reach it, and a new client has to be passed in.

## Hooks

All three hooks throw when they are used outside an `EnclaveProvider`.

### useEnclaveSession

```tsx
import { useEnclaveSession } from '@enclave-vm/react';

function MyComponent() {
  const { execute, cancel, reset, state, isRunning, sessionId, result, error, stdout, events } = useEnclaveSession({
    timeoutMs: 30000,
    maxToolCalls: 20,
    onToolCall: (callId, toolName, args) => console.log('Tool called:', toolName, args),
    onComplete: (sessionResult) => console.log('Finished:', sessionResult.success),
    onError: (sessionError) => console.error(sessionError.code, sessionError.message),
  });

  return <div>{state}</div>;
}
```

Options:

| Option                | Type                                  | Meaning                                                                                                                                                  |
| --------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`           | `SessionId`                           | Id for the session; generated by the client when left out                                                                                                |
| `timeoutMs`           | `number`                              | Sent as the session's `sessionTtlMs` (its lifetime); the broker may lower it                                                                             |
| `maxToolCalls`        | `number`                              | Sent as `maxToolCalls`; the broker may lower it                                                                                                          |
| `heartbeatIntervalMs` | `number`                              | Sent as `heartbeatIntervalMs`; the broker keeps it within its bounds                                                                                     |
| `onStart`             | `() => void`                          | Called when `execute` starts a run                                                                                                                       |
| `onStdout`            | `(chunk) => void`                     | A `stdout` event                                                                                                                                         |
| `onLog`               | `(level, message, data?) => void`     | A `log` event                                                                                                                                            |
| `onToolCall`          | `(callId, toolName, args) => void`    | A `tool_call` event                                                                                                                                      |
| `onToolResultApplied` | `(callId) => void`                    | A `tool_result_applied` event                                                                                                                            |
| `onComplete`          | `(result) => void`                    | The run ended, successfully or not                                                                                                                       |
| `onError`             | `(error: { code?, message }) => void` | An `error` event during the run, or the run failed. Not called for a cancelled run, except with `CANCEL_FAILED` when the broker did not confirm the stop |

Return value:

| Value       | Description                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute`   | `(code) => Promise<SessionResult>`: starts a run and resolves with its result                                                                                                                                                                     |
| `cancel`    | `(reason?) => Promise<void>`: cancels the running session. It resolves, and the run ends as `'cancelled'`, also when the broker does not confirm the stop: `onError` then gets `CANCEL_FAILED`, and the script may still be running on the broker |
| `reset`     | Puts the hook back to `'idle'` and clears its values. Does not cancel a running session, and `cancel()` no longer reaches it afterward                                                                                                            |
| `state`     | `'idle'`, `'running'`, `'completed'`, `'error'` or `'cancelled'`                                                                                                                                                                                  |
| `isRunning` | `true` while `state` is `'running'`                                                                                                                                                                                                               |
| `sessionId` | Id of the latest session; `null` before the first run and after `reset()`                                                                                                                                                                         |
| `result`    | The `SessionResult` of the latest run, once it has ended                                                                                                                                                                                          |
| `error`     | `{ code?, message }` when the latest run failed                                                                                                                                                                                                   |
| `stdout`    | The stdout of the run so far                                                                                                                                                                                                                      |
| `events`    | The events of the run so far                                                                                                                                                                                                                      |

A run that fails does not throw. `execute` resolves with a result whose `success` is `false`, `state` becomes `'error'`, and `error` holds the code and the message. A cancelled run ends in the state `'cancelled'`.

`reset()` does not stop a running session from writing to the hook. Until a new run starts, that session's later output and events, and then its result and final state, appear in the hook again, so the hook leaves `'idle'` without a new run.

```tsx
import { useEnclaveSession } from '@enclave-vm/react';

function Runner() {
  const { execute, cancel, reset, state, error, stdout } = useEnclaveSession();

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
      <pre>{stdout}</pre>
    </div>
  );
}
```

### useEnclaveClient

Returns the `EnclaveClient` of the provider, for direct use:

```tsx
import { useEnclaveClient } from '@enclave-vm/react';

function ExecuteButton() {
  const client = useEnclaveClient();

  const handleClick = async () => {
    const result = await client.execute('return 1 + 1');
    console.log(result.value);
  };

  return <button onClick={handleClick}>Execute</button>;
}
```

### useEnclaveContext

Returns the context value: `client`, and `config`, the configuration it was built from.

```tsx
import { useEnclaveContext } from '@enclave-vm/react';

function BrokerInfo() {
  const { config } = useEnclaveContext();
  return <div>Broker: {config.baseUrl}</div>;
}
```

## Next.js App Router

The provider and the hooks use React context and state, so they belong in client components:

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

## Security notes

- The client does not encrypt: requests and events travel as plain JSON over HTTP. Use an `https:` base URL.
- The package does no authentication. Send credentials with `headers` in `config`; anything in `config` is visible in the browser, so do not put a long-lived secret there.
- Tool names, tool arguments and the script's result reach the browser in the events (`events`, `onToolCall`).

## Related packages

| Package                                                                | Role                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| [@enclave-vm/client](https://www.npmjs.com/package/@enclave-vm/client) | The client these hooks use                       |
| [@enclave-vm/broker](https://www.npmjs.com/package/@enclave-vm/broker) | The server side: tools, sessions and HTTP routes |
| [@enclave-vm/types](https://www.npmjs.com/package/@enclave-vm/types)   | Protocol types and Zod schemas                   |

## Documentation

- Documentation: https://agentfront.dev/docs/guides/enclave
- Repository: https://github.com/agentfront/enclave
- Security policy: https://github.com/agentfront/enclave/blob/main/SECURITY.md

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
