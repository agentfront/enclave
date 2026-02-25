import { useState, useEffect, useRef, useCallback } from 'react';
import { loadEnclaveModule } from '../enclave-loader';
import type { SecurityLevel } from '../types';

interface UseEnclaveOptions {
  securityLevel: SecurityLevel;
  toolHandler?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function useEnclave({ securityLevel, toolHandler }: UseEnclaveOptions) {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enclaveRef = useRef<any>(null);
  const toolHandlerRef = useRef(toolHandler);
  toolHandlerRef.current = toolHandler;

  useEffect(() => {
    let disposed = false;

    async function init() {
      setLoading(true);
      setReady(false);
      setError(null);

      // Dispose previous instance
      if (enclaveRef.current) {
        try {
          enclaveRef.current.dispose();
        } catch {
          /* ignore */
        }
        enclaveRef.current = null;
      }

      try {
        const mod = await loadEnclaveModule();
        if (disposed) return;

        enclaveRef.current = new mod.BrowserEnclave({
          securityLevel,
          toolHandler: toolHandlerRef.current,
        });
        setReady(true);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    init();

    return () => {
      disposed = true;
      if (enclaveRef.current) {
        try {
          enclaveRef.current.dispose();
        } catch {
          /* ignore */
        }
        enclaveRef.current = null;
      }
    };
  }, [securityLevel, toolHandler]);

  const run = useCallback(async (code: string) => {
    if (!enclaveRef.current) {
      throw new Error('Enclave not ready');
    }
    return enclaveRef.current.run(code);
  }, []);

  return { ready, loading, error, run };
}
