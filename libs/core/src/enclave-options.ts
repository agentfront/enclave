/**
 * Checks of the options an `Enclave` is created with
 *
 * The options are the host's own, but a host passes on what it was given: a wrapper forwards
 * `{ maxIterations: opts.maxIterations }` whether or not its caller set it, and a server copies a
 * number out of a request. So the constructor holds two things:
 *
 * 1. An option has the documented type and range, or the constructor refuses it with a
 *    `TypeError`. The limits end up as numbers in the runtime the sandbox generates for itself;
 *    a value that is not a number has no business there, and `count > NaN` is never true.
 * 2. An option whose value is `undefined` is an option that was not set: it has the value of the
 *    security level, exactly as if the key were absent.
 *
 * @packageDocumentation
 */

import { SECURITY_LEVEL_CONFIGS } from './types';
import type { CreateEnclaveOptions, SecurityLevel } from './types';

/**
 * The largest timeout: the longest delay a timer holds. `setTimeout` fires after 1 ms for a
 * longer one, which would end a script at once. (`vm` itself would take up to 2^32 - 1, and the
 * sum of a timeout and `doubleVm.parentTimeoutBuffer` stays below that.)
 */
export const MAX_TIMEOUT_MS = 0x7fffffff;

/** A copy of `value` with the own properties whose value is not `undefined`. */
export function withoutUndefined<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) result[key] = member;
  }
  return result as T;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  return `a value of type ${typeof value}`;
}

/**
 * A count or a size: an integer between `min` and `max`.
 *
 * @throws TypeError for anything else, a number that is not finite included
 */
export function assertIntegerOption(
  name: string,
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    const range =
      max === Number.MAX_SAFE_INTEGER ? `an integer of at least ${min}` : `an integer from ${min} to ${max}`;
    throw new TypeError(`${name} must be ${range}, got ${describe(value)}`);
  }
}

/** @throws TypeError unless `value` is a finite number of at least `min` */
export function assertFiniteNumberOption(name: string, value: unknown, min: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a finite number of at least ${min}, got ${describe(value)}`);
  }
}

/** @throws TypeError unless `value` is `true` or `false` */
export function assertBooleanOption(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be true or false, got ${describe(value)}`);
  }
}

