/**
 * Main TypeScript stripper class.
 * Removes TypeScript syntax from code to produce valid JavaScript.
 *
 * @module ts-stripper/ts-stripper
 */

import { type TypeScriptConfig, type TypeScriptStripResult, DEFAULT_TYPESCRIPT_CONFIG } from './config';
import { createStripperState, StripperContext, isInStringOrComment, type StripperState } from './stripper-state';
import {
  isIdentifierStart,
  readIdentifier,
  skipWhitespace,
  replaceWithSpaces,
  isAtLineStart,
} from './utils/token-utils';
import { updateContext, updateDepth, updatePosition } from './utils/context-tracker';
import { checkNonNullAssertion } from './handlers/non-null-assertion';
import { checkAccessModifier, createModifierReplacement } from './handlers/modifiers';
import { checkImportType, checkExportType, createImportExportReplacement } from './handlers/import-export-type';
import {
  checkInterfaceDeclaration,
  checkTypeAliasDeclaration,
  checkDeclareStatement,
  createDeclarationReplacement,
} from './handlers/type-declaration';
import { checkTypeAnnotation, createTypeAnnotationReplacement } from './handlers/type-annotation';
import { checkAsAssertion, checkAngleBracketAssertion, createAssertionReplacement } from './handlers/type-assertion';
import { checkGenericParams, createGenericReplacement } from './handlers/generic-params';
import { checkEnumDeclaration, calculateEnumPadding } from './handlers/enum-handler';

/**
 * TypeScript stripper - removes TypeScript syntax to produce valid JavaScript.
 */
export class TypeScriptStripper {
  private config: Required<TypeScriptConfig>;

  constructor(config?: TypeScriptConfig) {
    this.config = { ...DEFAULT_TYPESCRIPT_CONFIG, ...config };
  }

