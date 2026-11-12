import * as acorn from 'acorn';
import {
  ValidationRule,
  ValidationConfig,
  ValidationResult,
  ValidationContext,
  ValidationIssue,
  ValidationSeverity,
  ValidationStats,
} from './interfaces';
import { ParseError, InvalidSourceError, ConfigurationError } from './errors';
import { transformAst, generateCode } from './transformer';
import { PreScanner, PreScannerError, type PreScannerPresetLevel, type PartialPreScannerConfig } from './pre-scanner';

/**
 * How many issues one validation collects when the caller sets no `maxIssues`.
 *
 * The source is text the host did not write, and the result is built in the host: without a
 * bound, the list of issues grows with the source for as long as the source is refused.
 */
export const DEFAULT_MAX_ISSUES = 100;

/**
 * The cap of one validation. `0` (or `Infinity`) is the documented way to ask for every issue;
 * a value that is not a count (negative, `NaN`, below one) is not taken for "no cap".
 */
function resolveMaxIssues(value: unknown): number {
  if (value === 0 || value === Infinity) return Infinity;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value);
  return DEFAULT_MAX_ISSUES;
}

/**
 * Main AST validator class
 */
export class JSAstValidator {
  private rules: Map<string, ValidationRule> = new Map();
  private explicitlyRegistered = new Set<string>();

  constructor(rules?: ValidationRule[]) {
    if (rules) {
      for (const rule of rules) {
        this.registerRule(rule, true);
      }
    }
  }

  /**
   * Register a validation rule
   * @param rule The rule to register
   * @param explicit Whether this rule was explicitly registered (via constructor)
   */
  registerRule(rule: ValidationRule, explicit = false): void {
    if (this.rules.has(rule.name)) {
      throw new ConfigurationError(`Rule ${rule.name} is already registered`);
    }
    this.rules.set(rule.name, rule);
    if (explicit) {
      this.explicitlyRegistered.add(rule.name);
    }
  }

  /**
   * Unregister a validation rule
   */
  unregisterRule(ruleName: string): boolean {
    this.explicitlyRegistered.delete(ruleName);
    return this.rules.delete(ruleName);
  }

  /**
   * Get all registered rules
   */
  getRules(): ValidationRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get a specific rule by name
   */
  getRule(ruleName: string): ValidationRule | undefined {
    return this.rules.get(ruleName);
  }

