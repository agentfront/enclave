jest.mock('acorn', () => {
  throw new Error('@enclave-vm/ast/redos loaded acorn');
});
jest.mock('acorn-walk', () => {
  throw new Error('@enclave-vm/ast/redos loaded acorn-walk');
});
jest.mock('astring', () => {
  throw new Error('@enclave-vm/ast/redos loaded astring');
});

import { REDOS_THRESHOLDS, analyzeForReDoS, calculateStarHeight } from '../redos';

describe('@enclave-vm/ast/redos', () => {
  it('analyzes patterns without loading the parser', () => {
    const nested = analyzeForReDoS('(a+)+', 'catastrophic');
    expect(nested.vulnerable).toBe(true);
    expect(nested.score).toBeGreaterThanOrEqual(REDOS_THRESHOLDS.BLOCK);
    expect(analyzeForReDoS('[a-z]+', 'polynomial').vulnerable).toBe(false);
    expect(calculateStarHeight('(a*)*')).toBe(2);
  });
});