/** @throws TypeError unless `value` is one of the four security levels */
export function assertSecurityLevel(value: unknown): asserts value is SecurityLevel {
  // By own key: every object answers for `constructor` and `toString`
  if (typeof value !== 'string' || !Object.hasOwn(SECURITY_LEVEL_CONFIGS, value)) {
    throw new TypeError(
      `securityLevel must be one of ${Object.keys(SECURITY_LEVEL_CONFIGS).join(', ')}, got ${
        typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : describe(value)
      }`,
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecordOption(name: string, value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${name} must be an object, got ${describe(value)}`);
  }
}

/** @throws TypeError when `value` has a key that is not one of `known` */
function assertKnownKeys(name: string, value: Record<string, unknown>, known: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new TypeError(`${name} has no option ${JSON.stringify(key.slice(0, 40))}`);
    }
  }
}

function isOneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

/** The pre-scanner presets, and the members of a pre-scanner configuration by kind. */
const PRE_SCAN_PRESETS = ['agentscript', 'strict', 'secure', 'standard', 'permissive'] as const;
const PRE_SCAN_INTEGERS = [
  'maxInputSize',
  'maxLineLength',
  'maxLines',
  'maxNestingDepth',
  'maxConsecutiveOperators',
  'maxRegexLength',
  'maxRegexCount',
  'maxStringLength',
  'maxTotalStringContent',
] as const;
const PRE_SCAN_BOOLEANS = ['unicodePreCheck', 'blockBidiPatterns', 'blockInvisibleChars'] as const;
const PRE_SCAN_REGEX_MODES = ['allow', 'analyze', 'block'] as const;
const PRE_SCAN_REGEX_ANALYSIS_LEVELS = ['catastrophic', 'polynomial'] as const;

/** The limits that are counts or sizes, with the smallest value each may have. */
const INTEGER_OPTIONS: ReadonlyArray<readonly [keyof CreateEnclaveOptions, number, number?]> = [
  // What a timer can hold (see MAX_TIMEOUT_MS)
  ['timeout', 1, MAX_TIMEOUT_MS],
  ['maxIterations', 1],
  ['maxToolCalls', 0],
  // 0: no memory limit
  ['memoryLimit', 0],
  ['maxSanitizeDepth', 1],
  ['maxSanitizeProperties', 1],
  ['maxConsoleOutputBytes', 0],
  ['maxConsoleCalls', 0],
];

const BOOLEAN_OPTIONS: ReadonlyArray<keyof CreateEnclaveOptions> = [
  'validate',
  'transform',
  'sanitizeStackTraces',
  'allowFunctionsInGlobals',
  'allowBuiltins',
];

const SECURE_PROXY_BOOLEANS = ['blockConstructor', 'blockPrototype', 'blockLegacyAccessors', 'throwOnBlocked'] as const;

const PARENT_VALIDATION_BOOLEANS = ['validateOperationNames', 'blockSuspiciousSequences'] as const;

/**
 * Check the options of an `Enclave` and return them without the keys that are `undefined`
 * (nested: `secureProxyConfig`, `toolBridge`, `doubleVm` and its `parentValidation`).
 *
 * Only the scalar options are checked here: the ones that select or bound a control. Handlers,
 * globals, tool namespaces, adapters, `maxGlobalFunctionCalls`, `toolCallGraceMs` and the tool
 * bridge's mode and payload size have their own checks in the constructor.
 *
 * @throws TypeError when an option has a value outside its documented type or range
 */
export function normalizeEnclaveOptions(options: CreateEnclaveOptions): CreateEnclaveOptions {
  if (!isPlainRecord(options)) {
    throw new TypeError(`Enclave options must be an object, got ${describe(options)}`);
  }
  const result = withoutUndefined(options) as CreateEnclaveOptions & Record<string, unknown>;

  if (result.securityLevel !== undefined) assertSecurityLevel(result.securityLevel);

  for (const [name, min, max] of INTEGER_OPTIONS) {
    if (result[name] !== undefined) assertIntegerOption(name, result[name], min, max);
  }
  for (const name of BOOLEAN_OPTIONS) {
    if (result[name] !== undefined) assertBooleanOption(name, result[name]);
  }

  if (result.secureProxyConfig !== undefined) {
    assertRecordOption('secureProxyConfig', result.secureProxyConfig);
    const proxy = withoutUndefined(result.secureProxyConfig) as Record<string, unknown>;
    for (const name of SECURE_PROXY_BOOLEANS) {
      if (proxy[name] !== undefined) assertBooleanOption(`secureProxyConfig.${name}`, proxy[name]);
    }
    if (proxy['proxyMaxDepth'] !== undefined) {
      assertIntegerOption('secureProxyConfig.proxyMaxDepth', proxy['proxyMaxDepth'], 1);
    }
    result.secureProxyConfig = proxy as CreateEnclaveOptions['secureProxyConfig'];
  }

  if (result.toolBridge !== undefined) {
    assertRecordOption('toolBridge', result.toolBridge);
    const bridge = withoutUndefined(result.toolBridge) as Record<string, unknown>;
    // `maxPayloadBytes` and `mode` are checked by the constructor, which also applies their defaults
    if (bridge['acknowledgeInsecureDirect'] !== undefined) {
      assertBooleanOption('toolBridge.acknowledgeInsecureDirect', bridge['acknowledgeInsecureDirect']);
    }
    result.toolBridge = bridge as CreateEnclaveOptions['toolBridge'];
  }

  if (result.preScan !== undefined) {
    assertRecordOption('preScan', result.preScan);
    const preScan = withoutUndefined(result.preScan) as Record<string, unknown>;
    assertKnownKeys('preScan', preScan, ['preset', 'config']);
    if (preScan['preset'] !== undefined && !isOneOf(PRE_SCAN_PRESETS, preScan['preset'])) {
      throw new TypeError(
        `preScan.preset must be one of ${PRE_SCAN_PRESETS.join(', ')}, got ${describe(preScan['preset'])}`,
      );
    }
    if (preScan['config'] !== undefined) {
      assertRecordOption('preScan.config', preScan['config']);
      const config = withoutUndefined(preScan['config']) as Record<string, unknown>;
      assertKnownKeys('preScan.config', config, [
        ...PRE_SCAN_INTEGERS,
        ...PRE_SCAN_BOOLEANS,
        'regexMode',
        'regexAnalysisLevel',
      ]);
      for (const name of PRE_SCAN_INTEGERS) {
        if (config[name] !== undefined) assertIntegerOption(`preScan.config.${name}`, config[name], 0);
      }
      for (const name of PRE_SCAN_BOOLEANS) {
        if (config[name] !== undefined) assertBooleanOption(`preScan.config.${name}`, config[name]);
      }
      if (config['regexMode'] !== undefined && !isOneOf(PRE_SCAN_REGEX_MODES, config['regexMode'])) {
        throw new TypeError(
          `preScan.config.regexMode must be one of ${PRE_SCAN_REGEX_MODES.join(', ')}, got ${describe(config['regexMode'])}`,
        );
      }
      if (
        config['regexAnalysisLevel'] !== undefined &&
        !isOneOf(PRE_SCAN_REGEX_ANALYSIS_LEVELS, config['regexAnalysisLevel'])
      ) {
        throw new TypeError(
          `preScan.config.regexAnalysisLevel must be one of ${PRE_SCAN_REGEX_ANALYSIS_LEVELS.join(', ')}, got ${describe(config['regexAnalysisLevel'])}`,
        );
      }
      preScan['config'] = config;
    }
    result.preScan = preScan as CreateEnclaveOptions['preScan'];
  }

  if (result.doubleVm !== undefined) {
    assertRecordOption('doubleVm', result.doubleVm);
    const doubleVm = withoutUndefined(result.doubleVm) as Record<string, unknown>;
    if (doubleVm['enabled'] !== undefined) assertBooleanOption('doubleVm.enabled', doubleVm['enabled']);
    if (doubleVm['parentTimeoutBuffer'] !== undefined) {
      assertIntegerOption('doubleVm.parentTimeoutBuffer', doubleVm['parentTimeoutBuffer'], 0, MAX_TIMEOUT_MS);
    }
    if (doubleVm['parentValidation'] !== undefined) {
      assertRecordOption('doubleVm.parentValidation', doubleVm['parentValidation']);
      const validation = withoutUndefined(doubleVm['parentValidation']) as Record<string, unknown>;
      for (const name of PARENT_VALIDATION_BOOLEANS) {
        if (validation[name] !== undefined) {
          assertBooleanOption(`doubleVm.parentValidation.${name}`, validation[name]);
        }
      }
      if (validation['maxOperationsPerSecond'] !== undefined) {
        assertFiniteNumberOption(
          'doubleVm.parentValidation.maxOperationsPerSecond',
          validation['maxOperationsPerSecond'],
          1,
        );
      }
      if (validation['rapidEnumerationThreshold'] !== undefined) {
        assertIntegerOption(
          'doubleVm.parentValidation.rapidEnumerationThreshold',
          validation['rapidEnumerationThreshold'],
          1,
        );
      }
      if (validation['rapidEnumerationOverrides'] !== undefined) {
        assertRecordOption(
          'doubleVm.parentValidation.rapidEnumerationOverrides',
          validation['rapidEnumerationOverrides'],
        );
        for (const [operation, threshold] of Object.entries(validation['rapidEnumerationOverrides'])) {
          assertIntegerOption(
            `doubleVm.parentValidation.rapidEnumerationOverrides[${JSON.stringify(operation.slice(0, 40))}]`,
            threshold,
            1,
          );
        }
      }
      doubleVm['parentValidation'] = validation;
    }
    result.doubleVm = doubleVm as CreateEnclaveOptions['doubleVm'];
  }

  return result;
}

/**
 * A number as the text of a numeric literal, for code the runtime generates for itself.
 *
 * The generators call this for every limit they write into a script, whatever checked the value
 * before: a parameter that is not a finite number never becomes program text.
 *
 * @throws TypeError unless `value` is a finite number
 */
export function numericLiteral(name: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${describe(value)}`);
  }
  return String(value);
}

/**
 * A boolean as the text `true` or `false`, for code the runtime generates for itself.
 *
 * @throws TypeError unless `value` is a boolean
 */
export function booleanLiteral(name: string, value: unknown): string {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be true or false, got ${describe(value)}`);
  }
  return value ? 'true' : 'false';
}
