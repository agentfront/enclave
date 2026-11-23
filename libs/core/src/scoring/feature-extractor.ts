/**
 * Feature Extractor
 *
 * Analyzes AST to extract security-relevant features for scoring.
 * This is the shared foundation used by all scorer implementations.
 *
 * @packageDocumentation
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { createHash } from 'crypto';
import type { NormalizedToolNamespace } from '@enclave-vm/ast';
import {
  DYNAMIC_TOOL_NAME,
  indexToolNamespaces,
  toolArgumentsOf,
  toolReferenceOfCallee,
  toolReferenceOfMember,
  type ToolNamespaceIndex,
  type ToolReference,
} from '../analysis/tool-references';
import type {
  ExtractedFeatures,
  ExtractedToolCall,
  PatternSignals,
  NumericSignals,
  SensitiveAccess,
  SensitiveCategory,
  ExtractionMeta,
} from './types';
import { RULE_THRESHOLDS } from './types';

/**
 * Regex patterns for sensitive field detection
 */
const SENSITIVE_PATTERNS: Record<SensitiveCategory, RegExp> = {
  authentication: /password|token|secret|api.?key|auth|credential|bearer/i,
  pii: /email|ssn|phone|address|credit.?card|birth.?date|social.?security/i,
  financial: /bank|routing|account.?num|iban|swift|cvv|pin/i,
  internal: /^__|^_[a-z]/,
};

/**
 * Patterns that suggest bulk/batch operations
 */
const BULK_PATTERNS = /bulk|batch|all|mass|multi/i;

/**
 * Patterns that suggest data sending/exfiltration
 */
const SEND_PATTERNS = /send|email|notify|post|webhook|export|upload|transfer/i;

/**
 * Patterns that suggest data retrieval
 */
const FETCH_PATTERNS = /list|get|query|search|find|fetch|read|select/i;

/**
 * Fields commonly used for limiting results
 */
const LIMIT_FIELD_NAMES = ['limit', 'pagesize', 'count', 'max', 'top', 'size', 'take'];

/**
 * Options of the feature extractor
 */
export interface FeatureExtractorOptions {
  /**
   * The tool namespaces of the sandbox the code is written for. A call of a namespace method
   * (`mail.send(args)`) is the tool call it stands for (`callTool('mail.send', args)`) and is
   * extracted as one.
   */
  toolNamespaces?: ReadonlyArray<NormalizedToolNamespace>;
}

/**
 * Error thrown when code cannot be analysed. The scoring gate treats it like any other scoring
 * error: `failOpen` decides whether the script runs.
 */
export class FeatureExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureExtractionError';
  }
}

/** An ESTree node, as far as this file reads it */
interface AstNode {
  type?: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  object?: AstNode;
  property?: AstNode;
  callee?: AstNode;
  argument?: AstNode;
  arguments?: AstNode[];
  loc?: { start?: { line: number; column: number } };
}

/**
 * Feature Extractor - extracts security-relevant features from code
 */
export class FeatureExtractor {
  private readonly toolNamespaces: ToolNamespaceIndex;

  constructor(options: FeatureExtractorOptions = {}) {
    this.toolNamespaces = indexToolNamespaces(options.toolNamespaces);
  }

