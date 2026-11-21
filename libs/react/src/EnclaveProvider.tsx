/**
 * EnclaveProvider
 *
 * React context provider for the EnclaveJS client.
 *
 * @packageDocumentation
 */

import React, { createContext, useContext, useMemo, useRef } from 'react';
import { EnclaveClient } from '@enclave-vm/client';
import type { EnclaveClientConfig } from '@enclave-vm/client';
import type { EnclaveProviderProps, EnclaveContextValue } from './types.js';

/**
 * React context for the Enclave client
 */
const EnclaveContext = createContext<EnclaveContextValue | null>(null);

/**
 * Whether two configurations ask for the same client: the same options with the same values.
 * `headers` are compared by their entries, every other option by identity.
 */
function sameConfig(a: EnclaveClientConfig, b: EnclaveClientConfig): boolean {
  if (a === b) return true;

  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;

  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key === 'headers') {
      if (!sameHeaders(a.headers, b.headers)) return false;
    } else if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/** A copy of a configuration, its headers included, that a change in place does not reach. */
function snapshotConfig(config: EnclaveClientConfig): EnclaveClientConfig {
  const copy: EnclaveClientConfig = { ...config };
  if (config.headers) copy.headers = { ...config.headers };
  return copy;
}

function sameHeaders(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * EnclaveProvider component
 *
 * Provides the EnclaveClient to child components via React context.
 *
 * The client is built from `config`. When a render brings a configuration with other values
 * (another `baseUrl`, a renewed token in `headers`), the provider builds a new client from it,
 * and the context hands out that client together with that configuration. A render with an
 * equal configuration, such as an object literal written inline, keeps the client. A session
 * that was started before the change runs to its end on the client it was started with.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }}>
 *       <MyComponent />
 *     </EnclaveProvider>
 *   );
 * }
 * ```
 */
export function EnclaveProvider({
  config,
  client: providedClient,
  children,
}: EnclaveProviderProps): React.ReactElement {
  // The client this provider created and a copy of the configuration it was built from.
  const createdRef = useRef<{
    client: EnclaveClient;
    snapshot: EnclaveClientConfig;
  } | null>(null);

  // Create or use provided client. Compared on every render with a copy of what the configuration
  // held when the client was built, not by the identity of `config`: a configuration changed in
  // place (another server, other credentials) is another configuration, and a client is never
  // used with a configuration it was not built from.
  let client: EnclaveClient;
  let clientConfig: EnclaveClientConfig;
  if (providedClient) {
    client = providedClient;
    clientConfig = config;
  } else {
    if (!createdRef.current || !sameConfig(createdRef.current.snapshot, config)) {
      createdRef.current = { client: new EnclaveClient(config), snapshot: snapshotConfig(config) };
    }
    client = createdRef.current.client;
    clientConfig = config;
  }

  // Memoize context value
  const contextValue = useMemo<EnclaveContextValue>(
    () => ({
      client,
      config: clientConfig,
    }),
    [client, clientConfig],
  );

  return <EnclaveContext.Provider value={contextValue}>{children}</EnclaveContext.Provider>;
}

/**
 * useEnclaveContext hook
 *
 * Access the Enclave context directly. Throws if used outside EnclaveProvider.
 *
 * @internal
 */
export function useEnclaveContext(): EnclaveContextValue {
  const context = useContext(EnclaveContext);

  if (!context) {
    throw new Error(
      'useEnclaveContext must be used within an EnclaveProvider. ' +
        'Wrap your component tree with <EnclaveProvider config={{...}}>.',
    );
  }

  return context;
}

/**
 * useEnclaveClient hook
 *
 * Get the EnclaveClient instance from context.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const client = useEnclaveClient();
 *
 *   const handleClick = async () => {
 *     const result = await client.execute('return 1 + 1');
 *     console.log(result.value);
 *   };
 *
 *   return <button onClick={handleClick}>Execute</button>;
 * }
 * ```
 */
export function useEnclaveClient(): EnclaveClient {
  const { client } = useEnclaveContext();
  return client;
}

export { EnclaveContext };
