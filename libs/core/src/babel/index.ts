/**
 * Babel Transform Module for Enclave
 *
 * Provides secure Babel transformation capabilities inside the enclave sandbox.
 *
 * @packageDocumentation
 */

export {
  createRestrictedBabel,
  getAvailableBabelPresets,
  resetBabelContext,
  type SafeTransformOptions,
  type SafeTransformResult,
  type BabelWrapperConfig,
} from './babel-wrapper';

export {
  transformMultiple,
  type MultiFileInput,
  type MultiFileTransformOptions,
  type MultiFileTransformResult,
  type MultiFileLimits,
} from './multi-file-transform';