  /**
   * Validate JavaScript source code
   */
  async validate(source: string, config: ValidationConfig = {}): Promise<ValidationResult> {
    const startTime = Date.now();

    // Validate input
    if (typeof source !== 'string') {
      throw new InvalidSourceError('Source must be a string');
    }

    if (source.trim().length === 0) {
      throw new InvalidSourceError('Source cannot be empty');
    }

    const issues: ValidationIssue[] = [];
    const maxIssues = resolveMaxIssues(config.maxIssues);
    // An error was reported (whether or not the cap left room for more issues after it)
    let hasError = false;
    // The list is not everything the rules had to say: issues over the cap, or an early stop
    let incomplete = false;

    /**
     * Keep an issue while the cap leaves room. The first error is kept in any case, in place of
     * the last issue collected before it, so that a list that is full of warnings still shows why
     * the source is refused, and never holds more than the cap.
     */
    const collect = (issue: ValidationIssue): void => {
      const isError = issue.severity === ValidationSeverity.ERROR;
      if (issues.length < maxIssues) {
        issues.push(issue);
      } else {
        incomplete = true;
        if (isError && !hasError) issues[issues.length - 1] = issue;
      }
      if (isError) hasError = true;
    };

    let ast: acorn.Node | undefined;
    let parseError: Error | undefined;
    let preScanError: Error | undefined;
    let preScanStats: ValidationResult['preScanStats'] | undefined;

    // Run pre-scanner (Layer 0) if enabled
    const preScanEnabled = config.preScan?.enabled !== false;
    if (preScanEnabled) {
      const preset = (config.preScan?.preset ?? 'standard') as PreScannerPresetLevel;
      const preScanConfig = config.preScan?.config as PartialPreScannerConfig | undefined;

      const preScanner = new PreScanner({
        preset,
        config: preScanConfig,
      });

      const preScanResult = preScanner.scan(source);

      // Store stats
      preScanStats = {
        inputSize: preScanResult.stats.inputSize,
        lineCount: preScanResult.stats.lineCount,
        maxNestingDepthFound: preScanResult.stats.maxNestingDepthFound,
        regexCount: preScanResult.stats.regexCount,
        scanDurationMs: preScanResult.stats.scanDurationMs,
      };

      // Add pre-scanner issues to validation issues
      for (const issue of preScanResult.issues) {
        collect({
          code: issue.code,
          severity:
            issue.severity === 'error'
              ? ValidationSeverity.ERROR
              : issue.severity === 'warning'
                ? ValidationSeverity.WARNING
                : ValidationSeverity.INFO,
          message: issue.message,
          location: issue.line !== undefined ? { line: issue.line, column: issue.column ?? 0 } : undefined,
          data: issue.data,
        });
      }

      // If pre-scan failed, return early (don't attempt to parse)
      if (!preScanResult.success) {
        preScanError = new PreScannerError(
          preScanResult.fatalIssue?.message ?? 'Pre-scan failed',
          (preScanResult.fatalIssue?.code as any) ?? 'PRESCANNER_UNKNOWN',
          { position: preScanResult.fatalIssue?.position, line: preScanResult.fatalIssue?.line },
        );

        return {
          valid: false,
          issues,
          preScanError,
          preScanStats,
          rulesExecuted: 0,
          ...(incomplete ? { incomplete } : {}),
        };
      }
    }

    // Parse the source code
    try {
      const parseOptions: acorn.Options = {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ...config.parseOptions,
      };

      ast = acorn.parse(source, parseOptions) as unknown as acorn.Node;
    } catch (err: unknown) {
      const error = err as Error & { loc?: { line: number; column: number } };
      parseError = new ParseError(error.message || 'Failed to parse source code', error.loc?.line, error.loc?.column);

      collect({
        code: 'PARSE_ERROR',
        severity: ValidationSeverity.ERROR,
        message: parseError.message,
        location: error.loc ? { line: error.loc.line, column: error.loc.column } : undefined,
      });

      return {
        valid: false,
        issues,
        parseError,
        preScanStats,
        rulesExecuted: 0,
        ...(incomplete ? { incomplete } : {}),
      };
    }

    // Get enabled rules
    const enabledRules = this.getEnabledRules(config);

    // Execute rules
    let rulesExecuted = 0;
    // The rules did not all run to their end: what they would have reported is unknown
    let stopped = false;
    try {
      for (const rule of enabledRules) {
        // Get rule configuration for severity override
        const ruleConfig = config.rules?.[rule.name];
        const configSeverity = typeof ruleConfig === 'object' ? ruleConfig.severity : undefined;

        // Create per-rule validation context with proper severity resolution
        const context: ValidationContext = {
          ast,
          source,
          config,
          visited: new Set(),
          metadata: new Map(),
          report: (issue) => {
            // Precedence: issue.severity → ruleConfig.severity → rule.defaultSeverity → ERROR fallback
            const severity = issue.severity ?? configSeverity ?? rule.defaultSeverity ?? ValidationSeverity.ERROR;

            const fullIssue: ValidationIssue = {
              ...issue,
              severity,
            };

            collect(fullIssue);

            // Stop on first error if configured
            if (config.stopOnFirstError && fullIssue.severity === ValidationSeverity.ERROR) {
              throw new StopValidationError();
            }

            // Stop at the cap only once an error is on the list. While everything collected is a
            // warning the remaining rules still have to run: one of them may refuse the source,
            // and a validation that stopped before it would have called the source valid.
            if (hasError && issues.length >= maxIssues) {
              throw new StopValidationError();
            }
          },
        };

        rulesExecuted++;
        await rule.validate(context);
      }
    } catch (err) {
      if (!(err instanceof StopValidationError)) {
        throw err;
      }
      stopped = true;
      incomplete = true;
    }

    const durationMs = Date.now() - startTime;

    // Perform transformation if enabled and validation passed
    let transformedCode: string | undefined;
    if (config.transform?.enabled && ast) {
      try {
        // Clone the AST before transforming to avoid mutating the original
        const astClone = JSON.parse(JSON.stringify(ast));
        transformAst(astClone, config.transform);
        transformedCode = generateCode(astClone);
      } catch (err) {
        const error = err as Error;
        collect({
          code: 'TRANSFORM_ERROR',
          severity: ValidationSeverity.ERROR,
          message: `Code transformation failed: ${error.message}`,
        });
      }
    }

    return {
      // Valid is the answer of every rule: a validation that stopped early cannot give it
      valid: !stopped && !hasError && !issues.some((issue) => issue.severity === ValidationSeverity.ERROR),
      issues,
      ast,
      rulesExecuted,
      transformedCode,
      preScanStats,
      ...(incomplete ? { incomplete } : {}),
    };
  }

  /**
   * Get validation statistics from a result
   */
  getStats(result: ValidationResult, durationMs: number): ValidationStats {
    const stats = {
      totalIssues: result.issues.length,
      errors: 0,
      warnings: 0,
      infos: 0,
      rulesExecuted: result.rulesExecuted ?? 0,
      durationMs,
    };

    for (const issue of result.issues) {
      switch (issue.severity) {
        case ValidationSeverity.ERROR:
          stats.errors++;
          break;
        case ValidationSeverity.WARNING:
          stats.warnings++;
          break;
        case ValidationSeverity.INFO:
          stats.infos++;
          break;
      }
    }

    return stats;
  }

  /**
   * Get enabled rules based on configuration
   */
  private getEnabledRules(config: ValidationConfig): ValidationRule[] {
    const enabled: ValidationRule[] = [];

    for (const rule of this.rules.values()) {
      const ruleConfig = config.rules?.[rule.name];

      // If rule is not configured, use its default enabled state
      // Rules explicitly registered via constructor are always considered enabled
      if (ruleConfig === undefined) {
        if (this.explicitlyRegistered.has(rule.name) || rule.enabledByDefault) {
          enabled.push(rule);
        }
        continue;
      }

      // If rule config is boolean
      if (typeof ruleConfig === 'boolean') {
        if (ruleConfig) {
          enabled.push(rule);
        }
        continue;
      }

      // If rule config is object
      // noinspection SuspiciousTypeOfGuard
      const explicitlyEnabled = typeof ruleConfig.enabled === 'boolean' ? ruleConfig.enabled : undefined;
      const shouldEnable = explicitlyEnabled ?? rule.enabledByDefault;
      if (shouldEnable) {
        enabled.push(rule);
      }
    }

    return enabled;
  }
}

/**
 * Internal error to stop validation early
 */
class StopValidationError extends Error {
  constructor() {
    super('Validation stopped');
    this.name = 'StopValidationError';
  }
}
