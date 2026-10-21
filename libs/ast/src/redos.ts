/**
 * `@enclave-vm/ast/redos`: the ReDoS analyzer on its own, for code that checks regular expressions without validating
 * JavaScript. It loads none of the parser (acorn, acorn-walk, astring) that the package root loads.
 */
export {
  REDOS_PATTERNS,
  REDOS_THRESHOLDS,
  analyzeForReDoS,
  calculateStarHeight,
} from './pre-scanner/checks/regex-check';
export type { ReDoSAnalysisResult } from './pre-scanner/checks/regex-check';
