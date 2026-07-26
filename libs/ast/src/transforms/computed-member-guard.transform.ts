/**
 * Computed Member Guard Transform (runtime property-key sanitizer)
 *
 * Static analysis cannot resolve every runtime-built property name — e.g.
 * `const c = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); obj[c]`
 * launders the string `"constructor"` through a variable, so no static rule sees it. This
 * transform closes that gap the way n8n's expression sandbox does: it rewrites every DYNAMIC
 * computed member access `obj[expr]` into `obj[__ag_guardKey(expr)]`, and `__ag_guardKey`
 * checks the RESOLVED key at runtime, refusing the dangerous prototype-chain properties.
 *
 * Design notes:
 * - Applied AFTER validation, so it neither masks the static rules nor trips `no-user-functions`
 *   / reserved-prefix on its injected helper.
 * - The helper is injected at PROGRAM scope (before `__ag_main`), so its `String` reference and
 *   the intrinsic it captures resolve outside any user scope — sandbox code cannot shadow them.
 *   The `__ag_` name is reserved, so user code cannot reassign the helper either.
 * - The guard returns the ALREADY-COERCED string, so the subsequent property read cannot
 *   re-coerce a crafted `toString`/`Symbol.toPrimitive` to a different (dangerous) value (TOCTOU).
 * - The blocked-key set and throw-vs-undefined behaviour MIRROR the runtime membrane for the
 *   active security level (constructor only when `blockConstructor`, undefined instead of throw
 *   when `throwOnBlocked` is false), so the guard never contradicts the configured policy.
 * - Before throwing, it reports through `__ag_reportViolation__` when present (STRICT/SECURE
 *   only), so a refused access is FAIL-CLOSED: the run fails afterwards even if sandbox code
 *   catches the thrown error, matching the existing code-generation defense.
 * - Only NON-literal keys are wrapped; literals (`obj['x']`, `arr[0]`) are already covered by the
 *   static rules and the runtime membrane, so wrapping them would only add overhead.
 *
 * This is defense-in-depth: the runtime membrane already refuses these keys on host-facing
 * objects. The guard additionally protects plain in-realm objects and fails fast with a clear
 * error regardless of how the key was constructed.
 *
 * @packageDocumentation
 */

import * as walk from 'acorn-walk';
import type * as acorn from 'acorn';

/** Name of the injected runtime guard helper. Reserved prefix so user code cannot shadow it. */
export const GUARD_KEY_FN = '__ag_guardKey';

/** Name of the captured `String` intrinsic used by the guard for coercion. */
const GUARD_COERCE_INTRINSIC = '__ag_guardCoerce';

/** Name of the captured policy-violation reporter used to fail closed at STRICT/SECURE. */
const GUARD_REPORT_INTRINSIC = '__ag_guardReport';

/**
 * Options controlling the guard's blocked-key set and behaviour so it mirrors the runtime
 * membrane for the active security level.
 */
export interface ComputedMemberGuardOptions {
  /** Property names to refuse (already resolved from the security level's proxy config). */
  blockedKeys: string[];
  /** When true, refusing a key throws; when false, it yields `undefined` (mirrors the membrane). */
  throwOnBlocked: boolean;
}

/** Default blocked keys — every prototype-chain / Function-constructor unlocking property. */
export const DEFAULT_GUARD_BLOCKED_KEYS = [
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
];

/**
 * Result of the computed-member guard transform.
 */
export interface ComputedMemberGuardResult {
  /** Number of computed member accesses wrapped with the runtime guard. */
  guardedCount: number;
}

