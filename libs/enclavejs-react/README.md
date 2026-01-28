# @enclave-vm/react

[![npm version](https://img.shields.io/npm/v/@enclave-vm/react.svg)](https://www.npmjs.com/package/@enclave-vm/react)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> React hooks and components for the EnclaveJS streaming runtime

The @enclave-vm/react package provides React bindings for EnclaveJS, including hooks for code execution, connection management, and pre-built components for common use cases like code editors and output displays.

## Features

- **React Hooks**: `useEnclave`, `useExecution`, `useSession` hooks
- **Context Provider**: Share client instance across components
- **TypeScript Support**: Full type definitions
- **SSR Compatible**: Works with Next.js and other SSR frameworks
- **Suspense Ready**: Built-in support for React Suspense

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
import { EnclaveProvider, useEnclave } from '@enclave-vm/react';

function App() {
  return (
    <EnclaveProvider url="wss://runtime.example.com">
      <CodeRunner />
    </EnclaveProvider>
  );
}

function CodeRunner() {
  const { execute, isConnected, isExecuting } = useEnclave();
  const [result, setResult] = useState(null);

  const runCode = async () => {
    const res = await execute(`
      const user = await callTool('getUser', { id: 1 });
      return user.name;
    `);
    setResult(res.value);
  };

  return (
    <div>
      <button onClick={runCode} disabled={!isConnected || isExecuting}>
        {isExecuting ? 'Running...' : 'Run Code'}
      </button>
      {result && <div>Result: {result}</div>}
    </div>
  );
}
```

## Hooks

### useEnclave

Main hook for interacting with the EnclaveJS runtime:

```tsx
import { useEnclave } from '@enclave-vm/react';

function MyComponent() {
  const {
    // Connection
    isConnected,
    connect,
    disconnect,

    // Execution
    execute,
    stream,
    isExecuting,

    // Session
    sessionId,
    createSession,
    destroySession,

    // Events
    onToolCall,
    onToolResult,
    onLog,
    onError,
  } = useEnclave();

  // Subscribe to tool calls
  useEffect(() => {
    const unsubscribe = onToolCall((call) => {
      console.log('Tool called:', call.name);
    });
    return unsubscribe;
  }, [onToolCall]);

  return <div>{isConnected ? 'Connected' : 'Disconnected'}</div>;
}
```

### useExecution

Hook for managing individual code executions:

```tsx
import { useExecution } from '@enclave-vm/react';

function ExecutionComponent() {
  const { execute, result, error, isLoading, toolCalls } = useExecution();

  return (
    <div>
      <button onClick={() => execute('return 1 + 1')} disabled={isLoading}>
        Execute
      </button>

      {isLoading && <div>Executing...</div>}
      {error && <div>Error: {error.message}</div>}
      {result && <div>Result: {JSON.stringify(result.value)}</div>}

      <div>
        <h3>Tool Calls:</h3>
        {toolCalls.map((call) => (
          <div key={call.id}>
            {call.name}: {JSON.stringify(call.args)}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### useSession

Hook for persistent session management:

```tsx
import { useSession } from '@enclave-vm/react';

function SessionComponent() {
  const { session, create, destroy, execute, isActive } = useSession();

  useEffect(() => {
    create({ timeout: 60000 });
    return () => destroy();
  }, []);

  if (!isActive) return <div>No active session</div>;

  return (
    <div>
      <div>Session: {session.id}</div>
      <button onClick={() => execute('return Date.now()')}>Get Time</button>
    </div>
  );
}
```

## Provider Options

```tsx
import { EnclaveProvider } from '@enclave-vm/react';

function App() {
  return (
    <EnclaveProvider
      url="wss://runtime.example.com"
      auth={{ token: 'your-token' }}
      autoConnect={true}
      reconnect={{
        enabled: true,
        maxAttempts: 5,
      }}
      onConnected={() => console.log('Connected!')}
      onDisconnected={() => console.log('Disconnected')}
      onError={(error) => console.error(error)}
    >
      <App />
    </EnclaveProvider>
  );
}
```

## Streaming Results

Handle streaming execution with real-time updates:

```tsx
import { useEnclave } from '@enclave-vm/react';

function StreamingComponent() {
  const { stream } = useEnclave();
  const [items, setItems] = useState([]);

  const runStreaming = async () => {
    setItems([]);
    await stream(
      `
      for (const i of [1, 2, 3, 4, 5]) {
        const data = await callTool('processItem', { id: i });
        yield data;
      }
    `,
      {
        onYield: (value) => {
          setItems((prev) => [...prev, value]);
        },
      },
    );
  };

  return (
    <div>
      <button onClick={runStreaming}>Start Streaming</button>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{JSON.stringify(item)}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Error Boundaries

Use with React error boundaries:

```tsx
import { EnclaveErrorBoundary } from '@enclave-vm/react';

function App() {
  return (
    <EnclaveErrorBoundary
      fallback={(error, reset) => (
        <div>
          <p>Something went wrong: {error.message}</p>
          <button onClick={reset}>Try again</button>
        </div>
      )}
    >
      <CodeRunner />
    </EnclaveErrorBoundary>
  );
}
```

## Server Components (Next.js)

For Next.js App Router, use client components:

```tsx
// components/code-runner.tsx
'use client';

import { EnclaveProvider, useEnclave } from '@enclave-vm/react';

export function CodeRunner() {
  return (
    <EnclaveProvider url={process.env.NEXT_PUBLIC_ENCLAVE_URL!}>
      <RunnerInner />
    </EnclaveProvider>
  );
}
```

## Related Packages

| Package                                     | Description                       |
| ------------------------------------------- | --------------------------------- |
| [@enclave-vm/types](../enclavejs-types)     | Type definitions and Zod schemas  |
| [@enclave-vm/client](../enclavejs-client)   | Browser/Node.js client SDK        |
| [@enclave-vm/stream](../enclavejs-stream)   | Streaming protocol implementation |
| [@enclave-vm/runtime](../enclavejs-runtime) | Standalone runtime worker         |

## License

Apache-2.0
