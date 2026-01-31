/**
 * EnclaveProvider
 *
 * React context provider for the EnclaveJS client.
 *
 * @packageDocumentation
 */

import React, { createContext, useContext, useMemo, useRef } from 'react';
import { EnclaveClient } from '@enclave-vm/client';
import type { EnclaveProviderProps, EnclaveContextValue } from './types.js';

/**
 * React context for the Enclave client
 */
const EnclaveContext = createContext<EnclaveContextValue | null>(null);

/**
 * EnclaveProvider component
 *
 * Provides the EnclaveClient to child components via React context.
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
  // Use ref to ensure client is only created once
  const clientRef = useRef<EnclaveClient | null>(null);

  // Create or use provided client
  const client = useMemo(() => {
    if (providedClient) {
      return providedClient;
    }

    // Create new client if not already created
    if (!clientRef.current) {
      clientRef.current = new EnclaveClient(config);
    }

    return clientRef.current;
  }, [providedClient, config]);

  // Memoize context value
  const contextValue = useMemo<EnclaveContextValue>(
    () => ({
      client,
      config,
    }),
    [client, config],
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