/** Build the injected guard helper source for a given blocked-key set and behaviour. */
function buildGuardHelperSource(blockedKeys: string[], throwOnBlocked: boolean): string {
  const condition = blockedKeys.map((key) => `__s === ${JSON.stringify(key)}`).join(' || ');
  // Message includes the resolved key so callers (and tests) can see what was refused. Built with
  // `+` at runtime; this transform runs after the concatenation transform so it is not rewritten.
  const onBlocked = throwOnBlocked
    ? `if (${GUARD_REPORT_INTRINSIC}) { try { ${GUARD_REPORT_INTRINSIC}('COMPUTED_PROPERTY_ACCESS'); } catch (__e) {} }
       throw new Error("Security violation: computed access to '" + __s + "' is blocked. " +
       "This property can be used for sandbox escape attacks.");`
    : `return undefined;`;
  // `__ag_reportViolation__` exists only at STRICT/SECURE. Reporting through it makes a refused
  // access FAIL-CLOSED (the run fails even if user code catches the throw). `typeof` on an
  // undeclared global is safe (no ReferenceError), matching the code-generation detector.
  return `
const ${GUARD_COERCE_INTRINSIC} = String;
const ${GUARD_REPORT_INTRINSIC} = (typeof __ag_reportViolation__ === 'function') ? __ag_reportViolation__ : null;
const ${GUARD_KEY_FN} = (__k) => {
  if (typeof __k === 'symbol') return __k;
  const __s = ${GUARD_COERCE_INTRINSIC}(__k);
  if (${condition}) {
    ${onBlocked}
  }
  return __s;
};
`;
}

/**
 * Wrap every dynamic computed member key with a runtime guard call and inject the guard helper.
 *
 * Mutates the AST in place. Must be given a Program node (the top-level parse result).
 *
 * @param ast Program AST to transform
 * @param parse Acorn parse function, used to build the injected helper statements
 * @param options Blocked-key set and behaviour (mirrors the membrane for the security level)
 * @returns Number of guarded accesses
 */
export function guardComputedMemberKeys(
  ast: acorn.Node,
  parse: (source: string) => acorn.Node,
  options: ComputedMemberGuardOptions = { blockedKeys: DEFAULT_GUARD_BLOCKED_KEYS, throwOnBlocked: true },
): ComputedMemberGuardResult {
  const blockedKeys = options.blockedKeys ?? DEFAULT_GUARD_BLOCKED_KEYS;
  // Nothing to enforce (e.g. a level that blocks no keys) — leave the code untouched.
  if (blockedKeys.length === 0) {
    return { guardedCount: 0 };
  }

  // The helper can only be injected into a Program body. Fail loudly BEFORE walking so we never
  // rewrite `obj[expr]` into `obj[__ag_guardKey(expr)]` without a matching helper (which would
  // produce a ReferenceError at runtime instead of a real guard).
  const program = ast as unknown as { type?: string; body?: unknown };
  if (program.type !== 'Program' || !Array.isArray(program.body)) {
    throw new Error('guardComputedMemberKeys requires a Program AST node to inject its runtime helper');
  }

  let guardedCount = 0;

  walk.simple(ast as unknown as acorn.Node, {
    MemberExpression: (node: any) => {
      if (!node.computed || !node.property || node.__agGuarded) {
        return;
      }
      // Literals (string/number) are statically analysable and already covered elsewhere.
      if (node.property.type === 'Literal') {
        return;
      }

      const originalKey = node.property;
      node.property = {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: GUARD_KEY_FN },
        arguments: [originalKey],
        optional: false,
      };
      node.__agGuarded = true;
      guardedCount++;
    },
  });

  if (guardedCount > 0) {
    injectGuardHelper(ast, parse, blockedKeys, options.throwOnBlocked);
  }

  return { guardedCount };
}

/**
 * Inject the guard helper statements at the top of the Program body, before any user statement
 * (and before the `__ag_main` wrapper), so the helper is defined before it is ever called and
 * resolves its intrinsics outside any user-shadowable scope.
 */
function injectGuardHelper(
  ast: any,
  parse: (source: string) => acorn.Node,
  blockedKeys: string[],
  throwOnBlocked: boolean,
): void {
  if (ast.type !== 'Program' || !Array.isArray(ast.body)) {
    return;
  }
  const helperProgram = parse(buildGuardHelperSource(blockedKeys, throwOnBlocked)) as any;
  ast.body.unshift(...helperProgram.body);
}