  /**
   * Extract features from code
   *
   * @param code - Source code to analyze
   * @returns Extracted features for scoring
   * @throws FeatureExtractionError if the code cannot be parsed: text that cannot be read has
   * no features, which is not the same as having none that count
   */
  extract(code: string): ExtractedFeatures {
    const startTime = performance.now();

    // Parse code into AST
    const ast = this.parseCode(code);

    // Extract tool calls and patterns
    const toolCalls: ExtractedToolCall[] = [];
    const toolSequence: string[] = [];
    const sensitiveFields = new Set<string>();
    const sensitiveCategories = new Set<SensitiveCategory>();

    // Track loop depth during traversal
    let maxLoopNesting = 0;
    let iteratesOverToolResults = false;

    // Collect all numeric literals for limit detection
    const allNumericLiterals: number[] = [];
    const allStringLiterals: string[] = [];

    // Track variables assigned from tool calls
    const toolResultVars = new Set<string>();

    // Helper function to count loop ancestors
    const countLoopAncestors = (ancestors: acorn.Node[]): number => {
      let count = 0;
      for (const ancestor of ancestors) {
        const type = (ancestor as unknown as { type: string }).type;
        if (
          type === 'ForStatement' ||
          type === 'ForOfStatement' ||
          type === 'ForInStatement' ||
          type === 'WhileStatement' ||
          type === 'DoWhileStatement'
        ) {
          count++;
        }
      }
      return count;
    };

    // A tool reference that is not a direct call: the method of a namespace taken as a value,
    // or the namespace itself. What the script does with the value cannot be followed here, so
    // it counts as a call of that tool (or of a tool unknown until run time) with no arguments.
    const recordToolValue = (reference: ToolReference, node: acorn.Node, ancestors: acorn.Node[]): void => {
      const loopDepth = countLoopAncestors(ancestors);
      this.recordToolCall(reference, undefined, node, loopDepth, {
        toolCalls,
        toolSequence,
        allNumericLiterals,
        allStringLiterals,
        sensitiveFields,
        sensitiveCategories,
      });
    };

    // Walk with ancestors to properly track loop depth
    walk.ancestor(ast, {
      CallExpression: (node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) => {
        const loopDepth = countLoopAncestors(ancestors);
        maxLoopNesting = Math.max(maxLoopNesting, loopDepth);
        this.extractToolCall(
          node,
          loopDepth,
          toolCalls,
          toolSequence,
          allNumericLiterals,
          allStringLiterals,
          sensitiveFields,
          sensitiveCategories,
        );
      },

      // A tool namespace used as a value: `const m = mail`, `[mail]`, `f(mail)`
      Identifier: (node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) => {
        const identifier = node as unknown as AstNode;
        if (!this.toolNamespaces.has(identifier.name ?? '')) {
          return;
        }
        const parent = ancestors[ancestors.length - 2] as unknown as AstNode | undefined;
        if (parent?.type === 'MemberExpression' && parent.object === identifier) {
          return; // `mail.send`, `mail[key]`: the MemberExpression visitor has it
        }
        recordToolValue({ toolName: DYNAMIC_TOOL_NAME, isStaticName: false }, node, ancestors);
      },

      ForOfStatement: (node: acorn.Node) => {
        const forOfNode = node as unknown as { right?: { type?: string; name?: string } };
        // Check if iterating over a tool result variable
        if (forOfNode.right?.type === 'Identifier' && toolResultVars.has(forOfNode.right.name ?? '')) {
          iteratesOverToolResults = true;
        }
      },

      // Track variable assignments from tool calls
      VariableDeclarator: (node: acorn.Node) => {
        const varNode = node as unknown as { id?: AstNode; init?: AstNode };
        if (varNode.id?.type === 'Identifier' && varNode.init?.type === 'AwaitExpression') {
          // Check if it's the result of a tool call
          let awaitArg = varNode.init.argument;
          if (awaitArg?.type === 'ChainExpression') {
            awaitArg = (awaitArg as unknown as { expression?: AstNode }).expression;
          }
          if (
            awaitArg?.type === 'CallExpression' &&
            toolReferenceOfCallee(this.toolNamespaces, awaitArg.callee, awaitArg.arguments)
          ) {
            if (varNode.id.name) {
              toolResultVars.add(varNode.id.name);
            }
          }
        }
      },

      // Extract literals
      Literal: (node: acorn.Node) => {
        const literalNode = node as unknown as { value?: unknown };
        if (typeof literalNode.value === 'number') {
          allNumericLiterals.push(literalNode.value);
        } else if (typeof literalNode.value === 'string') {
          allStringLiterals.push(literalNode.value);
          this.detectSensitiveField(literalNode.value, sensitiveFields, sensitiveCategories);
        }
      },

      // Check property access for sensitive fields
      MemberExpression: (node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) => {
        // A method of a tool namespace that is not called where it stands: `const send =
        // mail.send`, `items.map(mail.send)`
        const reference = toolReferenceOfMember(this.toolNamespaces, node as unknown as AstNode);
        if (reference) {
          const parent = ancestors[ancestors.length - 2] as unknown as AstNode | undefined;
          if (!(parent?.type === 'CallExpression' && parent.callee === (node as unknown as AstNode))) {
            recordToolValue(reference, node, ancestors);
          }
        }

        const memberNode = node as unknown as {
          property?: { type?: string; name?: string; value?: string };
        };
        const propName =
          memberNode.property?.type === 'Identifier'
            ? memberNode.property.name
            : memberNode.property?.type === 'Literal'
              ? String(memberNode.property.value)
              : undefined;

        if (propName) {
          this.detectSensitiveField(propName, sensitiveFields, sensitiveCategories);
        }
      },
    });

    // Build features
    const lineCount = code.split('\n').length;
    const uniqueTools = new Set(toolCalls.filter((tc) => tc.isStaticName).map((tc) => tc.toolName));
    const toolsInLoops = [...new Set(toolCalls.filter((tc) => tc.insideLoop).map((tc) => tc.toolName))];

    // Calculate fan-out risk
    const fanOutRisk = this.calculateFanOutRisk(toolCalls, toolsInLoops.length, maxLoopNesting);

    // Find max limit value
    const maxLimit = this.findMaxLimitValue(toolCalls, allNumericLiterals);

    const patterns: PatternSignals = {
      totalToolCalls: toolCalls.length,
      uniqueToolsCount: uniqueTools.size,
      toolsInLoops,
      maxLoopNesting,
      toolSequence,
      iteratesOverToolResults,
    };

    const signals: NumericSignals = {
      maxLimit,
      maxStringLength: allStringLiterals.reduce((max, s) => Math.max(max, s.length), 0),
      toolCallDensity: lineCount > 0 ? toolCalls.length / lineCount : 0,
      fanOutRisk,
    };

    const sensitive: SensitiveAccess = {
      fieldsAccessed: [...sensitiveFields],
      categories: [...sensitiveCategories],
    };

    const meta: ExtractionMeta = {
      extractionTimeMs: performance.now() - startTime,
      codeHash: this.hashCode(code),
      lineCount,
    };

    return {
      toolCalls,
      patterns,
      signals,
      sensitive,
      meta,
    };
  }

