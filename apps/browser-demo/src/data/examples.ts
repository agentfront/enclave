import type { ExampleSnippet } from '../types';

export const examples: ExampleSnippet[] = [
  {
    label: 'Arithmetic',
    category: 'Basic',
    code: 'return 2 + 2;',
    description: 'Simple addition — returns 4',
  },
  {
    label: 'Strings',
    category: 'Basic',
    code: 'return "hello".toUpperCase();',
    description: 'String transformation',
  },
  {
    label: 'Loop',
    category: 'Basic',
    code: 'let sum = 0;\nfor (let i = 0; i < 1000; i++) sum += i;\nreturn sum;',
    description: 'Sum 0..999 in a loop — returns 499500',
  },
  {
    label: 'Console',
    category: 'Basic',
    code: 'console.log("info message");\nconsole.warn("warning message");\nconsole.error("error message");\nreturn "check console";',
    description: 'Logs to the sandboxed console',
  },
  {
    label: 'Delay',
    category: 'Async',
    code: 'await new Promise(r => setTimeout(r, 100));\nreturn "done after 100ms";',
    description: 'Async/await with setTimeout',
  },
  {
    label: 'Single Tool Call',
    category: 'Tools',
    code: 'const result = await callTool("math:add", { a: 1, b: 2 });\nreturn result;',
    description: 'Calls the math:add mock tool',
  },
  {
    label: 'Chain Tools',
    category: 'Tools',
    code: 'const sum = await callTool("math:add", { a: 10, b: 20 });\nconst reversed = await callTool("string:reverse", { text: String(sum) });\nreturn { sum, reversed };',
    description: 'Chains math:add then string:reverse',
  },
  {
    label: 'eval() Blocked',
    category: 'Security',
    code: 'eval("1+1");',
    description: 'eval is blocked by AST validation',
  },
  {
    label: 'Prototype Escape',
    category: 'Security',
    code: 'const obj = {};\nreturn obj.constructor;',
    description: 'Constructor access is blocked',
  },
  {
    label: 'Infinite Loop',
    category: 'Security',
    code: 'while (true) {\n  // runs forever\n}',
    description: 'Hits the iteration limit',
  },
];
