/**
 * enclave Demo
 *
 * Demonstrates secure JavaScript execution with defense-in-depth
 */

import { Enclave, ToolHandler } from '@enclave-vm/core';

async function main() {
  console.log('=== enclave Demo ===\n');

  // Create enclave with SECURE security level
  console.log('1. Creating secure enclave...');
  const enclave = new Enclave({
    securityLevel: 'SECURE',
    timeout: 5000,
  });
  console.log('   Enclave created with SECURE security level\n');

  // Execute safe code
  console.log('2. Executing safe arithmetic code...');
  const safeCode = `
    const a = 10;
    const b = 20;
    const result = a + b;
    return result;
  `;
  const safeResult = await enclave.run(safeCode);
  console.log(`   Success: ${safeResult.success}`);
  console.log(`   Result: ${safeResult.value}`);
  console.log();

  // Execute code with loops (demonstrates loop guards)
  console.log('3. Executing code with loops...');
  const loopCode = `
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += i;
    }
    return sum;
  `;
  const loopResult = await enclave.run(loopCode);
  console.log(`   Success: ${loopResult.success}`);
  console.log(`   Sum of 0-99: ${loopResult.value}`);
  console.log();

  // Execute code with tool handler
  console.log('4. Executing code with tool handler...');
  const toolHandler: ToolHandler = async (toolName, args) => {
    if (toolName === 'multiply') {
      const { a, b } = args as { a: number; b: number };
      return a * b;
    }
    if (toolName === 'greet') {
      const { name } = args as { name: string };
      return `Hello, ${name}!`;
    }
    throw new Error(`Unknown tool: ${toolName}`);
  };

  const toolEnclave = new Enclave({
    securityLevel: 'SECURE',
    timeout: 5000,
    toolHandler,
  });

  const toolCode = `
    const product = await callTool('multiply', { a: 7, b: 8 });
    const greeting = await callTool('greet', { name: 'World' });
    return { product, greeting };
  `;
  const toolResult = await toolEnclave.run(toolCode);
  console.log(`   Success: ${toolResult.success}`);
  console.log(`   Result: ${JSON.stringify(toolResult.value)}`);
  console.log();

  // Attempt to execute dangerous code (should be blocked)
  console.log('5. Attempting dangerous code (process access)...');
  const dangerousCode = `
    const p = process;
    return p.exit;
  `;
  const dangerousResult = await enclave.run(dangerousCode);
  console.log(`   Success: ${dangerousResult.success}`);
  if (!dangerousResult.success) {
    console.log(`   Blocked: ${dangerousResult.error?.message || 'Security violation'}`);
  }
  console.log();

  // Summary
  console.log('6. Summary:');
  console.log(`   Safe code executed: ${safeResult.success ? 'YES' : 'NO'}`);
  console.log(`   Loop code executed: ${loopResult.success ? 'YES' : 'NO'}`);
  console.log(`   Tool code executed: ${toolResult.success ? 'YES' : 'NO'}`);
  console.log(`   Dangerous code blocked: ${!dangerousResult.success ? 'YES' : 'NO'}`);
  console.log();

  // Cleanup
  enclave.dispose();
  toolEnclave.dispose();

  console.log('=== Demo Complete ===');
}

main().catch(console.error);
