export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  args: unknown[];
  timestamp: number;
}

export type SecurityLevel = 'STRICT' | 'SECURE' | 'STANDARD' | 'PERMISSIVE';

export interface ExampleSnippet {
  label: string;
  category: 'Basic' | 'Async' | 'Tools' | 'Security';
  code: string;
  description: string;
}

export interface MockTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ExecutionStats {
  duration: number;
  toolCallCount: number;
  iterationCount: number;
}
