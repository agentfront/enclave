import type { MockTool } from '../types';

export const mockTools: MockTool[] = [
  {
    name: 'math:add',
    description: 'Adds two numbers (a + b)',
    handler: async (args) => {
      const a = Number(args.a ?? 0);
      const b = Number(args.b ?? 0);
      return a + b;
    },
  },
  {
    name: 'string:reverse',
    description: 'Reverses a string',
    handler: async (args) => {
      const text = String(args.text ?? '');
      return text.split('').reverse().join('');
    },
  },
  {
    name: 'data:fetch',
    description: 'Returns mock data for a given key',
    handler: async (args) => {
      const key = String(args.key ?? 'default');
      const data: Record<string, unknown> = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        config: { theme: 'dark', version: '1.0' },
        default: { message: 'No data found' },
      };
      return data[key] ?? data['default'];
    },
  },
];

export function createToolHandler(tools: MockTool[]) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  return async (toolName: string, args: Record<string, unknown>) => {
    const tool = toolMap.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return tool.handler(args);
  };
}
