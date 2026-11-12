# AST Guard

[![npm version](https://img.shields.io/npm/v/@enclave-vm/ast.svg)](https://www.npmjs.com/package/@enclave-vm/ast)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

> A production-ready, extensible AST validator for JavaScript with rule-based validation

AST Guard is a powerful static analysis tool for JavaScript code. It provides a flexible, rule-based architecture for validating Abstract Syntax Trees (AST) with comprehensive built-in rules and support for custom validation logic.

## Bank-Grade Security

### Hardened Against All Known Sandbox Escape Exploits

| Metric         | Value                                                |
| -------------- | ---------------------------------------------------- |
| CVE Protection | 100% (all known vm2, isolated-vm, node-vm exploits)  |
| Security Tests | 613 tests, 100% pass rate                            |
| Code Coverage  | 95%+                                                 |
| Defense Layers | 4 (AST validation, transformation, proxy, isolation) |

**Protected Against:**

- **vm2 CVEs**: CVE-2023-29017, CVE-2023-30547, CVE-2023-32313, CVE-2023-37466
- **Constructor chain escapes**: `[].constructor.constructor('code')()`
- **Prototype pollution**: `__proto__`, `Object.setPrototypeOf`
- **Reflection API bypasses**: `Reflect.get`, `Reflect.construct`
- **Global object access**: members of `window`, `globalThis`, `self` and `global`, and `this` in any position

The analysis of each CVE and the list of attack vectors these rules are tested against are kept with the security tests, which are not public; [SECURITY-TESTS.md](https://github.com/agentfront/enclave/blob/main/SECURITY-TESTS.md) lists the categories and the invariants they protect.

### What a Preset Is, and What It Is Not

The STRICT, SECURE, STANDARD and PERMISSIVE presets are **filters on source text**: each one refuses the constructs it lists, in the spellings a parser can see. A filter is not a security boundary. A script can build a property name while it runs, reach an object through a value instead of a name, or use a construct no rule of the preset lists, and a static rule cannot see that (see [Known Limitations](#known-limitations)). Passing one of these presets does not make code safe to run.

To run code you do not trust, put the validator in front of a runtime sandbox: [`@enclave-vm/core`](https://github.com/agentfront/enclave/tree/main/libs/core) validates with the AgentScript preset (an allowlist of syntax, names and property keys, not a list of refusals) and then runs the script in a realm that holds nothing else, behind a membrane, with limits. There, a gap in a static rule is not a way out.

## Features

- **Production-Ready**: Comprehensive error handling, type-safe APIs, and battle-tested rules
- **Extensible**: Plugin architecture with custom rule support
- **Type-Safe**: Full TypeScript support with strict typing
- **Zero Dependencies**: Lightweight with only `acorn` and `acorn-walk` as dependencies
- **Comprehensive Rules**: Built-in rules for common validation scenarios
- **Security-Focused**: Rules to prevent dangerous code patterns
- **Performance**: Fast validation with configurable limits
- **Detailed Reporting**: Rich error messages with source locations

## Installation

```bash
npm install @enclave-vm/ast
# or
yarn add @enclave-vm/ast
# or
pnpm add @enclave-vm/ast
```

## Quick Start

```typescript
import { JSAstValidator, DisallowedIdentifierRule, NoEvalRule } from '@enclave-vm/ast';

// Create validator with built-in rules
const validator = new JSAstValidator([
  new DisallowedIdentifierRule({ disallowed: ['eval', 'Function'] }),
  new NoEvalRule(),
]);

// Validate code
const result = await validator.validate(`
  const x = 1;
  eval("alert('hello')");
`);

if (!result.valid) {
  console.log('Validation failed:');
  result.issues.forEach((issue) => {
    console.log(`- [${issue.severity}] ${issue.message} (${issue.code})`);
    if (issue.location) {
      console.log(`  at line ${issue.location.line}, column ${issue.location.column}`);
    }
  });
}
```

## Presets

AST Guard provides pre-configured security presets for quick and easy setup. Choose from five security levels, from maximum lockdown to minimal restrictions. They decide which source a host accepts; they do not contain the code that is accepted (see [What a Preset Is, and What It Is Not](#what-a-preset-is-and-what-it-is-not)).

### Available Presets

| Preset         | Security Level | Description                                          | Use Case                            |
| -------------- | -------------- | ---------------------------------------------------- | ----------------------------------- |
| **STRICT**     | Maximum        | Blocks all dangerous patterns, loops, and async      | Untrusted code execution            |
| **SECURE**     | High           | Blocks most dangerous patterns, allows bounded loops | Semi-trusted code with restrictions |
| **STANDARD**   | Medium         | Sensible defaults, blocks critical risks only        | Trusted code with safety checks     |
| **PERMISSIVE** | Low            | Minimal restrictions, only blocks eval               | Internal scripts                    |

### Quick Start with Presets

```typescript
import { JSAstValidator, Presets, PresetLevel } from '@enclave-vm/ast';

// Option 1: Use the Presets object
const lockdownRules = Presets.strict();
const validator = new JSAstValidator(lockdownRules);

// Option 2: Use createPreset with level
import { createPreset } from '@enclave-vm/ast';
const securedRules = createPreset(PresetLevel.SECURE);
const validator = new JSAstValidator(securedRules);

// Option 3: Use individual preset function
import { createStandardPreset } from '@enclave-vm/ast';
const balancedRules = createStandardPreset();
const validator = new JSAstValidator(balancedRules);
```

### Preset Details

#### STRICT Preset

**Maximum security for untrusted code. Bank-grade protection.**

Includes all security rules to block known sandbox escape exploits:

- ✅ NoEvalRule - Blocks eval() and Function constructor
- ✅ NoGlobalAccessRule - Blocks constructor chains, Reflect API, members of the global objects, and `this` in any position
- ✅ NoAsyncRule - Blocks async/await patterns
- ✅ DisallowedIdentifierRule - Blocks dangerous identifiers
- ✅ ForbiddenLoopRule - Blocks loops (or optionally allow bounded loops)
- ✅ And more...

```typescript
import { Presets } from '@enclave-vm/ast';

// Maximum lockdown
const rules = Presets.strict();

// With customization
const rules = Presets.strict({
  // Allow specific loops
  allowedLoops: { allowFor: true, allowForOf: true },

  // Require specific API calls
  requiredFunctions: ['callTool'],
  minFunctionCalls: 1,
  maxFunctionCalls: 10,

  // Validate function arguments
  functionArgumentRules: {
    callTool: {
      minArgs: 2,
      expectedTypes: ['string', 'object'],
    },
  },

  // Add custom blocked identifiers
  additionalDisallowedIdentifiers: ['window', 'document'],
});
```

**Blocks:**

- All eval-like constructs (`eval`, `Function`, `setTimeout` with strings)
- All loops (for, while, do-while, for-in, for-of)
- All async/await
- Dangerous identifiers: `process`, `require`, `global`, `__dirname`, `constructor`, `__proto__`, etc.

#### SECURE Preset

High security with some flexibility for semi-trusted code.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.secure({
  requiredFunctions: ['callTool'],
  maxFunctionCalls: 20,
});
```

**Blocks:**

- All eval-like constructs
- Dangerous identifiers: `process`, `require`, `global`, `__dirname`
- Infinite loops (while, do-while)
- Async function declarations

**Allows:**

- Bounded for/for-of loops
- Await expressions (but not async functions)

#### STANDARD Preset

Medium security with sensible defaults for most use cases.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.standard({
  requiredFunctions: ['callTool'],
  additionalDisallowedIdentifiers: ['window', 'document'], // Browser-specific
});
```

**Blocks:**

- eval() and Function constructor
- Critical identifiers: `process`, `require`, `eval`, `Function`
- Infinite while/do-while loops

**Allows:**

- All for loops (for, for-in, for-of)
- Async/await
- Constructor and prototype access

#### PERMISSIVE Preset

Low security for internal or trusted scripts.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.permissive({
  requiredFunctions: ['callTool'], // Optional API enforcement
});
```

**Blocks:**

- eval() only

**Allows:**

- All loops
- Async/await
- All identifiers
- Constructor and prototype access

### Customizing Presets

All presets accept options to customize their behavior:

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.secure({
  // Add more blocked identifiers
  additionalDisallowedIdentifiers: ['window', 'document', 'localStorage'],

  // Require specific functions
  requiredFunctions: ['callTool', 'getTool'],
  minFunctionCalls: 1,
  maxFunctionCalls: 50,

  // Override default loop restrictions
  allowedLoops: {
    allowFor: true,
    allowWhile: true, // Override: allow while in the secure preset
    allowDoWhile: false,
    allowForIn: false,
    allowForOf: true,
  },

  // Override default async restrictions
  allowAsync: {
    allowAsyncFunctions: true, // Override: allow async in the secure preset
    allowAwait: true,
  },

  // Validate specific function arguments
  functionArgumentRules: {
    callTool: {
      minArgs: 2,
      maxArgs: 3,
      expectedTypes: ['string', 'object'],
      validator: (args) => {
        // Custom validation
        if (args[0]?.value === '') {
          return 'Tool name cannot be empty';
        }
        return null;
      },
    },
  },
});
```

### Real-World Examples

#### Example 1: Untrusted Code Sandbox

```typescript
import { JSAstValidator, Presets } from '@enclave-vm/ast';

// Maximum security for untrusted user code
const validator = new JSAstValidator(
  Presets.strict({
    requiredFunctions: ['callTool'],
    functionArgumentRules: {
      callTool: {
        minArgs: 2,
        expectedTypes: ['string', 'object'],
      },
    },
  }),
);

const userCode = `
  // User-submitted code
  callTool("getData", { id: 123 });
`;

const result = await validator.validate(userCode, {
  rules: {
    'no-eval': true,
    'disallowed-identifier': true,
    'forbidden-loop': true,
    'required-function-call': true,
    'call-argument-validation': true,
  },
});

if (result.valid) {
  // Accepted by the filter: run it in a sandbox that holds on its own
  executeInSandbox(userCode);
}
```

#### Example 2: Plugin System

```typescript
import { JSAstValidator, Presets } from '@enclave-vm/ast';

// Balanced security for plugin code
const validator = new JSAstValidator(
  Presets.standard({
    requiredFunctions: ['registerPlugin'],
    additionalDisallowedIdentifiers: ['process', 'require', 'fs'],
  }),
);

const pluginCode = await loadPluginCode();
const result = await validator.validate(pluginCode, {
  rules: {
    'no-eval': true,
    'disallowed-identifier': true,
    'required-function-call': true,
  },
});
```

#### Example 3: Internal Automation Scripts

```typescript
import { JSAstValidator, Presets } from '@enclave-vm/ast';

// Minimal security for trusted internal scripts
const validator = new JSAstValidator(
  Presets.permissive({
    requiredFunctions: ['execute'],
  }),
);
```

### Preset Comparison Matrix

| Feature              | STRICT | SECURE | STANDARD | PERMISSIVE |
| -------------------- | ------ | ------ | -------- | ---------- |
| **eval()**           | ❌     | ❌     | ❌       | ❌         |
| **Function()**       | ❌     | ❌     | ❌       | ✅         |
| **for loops**        | ❌     | ✅     | ✅       | ✅         |
| **while loops**      | ❌     | ❌     | ❌       | ✅         |
| **async/await**      | ❌     | ⚠️     | ✅       | ✅         |
| **process**          | ❌     | ❌     | ❌       | ✅         |
| **require**          | ❌     | ❌     | ❌       | ✅         |
| **global**           | ❌     | ❌     | ✅       | ✅         |
| **constructor**      | ❌     | ✅     | ✅       | ✅         |
| **Unreachable code** | ⚠️     | ⚠️     | ⚠️       | ⚠️         |

Legend: ❌ Blocked (error) | ⚠️ Detected (warning) | ✅ Allowed

### AgentScript Globals by Security Level

The AgentScript preset uses security-level-aware globals for defense-in-depth:

| Global                                     | STRICT | SECURE | STANDARD | PERMISSIVE |
| ------------------------------------------ | ------ | ------ | -------- | ---------- |
| **Core API**                               |        |        |          |            |
| `callTool`                                 | ✅     | ✅     | ✅       | ✅         |
| **Data Types**                             |        |        |          |            |
| `Math`, `JSON`, `Array`                    | ✅     | ✅     | ✅       | ✅         |
| `Object`, `String`, `Number`, `Date`       | ✅     | ✅     | ✅       | ✅         |
| **Constants**                              |        |        |          |            |
| `undefined`, `NaN`, `Infinity`             | ✅     | ✅     | ✅       | ✅         |
| **Utility Functions**                      |        |        |          |            |
| `parseInt`, `parseFloat`                   | ❌     | ✅     | ✅       | ✅         |
| `isNaN`, `isFinite`                        | ❌     | ✅     | ✅       | ✅         |
| `encodeURI`, `decodeURI`                   | ❌     | ✅     | ✅       | ✅         |
| `encodeURIComponent`, `decodeURIComponent` | ❌     | ✅     | ✅       | ✅         |
| **Debugging**                              |        |        |          |            |
| `console`                                  | ❌     | ❌     | ❌       | ✅         |

**Always Blocked:** `eval`, `Function`, `process`, `require`, `window`, `globalThis`, `constructor`, `__proto__`, `Proxy`, `Reflect`, `Promise`, `setTimeout`, `fetch`, `WebSocket`, `Map`, `Set`, `Symbol`, `RegExp`, and 50+ other dangerous globals. The full list is exported (frozen) as `AGENTSCRIPT_DISALLOWED_IDENTIFIERS`.

### Tool Namespaces

`normalizeToolNamespaces(spec, { reservedNames })` validates the `toolNamespaces` option of `@enclave-vm/core`
and `@enclave-vm/browser` (`{ mail: ['list', 'send'] }` or `{ users: { get: 'users:get' } }`) and returns it as
plain data, so every runtime refuses the same names: non-identifiers, prototype keys, names starting with `__`,
names the language calls on an object by itself (`then`, `toString`, `valueOf`, `toLocaleString`, `toJSON`),
reserved words and sandbox globals as namespaces, identifiers AgentScript refuses (as namespaces or method
names), collisions with `reservedNames`, duplicated methods, and tool names that are empty, oversized or not
valid tool names (`TOOL_NAMESPACE_TOOL_NAME_PATTERN`: letters, digits, `:`, `.`, `_` and `-`, starting with a
letter, as the `worker_threads` and iframe protocols require; this also applies to the generated
`<namespace>.<method>` names, so `_util` or `$db` need explicit tool names). It throws a `TypeError` whose
message starts with `Invalid toolNamespaces:`.

### AgentScript Preset

The AgentScript preset is specifically designed for safe AI agent orchestration. It provides security rules tailored for executing LLM-generated code that calls tools via `callTool()`.

```typescript
import { JSAstValidator, createAgentScriptPreset } from '@enclave-vm/ast';

// Basic usage - secure defaults for AgentScript
const rules = createAgentScriptPreset();
const validator = new JSAstValidator(rules);

// With requireCallTool - enforce that code must call tools
const rules = createAgentScriptPreset({
  requireCallTool: true, // Require at least one callTool() invocation
});
```

**Options:**

| Option                            | Type       | Default                    | Description                                                    |
| --------------------------------- | ---------- | -------------------------- | -------------------------------------------------------------- |
| `securityLevel`                   | `string`   | `'STANDARD'`               | Security level: `STRICT`, `SECURE`, `STANDARD`, `PERMISSIVE`   |
| `requireCallTool`                 | `boolean`  | `false`                    | Require at least one `callTool()` invocation in the code       |
| `allowedGlobals`                  | `string[]` | (based on securityLevel)   | Override allowed globals (takes precedence over securityLevel) |
| `additionalDisallowedIdentifiers` | `string[]` | `[]`                       | Additional identifiers to block beyond the default set         |
| `allowArrowFunctions`             | `boolean`  | `true`                     | Whether to allow arrow functions (for array methods)           |
| `allowedLoops`                    | `object`   | `{ allowFor, allowForOf }` | Override default loop restrictions                             |
| `reservedPrefixes`                | `string[]` | `[]`                       | Prefixes to reserve in addition to `__ag_` and `__safe_`       |
| `staticCallTarget`                | `object`   | `{ enabled: true }`        | Configuration for static call target validation                |
| `callToolValidation`              | `object`   | -                          | Validation rules for callTool arguments                        |
| `hostObjectGlobals`               | `string[]` | `[]`                       | Globals that are host objects (tool namespaces), not strings   |
| `requireDirectRegexMethodCalls`   | `boolean`  | `false`                    | Refuse `match` / `matchAll` / `search` as anything but a call  |
| `additionalAllowedSyntax`         | `string[]` | `[]`                       | Node types (or variants of one) to allow beyond the allowlist  |

`requireDirectRegexMethodCalls` is for a host where the validator is the only thing between a script and the
regular-expression engine. A direct call of `match`, `matchAll` or `search` is always checked, and `.call`,
`.apply`, `.bind` and a template tag on them are always refused; with the option, the method cannot be read as a
value or taken by destructuring either. That also refuses reading a field of ordinary data with one of these
names (`params.search`), so it is off by default: `@enclave-vm/core` by default runs scripts in a realm where
regular expressions cannot run whatever a script does.

**Example with all options:**

```typescript
const rules = createAgentScriptPreset({
  // Require the code to actually call tools
  requireCallTool: true,

  // Customize allowed globals
  allowedGlobals: ['callTool', 'getTool', 'Math', 'JSON', 'Array', 'Object'],

  // Block additional identifiers
  additionalDisallowedIdentifiers: ['fetch', 'XMLHttpRequest'],

  // Allow arrow functions for array methods (default: true)
  allowArrowFunctions: true,

  // Allow specific loops (default: for and for-of allowed)
  allowedLoops: {
    allowFor: true,
    allowForOf: true,
    allowWhile: false, // Block while loops
    allowDoWhile: false, // Block do-while loops
    allowForIn: false, // Block for-in loops
  },

  // Static call target validation
  staticCallTarget: {
    enabled: true,
    allowedToolNames: ['users:list', 'users:get'], // Optional whitelist
  },
});
```

The AgentScript preset is used internally by `@enclave-vm/core` for secure code execution.

**Syntax allowlist.** The preset refuses every syntax node that is not on its allowlist (`AllowedSyntaxRule`, `AGENTSCRIPT_ALLOWED_NODE_TYPES`): `this`, classes, `new.target`, `import.meta`, `debugger`, `with`, `yield` and dynamic `import()` among them. Four constructs share their node type with an allowed one and are constructs of their own: `using` and `await using` declarations, `for await` loops and generator functions. They are refused, and `additionalAllowedSyntax` allows one only when it is listed under its own name: `UsingDeclaration`, `AwaitUsingDeclaration`, `ForAwaitStatement`, `GeneratorFunction`. The one function declaration a script may hold is the wrapper: `allowedFunctionNames` of `NoUserDefinedFunctionsRule` allows the first top-level declaration with the wrapper's shape (`async function __ag_main() { ... }`, no parameters) and no other, whatever its name.

**`Object` is used directly.** The preset sets `requireDirectObjectUse` on `NoGlobalAccessRule`: the global `Object` may appear as `Object.name` with a name written in the source, as a call, a construction, or the operand of `typeof` / `instanceof`. An alias (`const O = Object`), passing or storing it, destructuring from it, a member name computed at run time and `Object.valueOf()` are refused with `OBJECT_INDIRECT_USE`. A reflection static of `Object` (`getPrototypeOf`, `defineProperty`, ...) is refused wherever it is read.

**Reserved names.** `__ag_` and `__safe_` are always reserved; `reservedPrefixes` adds to them. `__maxIterations`, the runtime's name for the iteration limit, is reserved as well.

## Built-in Rules

### DisallowedIdentifierRule

Prevents usage of specific identifiers (e.g., `eval`, `Function`, `process`).

```typescript
import { DisallowedIdentifierRule } from '@enclave-vm/ast';

const rule = new DisallowedIdentifierRule({
  disallowed: ['eval', 'Function', 'process', 'require'],
  messageTemplate: 'Access to "{identifier}" is forbidden',
});
```

### ForbiddenLoopRule

Prevents usage of loop constructs. Configurable to allow specific loop types.

```typescript
import { ForbiddenLoopRule } from '@enclave-vm/ast';

const rule = new ForbiddenLoopRule({
  allowFor: false,
  allowWhile: false,
  allowDoWhile: false,
  allowForOf: true, // Allow for-of loops
  allowForIn: false,
  message: 'Loops are not allowed in this context',
});
```

### RequiredFunctionCallRule

Ensures specific functions are called at least once.

```typescript
import { RequiredFunctionCallRule } from '@enclave-vm/ast';

const rule = new RequiredFunctionCallRule({
  required: ['callTool'],
  minCalls: 1,
  maxCalls: 10,
  messageTemplate: 'Must call {function} at least once',
});
```

**Mode Options:**

- `mode: 'all'` (default) - All functions in `required` must be called
- `mode: 'any'` - At least one function from `required` must be called

```typescript
// Require either callTool or invokeAPI to be called
const rule = new RequiredFunctionCallRule({
  required: ['callTool', 'invokeAPI'],
  mode: 'any',
  minCalls: 1,
});
```

### UnreachableCodeRule

Detects unreachable code (code after return/throw/break/continue).

```typescript
import { UnreachableCodeRule } from '@enclave-vm/ast';

const rule = new UnreachableCodeRule();
// Automatically detects unreachable code
```

### CallArgumentValidationRule

Validates function call arguments (count and types).

```typescript
import { CallArgumentValidationRule } from '@enclave-vm/ast';

const rule = new CallArgumentValidationRule({
  functions: {
    callTool: {
      minArgs: 2,
      maxArgs: 2,
      expectedTypes: ['string', 'object'],
    },
    getTool: {
      minArgs: 1,
      maxArgs: 1,
      expectedTypes: ['string'],
      validator: (args, node) => {
        // Custom validation logic
        const firstArg = args[0];
        if (firstArg.type === 'Literal' && firstArg.value === '') {
          return 'Tool name cannot be empty';
        }
        return null; // Valid
      },
    },
  },
});
```

### NoEvalRule

Prevents usage of `eval()`, `Function()` constructor, and string-based `setTimeout`/`setInterval`.

```typescript
import { NoEvalRule } from '@enclave-vm/ast';

const rule = new NoEvalRule();
// Blocks: eval(), new Function(), setTimeout("code", ...)
```

### NoAsyncRule

Prevents usage of async/await constructs.

```typescript
import { NoAsyncRule } from '@enclave-vm/ast';

const rule = new NoAsyncRule({
  allowAsyncFunctions: false,
  allowAwait: false,
  message: 'Async code is not supported',
});
```

## Custom Rules

Create your own validation rules by implementing the `ValidationRule` interface:

```typescript
import { ValidationRule, ValidationContext, ValidationSeverity } from '@enclave-vm/ast';
import * as walk from 'acorn-walk';

class NoConsoleRule implements ValidationRule {
  readonly name = 'no-console';
  readonly description = 'Prevents usage of console methods';
  readonly defaultSeverity = ValidationSeverity.WARNING;
  readonly enabledByDefault = true;

  validate(context: ValidationContext): void {
    walk.simple(context.ast as any, {
      MemberExpression: (node: any) => {
        if (node.object.type === 'Identifier' && node.object.name === 'console') {
          context.report({
            code: 'NO_CONSOLE',
            message: 'Console usage is not recommended',
            location: node.loc
              ? {
                  line: node.loc.start.line,
                  column: node.loc.start.column,
                }
              : undefined,
          });
        }
      },
    });
  }
}

// Use your custom rule
const validator = new JSAstValidator([new NoConsoleRule()]);
```

## Configuration

### Validator Configuration

```typescript
const result = await validator.validate(code, {
  // Parse options (passed to acorn)
  parseOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script',
  },

  // Rule configuration
  rules: {
    'disallowed-identifier': true, // Enable with default options
    'no-eval': false, // Disable rule
    'required-function-call': {
      // Enable with custom options
      enabled: true,
      severity: ValidationSeverity.ERROR,
      options: { required: ['callTool'] },
    },
  },

  // Stop on first error
  stopOnFirstError: false,

  // Maximum number of issues to collect (default: 100, 0 = unlimited)
  maxIssues: 100,
});
```

`maxIssues` bounds what one validation builds from a source the host did not write. It defaults to
`DEFAULT_MAX_ISSUES` (100); pass `0` to collect every issue. At the cap the validation stops as soon as an
error is on the list. While only warnings were found the remaining rules still run, because one of them may
refuse the source, and further warnings are not collected. A result that was cut short has
`incomplete: true`, and `valid` is `true` only when every rule ran and none reported an error.
An `UNKNOWN_GLOBAL` issue states the list of allowed globals once per validation, in the first
such issue; the following ones name the identifier only.

`validate()` runs the pre-scanner before it parses, with the `standard` pre-scanner preset unless
`preScan: { preset }` selects another one (see [Pre-Scanner](#pre-scanner)).

### Rule Management

```typescript
const validator = new JSAstValidator();

// Register rules
validator.registerRule(new DisallowedIdentifierRule({ disallowed: ['eval'] }));
validator.registerRule(new NoEvalRule());

// Get all rules
const rules = validator.getRules();

// Get specific rule
const rule = validator.getRule('no-eval');

// Unregister rule
validator.unregisterRule('no-eval');
```

## Validation Results

```typescript
interface ValidationResult {
  valid: boolean; // true if every rule ran and none reported an error
  issues: ValidationIssue[]; // The issues found, at most maxIssues
  incomplete?: boolean; // true if the list was cut at maxIssues or the validation stopped early
  rulesExecuted?: number; // Rules that were started
  ast?: acorn.Node; // Parsed AST (if parsing succeeded)
  parseError?: Error; // Parse error (if parsing failed)
}

interface ValidationIssue {
  code: string; // Unique issue code
  severity: ValidationSeverity; // ERROR | WARNING | INFO
  message: string; // Human-readable message
  location?: SourceLocation; // Source location
  data?: Record<string, unknown>; // Additional context
}
```

## Error Handling

All errors extend `AstGuardError` with specific error types. `validate()` throws `InvalidSourceError` for a source that is not a string or is empty; a parse error is not thrown but returned as `result.parseError`, with a `PARSE_ERROR` issue:

```typescript
import {
  AstGuardError,
  ParseError,
  RuleConfigurationError,
  ConfigurationError,
  RuleNotFoundError,
  InvalidSourceError,
} from '@enclave-vm/ast';

try {
  const result = await validator.validate(code);
  if (result.parseError instanceof ParseError) {
    console.error(`Parse error at line ${result.parseError.line}:`, result.parseError.message);
  }
} catch (error) {
  if (error instanceof InvalidSourceError) {
    console.error('Invalid source:', error.message);
  } else if (error instanceof RuleConfigurationError) {
    console.error(`Rule ${error.ruleName} misconfigured:`, error.message);
  }
}
```

## Statistics

```typescript
const result = await validator.validate(code);
const stats = validator.getStats(result, Date.now() - startTime);

console.log(`Total issues: ${stats.totalIssues}`);
console.log(`Errors: ${stats.errors}`);
console.log(`Warnings: ${stats.warnings}`);
console.log(`Duration: ${stats.durationMs}ms`);
```

## Use Cases

### 1. Sandboxed Code Execution

Validate code before executing in a sandboxed environment:

```typescript
const validator = new JSAstValidator([
  new DisallowedIdentifierRule({ disallowed: ['eval', 'Function', 'process'] }),
  new NoEvalRule(),
  new ForbiddenLoopRule(), // Prevent infinite loops
  new RequiredFunctionCallRule({ required: ['callTool'] }),
]);

const result = await validator.validate(userCode);
if (result.valid) {
  // Accepted by the filter. `node:vm` alone is not a security boundary: for code you do not
  // trust, run it with @enclave-vm/core.
  vm.runInContext(userCode, sandbox);
}
```

### 2. API Contract Validation

Ensure code follows API contracts:

```typescript
const validator = new JSAstValidator([
  new RequiredFunctionCallRule({ required: ['callTool'] }),
  new CallArgumentValidationRule({
    functions: {
      callTool: {
        minArgs: 2,
        expectedTypes: ['string', 'object'],
      },
    },
  }),
]);
```

### 3. Security Analysis

Detect potentially dangerous code patterns:

```typescript
const validator = new JSAstValidator([
  new NoEvalRule(),
  new DisallowedIdentifierRule({
    disallowed: ['eval', 'Function', 'require', 'process', 'child_process'],
  }),
]);
```

### 4. Code Quality Checks

Detect code quality issues:

```typescript
const validator = new JSAstValidator([
  new UnreachableCodeRule(),
  // Add custom rules for your quality standards
]);
```

## Testing

```bash
# Run tests
npx nx test ast
```

## Performance

- **Parse time**: ~1-5ms for typical scripts (depends on size)
- **Validation time**: ~1-10ms per rule (depends on complexity)
- **Memory**: Minimal overhead, AST is shared across rules

## ReDoS Analysis Without the Parser

To check regular expressions for catastrophic backtracking without validating JavaScript, import the analyzer from `@enclave-vm/ast/redos`. It loads none of the parser (`acorn`, `acorn-walk`, `astring`) that the package root loads: about 8 KB instead of 240 KB plus the parser.

```ts
import { analyzeForReDoS, REDOS_THRESHOLDS } from '@enclave-vm/ast/redos';

const { score } = analyzeForReDoS('(a+)+$', 'catastrophic');
if (score >= REDOS_THRESHOLDS.BLOCK) throw new Error('Pattern can backtrack catastrophically');
```

It also exports `REDOS_PATTERNS`, `calculateStarHeight` and the `ReDoSAnalysisResult` type, the same as the package root.

## Pre-Scanner

The pre-scanner checks the source text before it is parsed: size, line and string limits, nesting depth, and, depending on the preset, regular-expression literals and Unicode characters. `JSAstValidator.validate()` runs it first, with the `standard` preset unless the `preScan` option selects another:

```typescript
const result = await validator.validate(code, {
  preScan: { preset: 'agentscript' }, // default: 'standard'; { enabled: false } switches it off
});
```

Used on its own, `PreScanner` takes `{ preset, config }`:

```typescript
import { PreScanner } from '@enclave-vm/ast';

const scanner = new PreScanner({ preset: 'agentscript' }); // or PreScanner.forAgentScript()
const scan = scanner.scan(code);
if (!scan.success) {
  console.error(scan.fatalIssue?.code, scan.fatalIssue?.message);
}

// Overrides go in `config`, on top of a preset
const custom = new PreScanner({ preset: 'secure', config: { maxInputSize: 200 * 1024 } });
```

Without a `preset` the scanner uses `standard`. A configuration object passed in the place of the options, as in `new PreScanner(createPreScannerConfig('agentscript'))`, has no `preset` key and therefore builds the `standard` preset as well.

| Check                            | `agentscript` | `strict` | `secure` | `standard` | `permissive` |
| -------------------------------- | ------------- | -------- | -------- | ---------- | ------------ |
| Input size                       | 100KB         | 500KB    | 1MB      | 5MB        | 10MB         |
| Nesting depth                    | 20            | 30       | 40       | 50         | 100          |
| Regex literals                   | refused       | analyzed | analyzed | analyzed   | allowed      |
| Bidirectional control characters | refused       | refused  | refused  | allowed    | allowed      |
| Invisible characters             | refused       | refused  | allowed  | allowed    | allowed      |
| Look-alike letters               | refused       | refused  | refused  | refused    | allowed      |

`Enclave` (`@enclave-vm/core`) and `BrowserEnclave` (`@enclave-vm/browser`) run the pre-scanner themselves, on the script as it was written and before anything parses it, with the pre-scanner preset named like their AST preset: `agentscript` by default (the `babel` preset of the core enclave runs with `standard`). Their `preScan` option picks another preset or changes single limits. They then validate the transformed script with the validator's own pre-scan switched off.

## AgentScript Transformer and Transforms

`transformAgentScript(code, config)` wraps a script in `async function __ag_main()`, renames `callTool` to `__safe_callTool` and guards its loops with an iteration counter.

```typescript
import { transformAgentScript } from '@enclave-vm/ast';

const transformed = transformAgentScript(code, {
  maxIterations: 10000, // Written into each loop check as a number
  additionalIdentifiers: ['context'], // Custom globals keep their name
});
```

With `maxIterations` the limit is a number in each loop's own check. Without it the check compares with the runtime's `__maxIterations`, and a script that uses that name is refused. A loop counter never has a name the script mentions.

The transforms `@enclave-vm/core` applies after validation are exported as well:

- `transformConcatenation(ast, options)` rewrites `a + b` to `__safe_concat(a, b)`. `compoundAssignment` (default `true`) rewrites `x += y` the same way, so that it is charged like `x + y`; `arraySpread` (default `false`) wraps array literals that contain a spread, for a runtime that defines the helpers for it.
- `rewriteImports(code, config)` rewrites imports of npm packages to CDN URLs. The package allowlist applies to import declarations, re-exports and dynamic `import()` alike: a dynamic import of a listed package is rewritten, one of another package is refused, and a specifier computed at run time is refused. Versions with path or URL characters, and a base URL with credentials, a query or a fragment, are refused.
- The validator's `transform` option with `transformComputed` prints a computed key it rewrites as one string literal, whatever characters the key holds.

`UnicodeSecurityRule` reports the tag characters (U+E0000 to U+E007F) as invisible characters. No preset includes this rule.

## Comparison

| Feature                | AST Guard      | ESLint       | TypeScript    |
| ---------------------- | -------------- | ------------ | ------------- |
| **Focus**              | AST validation | Code linting | Type checking |
| **Extensible**         | ✅             | ✅           | ⚠️            |
| **Lightweight**        | ✅             | ❌           | ❌            |
| **Type-safe**          | ✅             | ⚠️           | ✅            |
| **Security rules**     | ✅             | ⚠️           | ❌            |
| **Runtime validation** | ✅             | ❌           | ❌            |

## Defense-in-Depth Architecture

AST Guard is the first two of four layers. The other two are the runtime's (`@enclave-vm/core`):

```text
Layer 1: AST Validation
├── NoEvalRule - Blocks eval(), Function()
├── NoGlobalAccessRule - Blocks window, globalThis, .constructor
├── NoAsyncRule - Blocks async/await (optional)
├── DisallowedIdentifierRule - Blocks dangerous identifiers
└── ForbiddenLoopRule - Blocks/transforms loops

Layer 2: AST Transformation
├── Direct identifiers: console → __safe_console
├── Computed access: obj['eval'] → obj['__safe_eval']
└── Static string literals transformed

Layer 3: Runtime Proxy Layer
├── __safe_callTool() - Validates tool calls
├── __safe_console() - Captures logs
└── All proxied functions enforce security

Layer 4: Runtime Sandbox (@enclave-vm/core)
├── Double VM: a realm that holds only the allowed globals
├── Membrane and limits around every value and call
└── Optional worker pool: a heap limit per worker and a hard stop
```

### Known Limitations

These are inherent to **any** static analyzer (not vulnerabilities):

| Limitation                   | Example              | Mitigation                        |
| ---------------------------- | -------------------- | --------------------------------- |
| Computed property access     | `obj['constructor']` | `Object.freeze(Object.prototype)` |
| Runtime string construction  | `'con' + 'structor'` | VM isolation                      |
| Destructuring property names | `{ constructor: c }` | Freeze prototypes                 |
| A global under another name  | `const w = window`   | Remove the global from the realm  |

They are why a preset is a filter and not a boundary: what a script does with a value at run time is decided where it runs.

## Documentation

| Document                                                     | Purpose                                      |
| ------------------------------------------------------------ | -------------------------------------------- |
| [docs/AGENTSCRIPT.md](./docs/AGENTSCRIPT.md)                 | AgentScript language reference for AI agents |
| [docs/LOOP-TRANSFORMATION.md](./docs/LOOP-TRANSFORMATION.md) | Future loop transformation design            |

## Roadmap

- [x] Core validator architecture
- [x] Built-in security rules
- [x] Argument validation
- [x] Unreachable code detection
- [x] Comprehensive test suite (613 tests)
- [x] CVE protection (vm2, isolated-vm, node-vm)
- [ ] Loop transformation (design complete)
- [ ] CLI tool
- [ ] VS Code extension

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## License

Apache-2.0

## Credits

Built with:

- [acorn](https://github.com/acornjs/acorn) - JavaScript parser
- [acorn-walk](https://github.com/acornjs/acorn) - AST walker
- Part of the [FrontMCP](https://github.com/agentfront/frontmcp) ecosystem
