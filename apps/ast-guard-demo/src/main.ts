/**
 * ast-guard Demo
 *
 * Demonstrates AST-based JavaScript validation with security presets
 */

import { JSAstValidator, Presets, preScan } from 'ast-guard';

// Sample code snippets to validate
const safeCode = `
const x = 1 + 2;
const y = x * 3;
console.log(y);
`;

const unsafeCodeWithEval = `
const userInput = "alert('xss')";
eval(userInput);
`;

const unsafeCodeWithConstructor = `
const fn = new Function('return process');
fn().exit(1);
`;

async function main() {
  console.log('=== ast-guard Demo ===\n');

  // Create validators with different security levels
  const strictValidator = new JSAstValidator(Presets.strict());
  const secureValidator = new JSAstValidator(Presets.secure());

  // 1. Pre-scan (Layer 0 Defense)
  console.log('1. Pre-scanning code...');
  const preScanResult = preScan(safeCode);
  console.log(`   Pre-scan passed: ${preScanResult.issues.length === 0}`);
  if (preScanResult.issues.length > 0) {
    console.log(`   Issues: ${preScanResult.issues.map((i) => i.message).join(', ')}`);
  }
  console.log();

  // 2. Validate safe code
  console.log('2. Validating safe code with STRICT preset...');
  const safeResult = await strictValidator.validate(safeCode);
  console.log(`   Valid: ${safeResult.valid}`);
  console.log(`   Issues: ${safeResult.issues.length}`);
  console.log();

  // 3. Validate code with eval (should fail)
  console.log('3. Validating code with eval()...');
  const evalResult = await secureValidator.validate(unsafeCodeWithEval);
  console.log(`   Valid: ${evalResult.valid}`);
  if (!evalResult.valid) {
    console.log(`   Blocked reason: ${evalResult.issues[0]?.message || 'Security violation'}`);
  }
  console.log();

  // 4. Validate code with Function constructor (should fail)
  console.log('4. Validating code with Function constructor...');
  const constructorResult = await secureValidator.validate(unsafeCodeWithConstructor);
  console.log(`   Valid: ${constructorResult.valid}`);
  if (!constructorResult.valid) {
    console.log(`   Blocked reason: ${constructorResult.issues[0]?.message || 'Security violation'}`);
  }
  console.log();

  // 5. Show validation summary
  console.log('5. Summary:');
  console.log(`   Safe code validated: ${safeResult.valid ? 'PASSED' : 'FAILED'}`);
  console.log(`   Eval code blocked: ${!evalResult.valid ? 'YES' : 'NO'}`);
  console.log(`   Function constructor blocked: ${!constructorResult.valid ? 'YES' : 'NO'}`);
  console.log();

  console.log('=== Demo Complete ===');
}

main().catch(console.error);
