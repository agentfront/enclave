/**
 * AST Transforms Module
 *
 * Provides AST transformation utilities for the pass-by-reference system.
 *
 * @packageDocumentation
 */

// String extraction
export {
  extractLargeStrings,
  shouldExtract,
  StringExtractionConfig,
  StringExtractionResult,
} from './string-extraction.transform';

// Concatenation transformation
export {
  transformConcatenation,
  transformTemplateLiterals,
  ConcatTransformConfig,
  ConcatTransformResult,
} from './concat.transform';

// Import rewriting
export {
  rewriteImports,
  isValidPackageName,
  isValidSubpath,
  type ImportRewriteConfig,
  type ImportRewriteResult,
} from './import-rewrite.transform';

// Computed member key runtime guard (dynamic property-name sanitizer)
export {
  guardComputedMemberKeys,
  GUARD_KEY_FN,
  DEFAULT_GUARD_BLOCKED_KEYS,
  type ComputedMemberGuardResult,
  type ComputedMemberGuardOptions,
} from './computed-member-guard.transform';

// Writes that can change the size of an array, handed to the runtime that accounts for arrays
export {
  guardArrayWrites,
  ARRAY_WRITE_SET_FN,
  ARRAY_WRITE_SLOT_FN,
  type ArrayWriteGuardResult,
} from './array-write-guard.transform';
