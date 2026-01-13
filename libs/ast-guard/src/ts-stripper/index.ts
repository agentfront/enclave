/**
 * TypeScript Stripper - strips TypeScript syntax from code to produce valid JavaScript.
 *
 * @module ts-stripper
 */

// Main exports
export { TypeScriptStripper, stripTypeScript, isTypeScriptLike } from './ts-stripper';

// Types
export type { TypeScriptConfig, TypeScriptStripResult } from './config';
export { DEFAULT_TYPESCRIPT_CONFIG } from './config';

// State types (for advanced usage)
export type { StripperState, DepthTracker } from './stripper-state';
export { StripperContext, createStripperState } from './stripper-state';