  /**
   * Strip TypeScript syntax from source code.
   */
  strip(source: string): TypeScriptStripResult {
    const startTime = Date.now();
    const state = createStripperState();

    try {
      this.processSource(source, state);

      const output = state.output.join('');
      const durationMs = Date.now() - startTime;

      return {
        success: true,
        output,
        stats: {
          inputLength: source.length,
          outputLength: output.length,
          strippedChars: source.length - output.length,
          durationMs,
          typesStripped: state.stats.typesStripped,
          interfacesStripped: state.stats.interfacesStripped,
          enumsTranspiled: state.stats.enumsTranspiled,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        output: source, // Return original on error
        error: {
          message: err.message,
          location: { line: state.line, column: state.column },
        },
        stats: {
          inputLength: source.length,
          outputLength: source.length,
          strippedChars: 0,
          durationMs: Date.now() - startTime,
          typesStripped: 0,
          interfacesStripped: 0,
          enumsTranspiled: 0,
        },
      };
    }
  }

  /**
   * Process the source code character by character.
   */
  private processSource(source: string, state: StripperState): void {
    while (state.position < source.length) {
      const char = source[state.position];

      // Update context (handle strings, comments, etc.)
      const { newContext, skip } = updateContext(source, state);

      if (skip > 0) {
        // Copy characters as-is (entering/exiting string or comment)
        for (let i = 0; i < skip; i++) {
          state.output.push(source[state.position]);
          updatePosition(source[state.position], state);
          state.position++;
        }
        state.context = newContext;
        continue;
      }

      state.context = newContext;

      // If in string or comment, copy as-is
      if (isInStringOrComment(state.context)) {
        state.output.push(char);
        updatePosition(char, state);
        state.position++;
        continue;
      }

      // Try to handle TypeScript constructs
      const handled = this.tryHandleTypeScript(source, state);

      if (!handled) {
        // Regular JavaScript - copy as-is
        state.output.push(char);
        updateDepth(char, state);
        updatePosition(char, state);
        state.position++;
      }
    }
  }

  /**
   * Try to handle TypeScript syntax at current position.
   * Returns true if something was handled.
   */
  private tryHandleTypeScript(source: string, state: StripperState): boolean {
    const char = source[state.position];

    // Handle identifiers that might be TypeScript keywords
    if (isIdentifierStart(char)) {
      const { identifier } = readIdentifier(source, state.position);

      // Check for statement-level constructs at line start
      if (isAtLineStart(source, state.position) || this.isAfterExport(source, state.position)) {
        // Interface declaration
        if (identifier === 'interface') {
          const length = checkInterfaceDeclaration(source, state.position);
          if (length > 0) {
            this.stripRange(source, state, length);
            state.stats.interfacesStripped++;
            return true;
          }
        }

        // Type alias declaration
        if (identifier === 'type') {
          const length = checkTypeAliasDeclaration(source, state.position);
          if (length > 0) {
            this.stripRange(source, state, length);
            state.stats.typesStripped++;
            return true;
          }
        }

        // Declare statement
        if (identifier === 'declare') {
          const length = checkDeclareStatement(source, state.position);
          if (length > 0) {
            this.stripRange(source, state, length);
            return true;
          }
        }

        // Import type
        if (identifier === 'import') {
          const length = checkImportType(source, state.position);
          if (length > 0) {
            this.stripRange(source, state, length);
            return true;
          }
        }

        // Export type
        if (identifier === 'export') {
          const length = checkExportType(source, state.position);
          if (length > 0) {
            this.stripRange(source, state, length);
            return true;
          }
        }

        // Enum declaration
        if (identifier === 'enum' || identifier === 'const') {
          const enumResult = checkEnumDeclaration(source, state.position);
          if (enumResult) {
            this.replaceRange(source, state, enumResult.length, enumResult.replacement);
            state.stats.enumsTranspiled++;
            return true;
          }
        }
      }

      // Access modifiers (in class context)
      const modifierLength = checkAccessModifier(source, state.position);
      if (modifierLength > 0) {
        this.stripRange(source, state, modifierLength);
        return true;
      }

      // `as` type assertion
      if (identifier === 'as') {
        const length = checkAsAssertion(source, state.position);
        if (length > 0) {
          this.stripRange(source, state, length);
          state.stats.typesStripped++;
          return true;
        }
      }

      return false;
    }

    // Colon - might be type annotation
    if (char === ':') {
      const length = checkTypeAnnotation(source, state.position, {
        inTernary: false,
        inObjectLiteral: false,
        depth: state.depth,
        source,
      });
      if (length > 0) {
        this.stripRange(source, state, length);
        state.stats.typesStripped++;
        return true;
      }
      return false;
    }

    // Less than - might be generic params or angle bracket assertion
    if (char === '<') {
      // Check for generic parameters
      const genericLength = checkGenericParams(source, state.position);
      if (genericLength > 0) {
        this.stripRange(source, state, genericLength);
        state.stats.typesStripped++;
        return true;
      }

      // Check for angle bracket type assertion
      const assertionLength = checkAngleBracketAssertion(source, state.position);
      if (assertionLength > 0) {
        this.stripRange(source, state, assertionLength);
        state.stats.typesStripped++;
        return true;
      }

      return false;
    }

    // Exclamation - might be non-null assertion
    if (char === '!') {
      const length = checkNonNullAssertion(source, state.position);
      if (length > 0) {
        this.stripRange(source, state, length);
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * Check if position is right after `export` keyword.
   */
  private isAfterExport(source: string, position: number): boolean {
    let pos = position - 1;

    // Skip whitespace
    while (pos >= 0 && /\s/.test(source[pos])) {
      pos--;
    }

    // Check for 'export'
    if (pos < 5) return false;

    const word = source.slice(pos - 5, pos + 1);
    return word === 'export';
  }

  /**
   * Strip a range of characters, replacing with spaces to preserve positions.
   */
  private stripRange(source: string, state: StripperState, length: number): void {
    const stripped = source.slice(state.position, state.position + length);
    const replacement = this.config.preservePositions ? replaceWithSpaces(stripped) : '';

    for (const char of replacement) {
      state.output.push(char);
      updatePosition(char, state);
    }

    if (!this.config.preservePositions) {
      // Just advance position without output
      for (let i = 0; i < length; i++) {
        updatePosition(source[state.position + i], state);
      }
    }

    state.position += length;
  }

  /**
   * Replace a range with custom content (for enums).
   */
  private replaceRange(source: string, state: StripperState, length: number, replacement: string): void {
    const original = source.slice(state.position, state.position + length);

    // Add padding to preserve line count if needed
    const paddedReplacement = this.config.preservePositions ? calculateEnumPadding(original, replacement) : replacement;

    for (const char of paddedReplacement) {
      state.output.push(char);
    }

    // Update position tracking
    for (let i = 0; i < length; i++) {
      updatePosition(source[state.position + i], state);
    }

    state.position += length;
  }

  /**
   * Quick check if source appears to contain TypeScript syntax.
   * Used for early bailout optimization.
   */
  static looksLikeTypeScript(source: string): boolean {
    // Fast regex checks for common TypeScript patterns
    const patterns = [
      /\binterface\s+\w+/, // interface Foo
      /\btype\s+\w+\s*=/, // type Foo =
      /:\s*\w+[[\]<>|&]/, // : string[] or : Foo<T>
      /:\s*\w+\s*[=;,)]/, // : number = or : number; or (x: number)
      /\bimport\s+type\b/, // import type
      /\bexport\s+type\b/, // export type
      /\benum\s+\w+/, // enum Foo
      /\bdeclare\s+/, // declare const
      /\babstract\s+class\b/, // abstract class
      /\bas\s+\w+/, // as string
      /\bpublic\s+\w+/, // public prop
      /\bprivate\s+\w+/, // private prop
      /\bprotected\s+\w+/, // protected prop
      /\breadonly\s+\w+/, // readonly prop
      /!\s*[;,)\]}]/, // non-null assertion x!;
      /\)\s*:\s*\w+\s*[{=]/, // return type ): Type {
      /<\w+>/, // generic <T>
    ];

    return patterns.some((p) => p.test(source));
  }
}

/**
 * Convenience function to strip TypeScript syntax.
 */
export function stripTypeScript(source: string, config?: TypeScriptConfig): TypeScriptStripResult {
  const stripper = new TypeScriptStripper(config);
  return stripper.strip(source);
}

/**
 * Check if source appears to contain TypeScript syntax.
 */
export function isTypeScriptLike(source: string): boolean {
  return TypeScriptStripper.looksLikeTypeScript(source);
}
