import { useRef, useCallback } from 'react';
import type { ConsoleEntry, ConsoleLevel } from '../types';

const ENCLAVE_PREFIX = '[Enclave]';

let nextId = 0;

export function useConsoleCapture() {
  const entriesRef = useRef<ConsoleEntry[]>([]);
  const originalsRef = useRef<Record<ConsoleLevel, (...args: unknown[]) => void> | null>(null);

  const startCapture = useCallback(() => {
    // If already capturing, restore originals first to avoid losing real console references
    if (originalsRef.current) {
      const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error'];
      for (const level of levels) {
        console[level] = originalsRef.current[level];
      }
      originalsRef.current = null;
    }

    entriesRef.current = [];

    const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error'];
    const originals = {} as Record<ConsoleLevel, (...args: unknown[]) => void>;

    for (const level of levels) {
      originals[level] = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        // Always pass through to real console
        originals[level](...args);
        // Capture only [Enclave] prefixed messages
        if (args.length > 0 && args[0] === ENCLAVE_PREFIX) {
          entriesRef.current.push({
            id: nextId++,
            level,
            args: args.slice(1),
            timestamp: Date.now(),
          });
        }
      };
    }

    originalsRef.current = originals;
  }, []);

  const stopCapture = useCallback((): ConsoleEntry[] => {
    if (originalsRef.current) {
      const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error'];
      for (const level of levels) {
        console[level] = originalsRef.current[level];
      }
      originalsRef.current = null;
    }
    return [...entriesRef.current];
  }, []);

  return { startCapture, stopCapture };
}