  /**
   * Parse code into AST
   *
   * The code is read as a module, in which a top-level `await` is allowed, and a top-level
   * `return` is accepted as well: both forms of AgentScript can be analysed, the script as its
   * author wrote it and the script wrapped in its main function.
   *
   * @throws FeatureExtractionError if the code does not parse
   */
  private parseCode(code: string): acorn.Node {
    try {
      return acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
      });
    } catch (error) {
      throw new FeatureExtractionError(
        `Code could not be parsed for scoring: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Extract tool call information
   */
  private extractToolCall(
    node: acorn.Node,
    loopDepth: number,
    toolCalls: ExtractedToolCall[],
    toolSequence: string[],
    allNumericLiterals: number[],
    allStringLiterals: string[],
    sensitiveFields: Set<string>,
    sensitiveCategories: Set<SensitiveCategory>,
  ): void {
    const callNode = node as unknown as AstNode;

    // Check if this is a tool call: callTool, __safe_callTool or a tool namespace method
    const reference = toolReferenceOfCallee(this.toolNamespaces, callNode.callee, callNode.arguments);
    if (!reference) {
      return;
    }

    const toolArgsArg = toolArgumentsOf(callNode);

    this.recordToolCall(reference, toolArgsArg, node, loopDepth, {
      toolCalls,
      toolSequence,
      allNumericLiterals,
      allStringLiterals,
      sensitiveFields,
      sensitiveCategories,
    });
  }

  /**
   * Add one tool call to the features
   */
  private recordToolCall(
    reference: ToolReference,
    toolArgsArg: unknown,
    node: acorn.Node,
    loopDepth: number,
    into: {
      toolCalls: ExtractedToolCall[];
      toolSequence: string[];
      allNumericLiterals: number[];
      allStringLiterals: string[];
      sensitiveFields: Set<string>;
      sensitiveCategories: Set<SensitiveCategory>;
    },
  ): void {
    const { toolName, isStaticName } = reference;
    const location = (node as unknown as AstNode).loc?.start;

    // Extract argument information
    const argumentKeys: string[] = [];
    const stringLiterals: string[] = [];
    const numericLiterals: number[] = [];

    if (toolArgsArg) {
      this.extractFromArgs(
        toolArgsArg,
        argumentKeys,
        stringLiterals,
        numericLiterals,
        into.sensitiveFields,
        into.sensitiveCategories,
      );
    }

    const toolCall: ExtractedToolCall = {
      toolName,
      isStaticName,
      argumentKeys,
      stringLiterals,
      numericLiterals,
      insideLoop: loopDepth > 0,
      loopDepth,
      location: {
        line: location?.line ?? 0,
        column: location?.column ?? 0,
      },
    };

    into.toolCalls.push(toolCall);

    // Add to sequence if static
    if (isStaticName) {
      into.toolSequence.push(toolName);
    }

    // Add to overall literals. One at a time: an argument object can hold as many literals as
    // the script has room for, and a list of that length cannot be spread into a call.
    for (const value of numericLiterals) {
      into.allNumericLiterals.push(value);
    }
    for (const value of stringLiterals) {
      into.allStringLiterals.push(value);
    }
  }

  /**
   * Extract information from tool arguments
   */
  private extractFromArgs(
    argsNode: unknown,
    argumentKeys: string[],
    stringLiterals: string[],
    numericLiterals: number[],
    sensitiveFields: Set<string>,
    sensitiveCategories: Set<SensitiveCategory>,
  ): void {
    const objNode = argsNode as unknown as {
      type?: string;
      properties?: Array<{
        key?: { type?: string; name?: string; value?: string };
        value?: { type?: string; value?: unknown };
      }>;
    };

    if (objNode.type !== 'ObjectExpression') {
      return;
    }

    for (const prop of objNode.properties ?? []) {
      // Get property key
      const keyName =
        prop.key?.type === 'Identifier'
          ? prop.key.name
          : prop.key?.type === 'Literal'
            ? String(prop.key.value)
            : undefined;

      if (keyName) {
        argumentKeys.push(keyName);
        this.detectSensitiveField(keyName, sensitiveFields, sensitiveCategories);
      }

      // Get property value
      if (prop.value?.type === 'Literal') {
        const value = prop.value.value;
        if (typeof value === 'string') {
          stringLiterals.push(value);
          this.detectSensitiveField(value, sensitiveFields, sensitiveCategories);
        } else if (typeof value === 'number') {
          numericLiterals.push(value);
        }
      }
    }
  }

  /**
   * Detect if a field name is sensitive
   */
  private detectSensitiveField(
    fieldName: string,
    sensitiveFields: Set<string>,
    sensitiveCategories: Set<SensitiveCategory>,
  ): void {
    for (const [category, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
      if (pattern.test(fieldName)) {
        sensitiveFields.add(fieldName);
        sensitiveCategories.add(category as SensitiveCategory);
      }
    }
  }

  /**
   * Calculate fan-out risk score
   */
  private calculateFanOutRisk(
    toolCalls: ExtractedToolCall[],
    toolsInLoopsCount: number,
    maxLoopNesting: number,
  ): number {
    let risk = 0;

    // Tools in loops increase risk
    risk += toolsInLoopsCount * 15;

    // Deep loop nesting increases risk
    risk += maxLoopNesting * 10;

    // Many tool calls increase risk
    if (toolCalls.length > RULE_THRESHOLDS.HIGH_DENSITY_CALLS) {
      risk += (toolCalls.length - RULE_THRESHOLDS.HIGH_DENSITY_CALLS) * 3;
    }

    // Check for bulk operation patterns
    for (const tc of toolCalls) {
      if (BULK_PATTERNS.test(tc.toolName)) {
        risk += 15;
      }
    }

    return Math.min(100, risk);
  }

  /**
   * Find maximum limit value from tool calls and literals
   */
  private findMaxLimitValue(toolCalls: ExtractedToolCall[], allNumericLiterals: number[]): number {
    let maxLimit = 0;

    // Check tool call arguments for limit fields
    for (const tc of toolCalls) {
      const hasLimitArg = tc.argumentKeys.some((key) => LIMIT_FIELD_NAMES.includes(key.toLowerCase()));

      if (hasLimitArg) {
        // Use the largest numeric literal in this tool call as the limit
        for (const num of tc.numericLiterals) {
          if (num > maxLimit) {
            maxLimit = num;
          }
        }
      }
    }

    // Also check all numeric literals > 1000 as potential limits
    for (const num of allNumericLiterals) {
      if (num > 1000 && num > maxLimit) {
        maxLimit = num;
      }
    }

    return maxLimit;
  }

  /**
   * Hash code for caching: the whole SHA-256 digest. The hash is the only key of a cached
   * decision, so two texts may share a decision only if they are the same text.
   */
  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Check if a tool sequence indicates potential exfiltration
   */
  static detectExfiltrationPattern(toolSequence: string[]): boolean {
    // Look for fetch followed by send patterns
    let lastWasFetch = false;

    for (const toolName of toolSequence) {
      if (FETCH_PATTERNS.test(toolName)) {
        lastWasFetch = true;
      } else if (lastWasFetch && SEND_PATTERNS.test(toolName)) {
        return true;
      } else {
        lastWasFetch = false;
      }
    }

    return false;
  }

  /**
   * Check if a tool name suggests bulk operations
   */
  static isBulkOperation(toolName: string): boolean {
    return BULK_PATTERNS.test(toolName);
  }

  /**
   * Check if a tool name suggests data sending
   */
  static isSendOperation(toolName: string): boolean {
    return SEND_PATTERNS.test(toolName);
  }
}
