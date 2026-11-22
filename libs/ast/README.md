# @enclave-vm/ast

A static validator for JavaScript source: it parses a script with [acorn](https://github.com/acornjs/acorn), runs a set of rules over the syntax tree and reports what they refuse. It is the static layer of [Enclave](https://github.com/agentfront/enclave), for hosts that accept scripts written by people or language models.

[![npm version](https://img.shields.io/npm/v/@enclave-vm/ast.svg)](https://www.npmjs.com/package/@enclave-vm/ast)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agentfront/enclave/blob/main/LICENSE)

The package contains:

- `JSAstValidator` and the built-in rules, which you can combine yourself or take from a preset;
- the presets: STRICT, SECURE, STANDARD and PERMISSIVE, and the AgentScript preset that [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core) and [`@enclave-vm/browser`](https://www.npmjs.com/package/@enclave-vm/browser) use;
- the pre-scanner, which checks the source text before it is parsed;
- the AgentScript transformer and the transforms the runtime applies after validation;
- a ReDoS analyzer for regular expressions, also available without the parser (`@enclave-vm/ast/redos`).

## What a Preset Is, and What It Is Not

The STRICT, SECURE, STANDARD and PERMISSIVE presets are **filters on source text**: each one refuses the constructs it lists, in the spellings a parser can see. A filter is not a security boundary. A script can build a property name while it runs, reach an object through a value instead of a name, or use a construct no rule of the preset lists, and a static rule cannot see that (see [Known Limitations](#known-limitations)). Passing one of these presets does not make code safe to run.

To run code you do not trust, put the validator in front of a runtime sandbox: [`@enclave-vm/core`](https://github.com/agentfront/enclave/tree/main/libs/core) validates with the AgentScript preset (an allowlist of syntax, names and property keys, not a list of refusals) and then runs the script in a realm that holds nothing else, behind a membrane, with limits. There, a gap in a static rule is not a way out. See [How This Package Fits With the Runtime](#how-this-package-fits-with-the-runtime).

## Installation

```bash
npm install @enclave-vm/ast
```

The package ships CommonJS and ES module builds with TypeScript declarations. Its dependencies are `acorn`, `acorn-walk`, `astring` and `@types/estree`.

## Quick Start

```typescript
import { JSAstValidator, DisallowedIdentifierRule, NoEvalRule } from '@enclave-vm/ast';

const validator = new JSAstValidator([
  new DisallowedIdentifierRule({ disallowed: ['eval', 'Function'] }),
  new NoEvalRule(),
]);

const result = await validator.validate(`
  const x = 1;
  eval("alert('hello')");
`);

if (!result.valid) {
  for (const issue of result.issues) {
    console.log(`- [${issue.severity}] ${issue.message} (${issue.code})`);
    if (issue.location) {
      console.log(`  at line ${issue.location.line}, column ${issue.location.column}`);
    }
  }
}
// - [error] ... (DISALLOWED_IDENTIFIER)
// - [error] Use of eval() is not allowed (NO_EVAL)
```

`validate()` is asynchronous and never throws for a script that fails to parse: the parse error is returned as `result.parseError` with a `PARSE_ERROR` issue (see [Error Handling](#error-handling)).

## Presets

A preset is an array of configured rules that you pass to `JSAstValidator`. They decide which source a host accepts; they do not contain the code that is accepted (see [What a Preset Is, and What It Is Not](#what-a-preset-is-and-what-it-is-not)).

| Preset          | What it refuses                                                                                               | Typical use                         |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **STRICT**      | The longest list of identifiers (including most built-in globals), all loops, all async code                  | The most restrictive filter         |
| **SECURE**      | Dangerous identifiers and reflection property names; `while` / `do-while` and `for-in`; async functions       | Semi-trusted code with restrictions |
| **STANDARD**    | `eval`, `Function`, `process`, `require`; `while` / `do-while`                                                | Trusted code with basic checks      |
| **PERMISSIVE**  | What `NoEvalRule` refuses (`eval`, `Function`, string timers, `with`, `import()`)                             | Internal scripts                    |
| **AgentScript** | Everything that is not on its allowlist of syntax and globals (see [AgentScript Preset](#agentscript-preset)) | Validation in front of a runtime    |

```typescript
import { JSAstValidator, Presets, PresetLevel, createPreset, createStandardPreset } from '@enclave-vm/ast';

// The Presets object
const strict = new JSAstValidator(Presets.strict());

// createPreset with a level
const secure = new JSAstValidator(createPreset(PresetLevel.SECURE));

// A preset function
const standard = new JSAstValidator(createStandardPreset());
```

### STRICT Preset

The most restrictive of the four presets. It refuses most built-in globals by name (`Object`, `Array`, `String`, `Number`, `JSON`, `Date`, `Promise`, `Map`, `Set`, the error constructors, the typed arrays, ...), so it suits short scripts that call the functions you require and little else.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.strict({
  // Allow specific loops
  allowedLoops: { allowFor: true, allowForOf: true },

  // Require specific API calls
  requiredFunctions: ['callTool'],
  minFunctionCalls: 1,
  maxFunctionCalls: 10,

  // Validate function arguments
  functionArgumentRules: {
    callTool: { minArgs: 2, expectedTypes: ['string', 'object'] },
  },

  // Add custom blocked identifiers
  additionalDisallowedIdentifiers: ['window', 'document'],
});
```

**Blocks:**

- All eval-like constructs (`eval`, `Function`, `setTimeout` with strings)
- All loops (for, while, do-while, for-in, for-of)
- All async/await
- Dangerous identifiers: `process`, `require`, `global`, `__dirname`, `constructor`, `__proto__`, etc., as a variable, as a member, as the key of a destructuring pattern, and in every spelling of a key that is made of constants (see [How a property key is read](#how-a-property-key-is-read))
- The property names that reach a prototype or a property descriptor without naming one (`__lookupGetter__`, `getPrototypeOf`, `defineProperty`, ...), on any object, and the `{ __proto__: x }` key of an object literal
- The structured stack trace API of the engine (`prepareStackTrace`, `getThis`, `getFunction`) and `caller`, which hand a script live objects of frames that are not its own

It also includes `NoGlobalAccessRule` (members of `window`, `globalThis`, `self` and `global`, `this` in any position, and the `constructor` property), `UnreachableCodeRule` (a warning), and the regular-expression rules: regex literals are analyzed for catastrophic backtracking (at most 100 characters), and the pattern a string argument of `match`, `matchAll` or `search` compiles to is analyzed as well.

### SECURE Preset

High security with some flexibility for semi-trusted code. `Object`, `Array`, `JSON` and the other data built-ins stay usable.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.secure({
  requiredFunctions: ['callTool'],
  maxFunctionCalls: 20,
});
```

**Blocks:**

- All eval-like constructs
- Dangerous identifiers: `process`, `require`, `global`, `__dirname`, `constructor`, `__proto__`, `prototype`, as a variable, as a member, as the key of a destructuring pattern, and in every spelling of a key that is made of constants (see [How a property key is read](#how-a-property-key-is-read))
- The property names that reach a prototype or a property descriptor (`__lookupGetter__`, `getPrototypeOf`, `getOwnPropertyDescriptor`, `defineProperty`, ...), on any object, and the `{ __proto__: x }` key of an object literal. The other functions of `Object` (`keys`, `entries`, `assign`, ...) stay usable.
- The structured stack trace API of the engine (`prepareStackTrace`, `getThis`, `getFunction`) and `caller`. `error.stack` and `error.message` stay usable.
- Infinite loops (while, do-while)
- Async function declarations

**Allows:**

- Bounded for/for-of loops
- Await expressions (but not async functions)

Regex literals are analyzed as in STRICT, with a limit of 200 characters.

### STANDARD Preset

Sensible defaults for trusted code.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.standard({
  requiredFunctions: ['callTool'],
  additionalDisallowedIdentifiers: ['window', 'document'], // Browser-specific
});
```

**Blocks:**

- What `NoEvalRule` refuses (see [NoEvalRule](#noevalrule))
- The identifiers `process`, `require`, `eval` and `Function`
- `while` and `do-while` loops

**Allows:**

- `for`, `for-in` and `for-of` loops
- Async functions and `await`
- Constructor and prototype access

### PERMISSIVE Preset

Minimal restrictions for internal or trusted scripts.

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.permissive({
  requiredFunctions: ['callTool'], // Optional API enforcement
});
```

**Blocks:**

- What `NoEvalRule` refuses: `eval()`, `Function()` and `new Function()`, string timers, `with` and dynamic `import()` (see [NoEvalRule](#noevalrule))
- The identifiers in `additionalDisallowedIdentifiers`, if you pass any

**Allows:**

- All loops
- Async/await
- All other identifiers
- Constructor and prototype access

### Customizing Presets

Every preset function takes the same `PresetOptions`:

| Option                            | Type                                                                  | Meaning                                                             |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `additionalDisallowedIdentifiers` | `string[]`                                                            | Identifiers to refuse in addition to the preset's own               |
| `requiredFunctions`               | `string[]`                                                            | Functions the script must call (adds `RequiredFunctionCallRule`)    |
| `minFunctionCalls`                | `number`                                                              | Minimum calls of the required functions (default `1`)               |
| `maxFunctionCalls`                | `number`                                                              | Maximum calls of the required functions                             |
| `functionArgumentRules`           | `Record<string, FunctionArgumentConfig>`                              | Argument checks per function (adds `CallArgumentValidationRule`)    |
| `allowedLoops`                    | `{ allowFor?, allowWhile?, allowDoWhile?, allowForIn?, allowForOf? }` | Override the preset's loop restrictions (STRICT, SECURE, STANDARD)  |
| `allowAsync`                      | `{ allowAsyncFunctions?, allowAwait? }`                               | Override the preset's async restrictions (STRICT, SECURE, STANDARD) |

```typescript
import { Presets } from '@enclave-vm/ast';

const rules = Presets.secure({
  additionalDisallowedIdentifiers: ['window', 'document', 'localStorage'],

  requiredFunctions: ['callTool', 'getTool'],
  minFunctionCalls: 1,
  maxFunctionCalls: 50,

  allowedLoops: {
    allowFor: true,
    allowWhile: true, // Override: allow while in the secure preset
    allowDoWhile: false,
    allowForIn: false,
    allowForOf: true,
  },

  allowAsync: {
    allowAsyncFunctions: true, // Override: allow async in the secure preset
    allowAwait: true,
  },

  functionArgumentRules: {
    callTool: {
      minArgs: 2,
      maxArgs: 3,
      expectedTypes: ['string', 'object'],
      validator: (args) => (args[0]?.type === 'Literal' && args[0].value === '' ? 'Tool name cannot be empty' : null),
    },
  },
});
```

### Preset Comparison

| Construct                         | STRICT   | SECURE   | STANDARD | PERMISSIVE |
| --------------------------------- | -------- | -------- | -------- | ---------- |
| `eval()`, `Function()`            | Refused  | Refused  | Refused  | Refused    |
| `for` / `for-of` loops            | Refused  | Allowed  | Allowed  | Allowed    |
| `for-in` loops                    | Refused  | Refused  | Allowed  | Allowed    |
| `while` / `do-while` loops        | Refused  | Refused  | Refused  | Allowed    |
| `async` functions                 | Refused  | Refused  | Allowed  | Allowed    |
| `await`                           | Refused  | See note | Allowed  | Allowed    |
| `process`, `require`              | Refused  | Refused  | Refused  | Allowed    |
| `global`, `globalThis`            | Refused  | Refused  | Allowed  | Allowed    |
| `constructor`, `prototype`        | Refused  | Refused  | Allowed  | Allowed    |
| `Object`, `Array`, `JSON`, `Date` | Refused  | Allowed  | Allowed  | Allowed    |
| Regex literals                    | Analyzed | Analyzed | Allowed  | Allowed    |
| Unreachable code                  | Warning  | Warning  | Warning  | Warning    |

The loop and async rows are the defaults; `allowedLoops` and `allowAsync` change them. By default the validator parses the source as a script, so `await` outside a function is a parse error, and `await` is valid only inside an `async` function. SECURE allows `await` but refuses `async` functions by default, so under SECURE with the default parse options a script can use `await` only when `allowAsync.allowAsyncFunctions` is enabled. With `parseOptions: { sourceType: 'module' }` (or acorn's `allowAwaitOutsideFunction`), `await` at the top level parses, and SECURE accepts it.

### AgentScript Preset

The AgentScript preset is the one `@enclave-vm/core` and `@enclave-vm/browser` validate with. It is an allowlist: a script calls tools with `callTool()`, works on data with the allowed globals and arrow functions, and uses bounded loops. Every other construct and every other global is refused.

```typescript
import { JSAstValidator, createAgentScriptPreset } from '@enclave-vm/ast';

const validator = new JSAstValidator(
  createAgentScriptPreset({
    securityLevel: 'SECURE',
    requireCallTool: true, // Require at least one callTool() invocation
  }),
);
```

| Option                            | Type                                     | Default                                | Description                                                                                      |
| --------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `securityLevel`                   | `string`                                 | `'STANDARD'`                           | `STRICT`, `SECURE`, `STANDARD` or `PERMISSIVE`: which globals are allowed (see below)            |
| `requireCallTool`                 | `boolean`                                | `false`                                | Require at least one `callTool()` invocation in the code                                         |
| `allowedGlobals`                  | `string[]`                               | (by `securityLevel`)                   | Replace the allowed globals; names listed here are also taken off the refused identifiers        |
| `additionalDisallowedIdentifiers` | `string[]`                               | `[]`                                   | Identifiers to refuse in addition; these win over `allowedGlobals`                               |
| `allowArrowFunctions`             | `boolean`                                | `true`                                 | Whether to allow arrow functions (for array methods)                                             |
| `allowedLoops`                    | `object`                                 | `{ allowFor: true, allowForOf: true }` | Override the loop restrictions (`while`, `do-while` and `for-in` are refused by default)         |
| `reservedPrefixes`                | `string[]`                               | `[]`                                   | Prefixes to reserve in addition to `__ag_` and `__safe_`                                         |
| `staticCallTarget`                | `{ enabled?, allowedToolNames? }`        | `{ enabled: true }`                    | The first argument of `callTool` must be a string literal; optionally an allowlist of tool names |
| `callToolValidation`              | `{ minArgs?, maxArgs?, expectedTypes? }` | -                                      | Validation rules for `callTool` arguments                                                        |
| `hostObjectGlobals`               | `string[]`                               | `[]`                                   | Globals that are host objects (tool namespaces), not strings                                     |
| `requireDirectRegexMethodCalls`   | `boolean`                                | `false`                                | Refuse `match` / `matchAll` / `search` as anything but a call                                    |
| `additionalAllowedSyntax`         | `string[]`                               | `[]`                                   | Node types (or variants of one) to allow beyond the allowlist                                    |
| `allowDynamicArrayFill`           | `boolean`                                | `false`                                | Allow `Array(n).fill()` with a size computed at run time, for a runtime that counts memory       |

`requireDirectRegexMethodCalls` is for a host where the validator is the only thing between a script and the regular-expression engine. A direct call of `match`, `matchAll` or `search` is always checked, and `.call`, `.apply`, `.bind` and a template tag on them are always refused; with the option, the method cannot be read as a value or taken by destructuring either. That also refuses reading a field of ordinary data with one of these names (`params.search`), so it is off by default: `@enclave-vm/core` by default runs scripts in a realm where regular expressions cannot run whatever a script does.

```typescript
const rules = createAgentScriptPreset({
  requireCallTool: true,
  allowedGlobals: ['callTool', 'getTool', 'Math', 'JSON', 'Array', 'Object'],
  additionalDisallowedIdentifiers: ['fetch', 'XMLHttpRequest'],
  allowArrowFunctions: true,
  allowedLoops: {
    allowFor: true,
    allowForOf: true,
    allowWhile: false,
    allowDoWhile: false,
    allowForIn: false,
  },
  staticCallTarget: {
    enabled: true,
    allowedToolNames: ['users:list', 'users:get'], // Optional allowlist
  },
});
```

**Syntax allowlist.** The preset refuses every syntax node that is not on its allowlist (`AllowedSyntaxRule`, `AGENTSCRIPT_ALLOWED_NODE_TYPES`): `this`, classes, `new.target`, `import.meta`, `debugger`, `with`, `yield` and dynamic `import()` among them. Four constructs share their node type with an allowed one and are constructs of their own: `using` and `await using` declarations, `for await` loops and generator functions. They are refused, and `additionalAllowedSyntax` allows one only when it is listed under its own name: `UsingDeclaration`, `AwaitUsingDeclaration`, `ForAwaitStatement`, `GeneratorFunction`. The one function declaration a script may hold is the wrapper: `allowedFunctionNames` of `NoUserDefinedFunctionsRule` allows the first top-level declaration with the wrapper's shape (`async function __ag_main() { ... }`, no parameters) and no other, whatever its name.

**`Object` is used directly.** The preset sets `requireDirectObjectUse` on `NoGlobalAccessRule`: the global `Object` may appear as `Object.name` with a name written in the source, as a call, a construction, or the operand of `typeof` / `instanceof`. An alias (`const O = Object`), passing or storing it, destructuring from it, a member name computed at run time and `Object.valueOf()` are refused with `OBJECT_INDIRECT_USE`. A reflection static of `Object` (`getPrototypeOf`, `defineProperty`, ...) is refused wherever it is read.

**Reserved names.** `__ag_` and `__safe_` are always reserved; `reservedPrefixes` adds to them. `__maxIterations`, the runtime's name for the iteration limit, is reserved as well.

**Other rules of the preset.** Regex literals and the regex methods of strings are refused, computed keys in destructuring patterns are refused, `JSON.stringify` and `JSON.parse` cannot take a callback, and two rules that are not exported on their own refuse obvious infinite loops (`InfiniteLoopRule`: `for (;;)`, `while (true)`, ...) and allocations beyond fixed sizes (`ResourceExhaustionRule`: `BigInt` exponents above 10,000, arrays above 1,000,000 elements, `fill` above 100,000, `repeat` above 100,000, and a `fill` of a size computed at run time unless `allowDynamicArrayFill` is set).

#### AgentScript Globals by Security Level

The AgentScript preset takes its allowed globals from the security level; `@enclave-vm/core` builds the script's realm from the same lists.

| Global                                     | STRICT | SECURE | STANDARD | PERMISSIVE |
| ------------------------------------------ | ------ | ------ | -------- | ---------- |
| `callTool`                                 | Yes    | Yes    | Yes      | Yes        |
| `Math`, `JSON`, `Array`                    | Yes    | Yes    | Yes      | Yes        |
| `Object`, `String`, `Number`, `Date`       | Yes    | Yes    | Yes      | Yes        |
| `undefined`, `NaN`, `Infinity`             | Yes    | Yes    | Yes      | Yes        |
| `parseInt`, `parseFloat`                   | No     | Yes    | Yes      | Yes        |
| `isNaN`, `isFinite`                        | No     | Yes    | Yes      | Yes        |
| `encodeURI`, `decodeURI`                   | No     | Yes    | Yes      | Yes        |
| `encodeURIComponent`, `decodeURIComponent` | No     | Yes    | Yes      | Yes        |
| `console`                                  | No     | No     | No       | Yes        |

The lists are exported as `AGENTSCRIPT_STRICT_GLOBALS`, `AGENTSCRIPT_SECURE_GLOBALS`, `AGENTSCRIPT_STANDARD_GLOBALS` and `AGENTSCRIPT_PERMISSIVE_GLOBALS`, and `getAgentScriptGlobals(level)` returns the one for a level.

**Refused at every level.** A global that is not on the list is refused as an unknown global (`UNKNOWN_GLOBAL`). On top of that, `AGENTSCRIPT_DISALLOWED_IDENTIFIERS` (exported, frozen) is refused by name, as a variable and as a property: `eval`, `Function`, `process`, `require`, `constructor`, `__proto__`, `prototype`, `Proxy`, `Reflect`, `Promise`, `Symbol`, `RegExp`, `setTimeout`, `fetch`, `WebSocket`, `Map`, `Set`, the error constructors and about 40 more. `NoGlobalAccessRule` refuses `window`, `globalThis`, `self`, `global` and `this`, and `AGENTSCRIPT_DISALLOWED_PROPERTIES` lists the reflection names refused as a property on any object.

#### Tool Namespaces

`normalizeToolNamespaces(spec, { reservedNames })` validates the `toolNamespaces` option of `@enclave-vm/core` and `@enclave-vm/browser` (`{ mail: ['list', 'send'] }` or `{ users: { get: 'users:get' } }`) and returns it as plain data, so every runtime refuses the same names: non-identifiers, prototype keys, names starting with `__`, names the language calls on an object by itself (`then`, `toString`, `valueOf`, `toLocaleString`, `toJSON`), reserved words and sandbox globals as namespaces, identifiers AgentScript refuses (as namespaces or method names), collisions with `reservedNames`, duplicated methods, and tool names that are empty, oversized or not valid tool names (`TOOL_NAMESPACE_TOOL_NAME_PATTERN`: letters, digits, `:`, `.`, `_` and `-`, starting with a letter, as the `worker_threads` and iframe protocols require; this also applies to the generated `<namespace>.<method>` names, so `_util` or `$db` need explicit tool names). It throws a `TypeError` whose message starts with `Invalid toolNamespaces:`.

## Built-in Rules

Every rule has a `name`, which is the key used in the `rules` option of `validate()`. An issue's severity is, in this order: the severity the rule reported the issue with, the severity set for the rule in that option, the rule's default severity. An issue a rule reports with a severity of its own keeps it: `NoRegexMethodsRule` reports `REGEX_METHOD_DYNAMIC` as a warning, and `{ severity: ValidationSeverity.ERROR }` for `no-regex-methods` does not make it an error.

| Class                         | `name`                      | What it checks                                                                                      |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `DisallowedIdentifierRule`    | `disallowed-identifier`     | Listed names as a variable, a property, a destructuring key                                         |
| `NoEvalRule`                  | `no-eval`                   | `eval`, `Function`, string timers, `with`, dynamic `import()`                                       |
| `NoGlobalAccessRule`          | `no-global-access`          | The global objects, `this`, the `constructor` property                                              |
| `ForbiddenLoopRule`           | `forbidden-loop`            | Loop kinds                                                                                          |
| `NoAsyncRule`                 | `no-async`                  | Async functions and `await`                                                                         |
| `RequiredFunctionCallRule`    | `required-function-call`    | That listed functions are called, and how often                                                     |
| `CallArgumentValidationRule`  | `call-argument-validation`  | Argument count and kinds of listed functions                                                        |
| `UnreachableCodeRule`         | `unreachable-code`          | Code after `return`, `throw`, `break`, `continue` (warning)                                         |
| `UnknownGlobalRule`           | `unknown-global`            | Globals that are not on an allowlist                                                                |
| `AllowedSyntaxRule`           | `allowed-syntax`            | Node types that are not on an allowlist                                                             |
| `NoUserDefinedFunctionsRule`  | `no-user-functions`         | Function declarations and expressions                                                               |
| `StaticCallTargetRule`        | `static-call-target`        | That a call target's first argument is a string literal, optionally from a list                     |
| `NoCallTargetAssignmentRule`  | `no-call-target-assignment` | Assigning to or shadowing protected call targets                                                    |
| `ReservedPrefixRule`          | `reserved-prefix`           | Identifiers with reserved prefixes                                                                  |
| `NoRegexLiteralRule`          | `no-regex-literal`          | Regex literals: refused, or analyzed for ReDoS                                                      |
| `NoRegexMethodsRule`          | `no-regex-methods`          | Methods that run a pattern (`match`, `matchAll`, `search`, `replace`, `split`, `test`, `exec`, ...) |
| `NoComputedDestructuringRule` | `no-computed-destructuring` | Computed keys in destructuring patterns                                                             |
| `NoJsonCallbacksRule`         | `no-json-callbacks`         | `JSON.stringify` / `JSON.parse` with a replacer or reviver                                          |
| `UnicodeSecurityRule`         | `unicode-security`          | Bidirectional controls, invisible characters, look-alike letters (no preset uses it)                |

`UnicodeSecurityRule` reports the tag characters (U+E0000 to U+E007F) as invisible characters.

### DisallowedIdentifierRule

Prevents usage of specific identifiers (e.g., `eval`, `Function`, `process`), as a variable and as a property.

```typescript
import { DisallowedIdentifierRule } from '@enclave-vm/ast';

const rule = new DisallowedIdentifierRule({
  disallowed: ['eval', 'Function', 'process', 'require'],
  messageTemplate: 'Access to "{identifier}" is forbidden',
});
```

A listed name is refused wherever a property is read or written, not only as `obj.name`:

| Written as                                      | Example                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| A member, an optional member, a string key      | `obj.name`, `obj?.name`, `obj['name']`                                        |
| A key in any spelling that is made of constants | `obj['na' + 'me']`, `obj[['na', 'me'].join('')]`, `obj['NAME'.toLowerCase()]` |
| A key held in a variable                        | `const k = 'name'; obj[k]`                                                    |
| The key of a destructuring pattern              | `const { name: x } = obj`, `({ name }) => ...`                                |

| Option                       | Default | What it does                                                                                                                                                                                                                    |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disallowed`                 | -       | The names to refuse, as a variable and as a property (required).                                                                                                                                                                |
| `disallowedProperties`       | `[]`    | Names refused as a property only, in the same spellings and positions. They stay usable as variable names. For reflection entry points such as `__lookupGetter__` or `getOwnPropertyDescriptor`.                                |
| `blockProtoInObjectLiterals` | `false` | Refuses `{ __proto__: x }`, which sets the prototype of the new object, and a computed `__proto__` key (`{ ['__proto__']: x }`), which sets the prototype of whatever the object is copied onto.                                |
| `disallowedObjectKeys`       | `[]`    | Names refused as a key of an object literal as well, in every spelling: for a property that must not be installed by copying an object onto another (`Object.assign(target, { name: value })`).                                 |
| `resolveVariableKeys`        | `true`  | Reads a key through the variables of the script. Turn it off where the key of a computed member is checked at run time (`guardComputedMemberKeys`) and that check should answer for a variable, as the AgentScript preset does. |
| `checkDestructuringKeys`     | `true`  | Refuses a listed name as the key of a destructuring pattern. Turn it off where another rule decides which keys a pattern may read (`NoComputedDestructuringRule`), as the AgentScript preset does.                              |
| `messageTemplate`            | -       | The message of an issue; `{identifier}` is replaced with the name.                                                                                                                                                              |

#### How a property key is read

A computed key is not matched against a list of spellings: it is evaluated. A key that is made of constants (literals, operators, the built-in functions of the language applied to constants, a function written in place and called there) has one fixed value, and that value is compared with the refused names.

- A key that is made of constants and that the validator cannot compute is refused with `STATIC_KEY_UNRESOLVED`: it names one fixed property, and a name the validator cannot read is not accepted unread. Write the property name directly.
- A key that the expression would build to more than 4096 characters (`'ab'.repeat(5000)`) is refused with `STATIC_KEY_TOO_LONG` without being built. A string literal, or a template literal without a substitution, is not built: it is read as it is written, however long it is.
- A value the validator computes is the value the engine computes. Where the two could differ, the key is not computed, and so is refused: where something inside the key assigns and what follows may read it, or is not evaluated (`((k) => (k = 'b', k))('a')`; an assignment that nothing is evaluated after is the value it assigns, so `o[(name = 'alpha')]` is `o.alpha`), where the answer depends on the engine or the realm (`typeof Math`, whether a newer method exists), and, in a script that can change a built-in, for everything that goes through a built-in. A script can change a built-in when it assigns to one (`Math.max = f`), or when it hands one on (`const M = Math`) and also writes to an object that may be it (`M.max = f`); a script that only passes `Number` to `map`, or keeps `Object.keys` under another name, cannot. A limit that is reached (steps, depth, alternatives, size) is a key that is not computed, never a shorter list of names.
- With `resolveVariableKeys`, a `const` that holds a constant is that constant. Any other variable, and a parameter, is a run-time value; the constants the script can be seen giving it (an initializer, an assignment, a pattern, a loop, a call that can be seen, a value stored into the list or the object it holds) are compared with the refused names all the same. A `var` named like a parameter is that parameter (where the parameter list has an expression in it, a variable of its own that starts with the parameter's value), and a rest parameter is the list of the arguments. This part is a search, not a proof: a name a script assembles at run time over several statements is a run-time value. A search that reaches its limit refuses the key (`STATIC_KEY_UNRESOLVED`); it never leaves it to run time.
- A key that depends on a run-time value (a function parameter, the result of a call into the host) is **not decided by the validator**. Check it where the script runs: `guardComputedMemberKeys` wraps every such key, and `@enclave-vm/core` applies it.

`NoGlobalAccessRule` (the `constructor` property), `NoRegexMethodsRule` and `ReservedPrefixRule` read a computed key the same way. `NoEvalRule` reads the first argument of `setTimeout` / `setInterval` the same way (see [NoEvalRule](#noevalrule)).

A rule that reads a key reports one it cannot read with the severity of the rule. Where several rules read the same key, it is reported once, at the highest of their severities: turning one rule down to a warning does not turn the refusal of another into a warning.

### NoEvalRule

Prevents the constructs that turn a string into code. All of them are reported with `NO_EVAL`.

```typescript
import { NoEvalRule } from '@enclave-vm/ast';

const rule = new NoEvalRule();
// Blocks: eval(), Function(), new Function(), setTimeout("code", ...), with, import()
```

- `eval(...)`, `Function(...)` and `new Function(...)`.
- `setTimeout` / `setInterval` with a first argument that is a string in any spelling that is made of constants (read as described in [How a property key is read](#how-a-property-key-is-read)), or with an argument that can never be a function whatever it holds (a template, a string something is added to, `String(value)`, an array or object literal): the timer converts it to a string and compiles it. This holds for a timer called by name or as a member (`window.setTimeout(...)`), with `new`, and as the tag of a template. A first argument that is a function, or whose kind is only known at run time, is not refused.
- A timer, `eval` or `Function` used as a value: stored under another name, passed to a function, taken out of an object, or called through `.call`, `.apply` or `.bind`. What it is then called with is out of the rule's sight, so the value itself is refused. `typeof setTimeout` and `x instanceof Function` are allowed.
- `with` statements and dynamic `import()` expressions.

### ForbiddenLoopRule

Prevents loop constructs. Each kind can be allowed.

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

Ensures specific functions are called. The rule counts the calls written in the source, not the calls that run: `if (false) callTool('x', {})` counts as one call to `callTool`, and a call inside a loop counts once. It does not prove that a script calls a tool when it runs.

```typescript
import { RequiredFunctionCallRule } from '@enclave-vm/ast';

const rule = new RequiredFunctionCallRule({
  required: ['callTool'],
  minCalls: 1,
  maxCalls: 10,
  messageTemplate: 'Must call {function} at least once',
});

// Require either callTool or invokeAPI to be called
const either = new RequiredFunctionCallRule({
  required: ['callTool', 'invokeAPI'],
  mode: 'any', // 'all' (default): every function in `required` must be called
  minCalls: 1,
});
```

`directCallsOnly: true` counts only calls of the name itself, not of a method of that name on an object.

### CallArgumentValidationRule

Validates function call arguments (count and kinds).

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

`expectedTypes` takes `'string'`, `'number'`, `'boolean'`, `'object'`, `'array'`, `'function'` and `'literal'`.

### NoAsyncRule and UnreachableCodeRule

```typescript
import { NoAsyncRule, UnreachableCodeRule } from '@enclave-vm/ast';

const noAsync = new NoAsyncRule({
  allowAsyncFunctions: false,
  allowAwait: false,
  message: 'Async code is not supported',
});

// Reports code after return / throw / break / continue, as a warning
const unreachable = new UnreachableCodeRule();
```

## Custom Rules

Implement the `ValidationRule` interface and report issues through the context. A rule reads `context.ast` and does not change it: every rule of a validation is given the same tree, and what is worked out about it (its scopes, the value of a computed key) is shared between them.

```typescript
import { JSAstValidator, ValidationSeverity, type ValidationRule, type ValidationContext } from '@enclave-vm/ast';
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
            location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
          });
        }
      },
    });
  }
}

const validator = new JSAstValidator([new NoConsoleRule()]);
```

`acorn-walk` is a dependency of this package; import it in your own code only if you add it to your own dependencies.

## Validator API

### Validation Options

```typescript
import {
  JSAstValidator,
  DisallowedIdentifierRule,
  NoEvalRule,
  RequiredFunctionCallRule,
  ValidationSeverity,
} from '@enclave-vm/ast';

// A rule takes its options in its constructor
const validator = new JSAstValidator([
  new DisallowedIdentifierRule({ disallowed: ['eval'] }),
  new NoEvalRule(),
  new RequiredFunctionCallRule({ required: ['callTool'] }),
]);

const result = await validator.validate(code, {
  // Parse options (passed to acorn)
  parseOptions: { ecmaVersion: 'latest', sourceType: 'script' },

  // Per-rule switches, by rule name: enable, disable or set the severity of a registered rule
  rules: {
    'disallowed-identifier': true, // Enable
    'no-eval': false, // Disable for this validation
    'required-function-call': { enabled: true, severity: ValidationSeverity.WARNING },
  },

  stopOnFirstError: false,

  // Maximum number of issues to collect (default: 100, 0 = unlimited)
  maxIssues: 100,

  // Pre-scanner preset (default: 'standard'; { enabled: false } switches it off)
  preScan: { preset: 'agentscript' },
});
```

| Option             | Type                                    | Default           | Meaning                                                              |
| ------------------ | --------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| `parseOptions`     | `acorn.Options`                         | -                 | Passed to the parser                                                 |
| `rules`            | `Record<string, RuleConfig \| boolean>` | -                 | Enable, disable or set the severity of a registered rule by name     |
| `stopOnFirstError` | `boolean`                               | `false`           | Stop at the first error                                              |
| `maxIssues`        | `number`                                | `100`             | Cap on collected issues; `0` collects every issue                    |
| `transform`        | `TransformConfig`                       | -                 | Rewrite identifiers with a prefix and return `transformedCode`       |
| `preScan`          | `{ enabled?, preset?, config? }`        | `standard` preset | The pre-scanner run before parsing (see [Pre-Scanner](#pre-scanner)) |

A rule's configuration in `rules` is read for `enabled` and `severity` only. Its `options` field is not passed to the rule: a rule takes its options in its constructor, and a rule name that is not registered has no effect.

`maxIssues` bounds what one validation builds from a source the host did not write. It defaults to `DEFAULT_MAX_ISSUES` (100); pass `0` to collect every issue. At the cap the validation stops as soon as an error is on the list. While only warnings were found the remaining rules still run, because one of them may refuse the source, and further warnings are not collected. A result that was cut short has `incomplete: true`, and `valid` is `true` only when every rule ran and none reported an error. An `UNKNOWN_GLOBAL` issue states the list of allowed globals once per validation, in the first such issue; the following ones name the identifier only.

The `transform` option with `transformComputed` prints a computed key it rewrites as one string literal, whatever characters the key holds.

### Rule Management

```typescript
const validator = new JSAstValidator();

validator.registerRule(new DisallowedIdentifierRule({ disallowed: ['eval'] }));
validator.registerRule(new NoEvalRule());

const rules = validator.getRules();
const rule = validator.getRule('no-eval');
validator.unregisterRule('no-eval');
```

### Validation Results

```typescript
interface ValidationResult {
  valid: boolean; // true if every rule ran and none reported an error
  issues: ValidationIssue[]; // The issues found, at most maxIssues
  incomplete?: boolean; // true if the list was cut at maxIssues or the validation stopped early
  rulesExecuted?: number; // Rules that were started
  ast?: acorn.Node; // Parsed AST (if parsing succeeded)
  parseError?: Error; // Parse error (if parsing failed)
  transformedCode?: string; // With the `transform` option
  preScanError?: Error; // When the pre-scanner refused the source
}

interface ValidationIssue {
  code: string; // Issue code, e.g. NO_EVAL
  severity: ValidationSeverity; // 'error' | 'warning' | 'info'
  message: string; // Human-readable message
  location?: SourceLocation; // Source location
  data?: Record<string, unknown>; // Additional context
}
```

`validator.getStats(result, durationMs)` returns `{ totalIssues, errors, warnings, infos, rulesExecuted, durationMs }`.

### Error Handling

The error classes of this library extend `AstGuardError`. Not everything `validate()` throws is one of them: it throws `InvalidSourceError` (an `AstGuardError`) for a source that is not a string or is empty, a `TypeError` for an invalid `preScan` option, and whatever a rule of your own throws (the exception of a rule is not turned into an issue). A caller that catches only `AstGuardError` leaves the last two unhandled. A parse error is not thrown but returned as `result.parseError`, with a `PARSE_ERROR` issue:

```typescript
import { ParseError, RuleConfigurationError, InvalidSourceError } from '@enclave-vm/ast';

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

The other exported error classes are `ConfigurationError` and `RuleNotFoundError`.

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

Configured limits are clamped to the absolute maximums in `MANDATORY_LIMITS`.

`Enclave` (`@enclave-vm/core`) and `BrowserEnclave` (`@enclave-vm/browser`) run the pre-scanner themselves, on the script as it was written and before anything parses it, with the pre-scanner preset named like their AST preset: `agentscript` by default (the `babel` preset of the core enclave runs with `standard`). Their `preScan` option picks another preset or changes single limits. They then validate the transformed script with the validator's own pre-scan switched off.

## ReDoS Analysis Without the Parser

To check regular expressions for catastrophic backtracking without validating JavaScript, import the analyzer from `@enclave-vm/ast/redos`. It loads none of the parser (`acorn`, `acorn-walk`, `astring`) that the package root loads, and is about 8 KB.

```ts
import { analyzeForReDoS, REDOS_THRESHOLDS } from '@enclave-vm/ast/redos';

const { score } = analyzeForReDoS('(a+)+$', 'catastrophic');
if (score >= REDOS_THRESHOLDS.BLOCK) throw new Error('Pattern can backtrack catastrophically');
```

It also exports `REDOS_PATTERNS`, `calculateStarHeight` and the `ReDoSAnalysisResult` type, the same as the package root.

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

- `transformConcatenation(ast, options)` rewrites `a + b` to `__safe_concat(a, b)`. `compoundAssignment` (default `true`) rewrites `x += y` the same way, so that it is charged like `x + y`; `arraySpread` (default `false`) hands every array literal that has elements to the runtime, for a runtime that defines the helpers for it: one with a spread as `__safe_array(__safe_arrayStart(), [a, ...__safe_spread(b)])`, one without as `__safe_array(0, [a, b])` (`0`: no spread). The empty literal is left as it is.
- `guardComputedMemberKeys(ast, parse, options)` (`parse` builds the helper it injects) rewrites every computed member access whose key is not a literal, `obj[expr]`, to `obj[__ag_guardKey(expr)]` (`GUARD_KEY_FN`). The helper checks the resolved key at run time against `blockedKeys` (`DEFAULT_GUARD_BLOCKED_KEYS` by default: `constructor`, `__proto__`, `prototype` and the other names that unlock a prototype chain) and throws, or returns `undefined` with `throwOnBlocked: false`.
- `guardArrayWrites(ast, options)` hands the runtime every write whose effect on an array cannot be told from the text (a member with a computed key, and `length`), so that a runtime that counts array memory can refuse it.
- `extractLargeStrings(ast, config)` moves string literals above a threshold out of the source, for the reference sidecar of `@enclave-vm/core`.
- `rewriteImports(code, config)` rewrites imports of npm packages to CDN URLs. The package allowlist applies to import declarations, re-exports and dynamic `import()` alike: a dynamic import of a listed package is rewritten, one of another package is refused, and a specifier computed at run time is refused. Versions with path or URL characters, and a base URL with credentials, a query or a fragment, are refused.

`transformAst`, `generateCode` and `transformCode` are the general-purpose transformer behind the `transform` option of `validate()`.

## How This Package Fits With the Runtime

The validator is the static layer. It decides from the text of a script which scripts are accepted; it does not run them. In `@enclave-vm/core` it is one step of several:

1. **Pre-scanner** (this package): the source text, before parsing.
2. **AgentScript transform** (`transformAgentScript`, applied by the runtime): the `__ag_main` wrapper, `__safe_callTool` and loop guards. The validator receives the script as this step returns it.
3. **AST validation** (this package): the AgentScript preset by default.
4. **Transformation after validation** (this package's transforms, applied by the runtime): concatenation tracking and the run-time check of computed keys (`guardComputedMemberKeys`).
5. **Runtime** (`@enclave-vm/core`): a realm that holds only the allowed globals, a membrane around every value and call, limits on time, iterations, tool calls and memory, and optionally a worker thread with a heap limit and a hard stop. What a static rule cannot decide, such as a key that is only known at run time, is checked here.

[`@enclave-vm/browser`](https://www.npmjs.com/package/@enclave-vm/browser) uses the same pre-scanner and AgentScript preset in front of nested sandboxed iframes; there the validator is what keeps a script from the document it runs in (see its README).

### Known Limitations

These are inherent to **any** static analyzer (not vulnerabilities):

| Limitation                                    | Example                                                                           | Mitigation                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A property key that is only known at run time | `(key) => obj[key]`, `obj[await callTool('k', {})]`, a name assembled at run time | `guardComputedMemberKeys`, a realm behind a membrane |
| A value reached without naming it             | a function a host object returns                                                  | A realm that holds nothing but the allowed globals   |
| A global under another name                   | `const w = window`                                                                | Remove the global from the realm                     |
| A property read by a function, not by a key   | a host function that takes a property name                                        | Do not give such a function to a script              |

What is **not** a limitation, because a parser can see it: a refused name spelled in pieces or built from constants (`obj['con' + 'structor']`, `obj[['con', 'structor'].join('')]`), held in a `const`, or written as the key of a destructuring pattern (`const { constructor: c } = obj`). The STRICT and SECURE presets refuse these (see [How a property key is read](#how-a-property-key-is-read)).

STRICT and SECURE are filters on the text of a script: nothing checks a key after them. For a key that reaches the script through a variable or a parameter they look for the name and find the ways it is usually written; they cannot prove that a script never computes one at run time (a name assembled over several statements, a long constant cut at a run-time position). Code that is not trusted belongs in a runtime that checks the key where it is used (`@enclave-vm/core`).

They are why a preset is a filter and not a boundary: what a script does with a value at run time is decided where it runs.

## Related Packages

- [`@enclave-vm/core`](https://www.npmjs.com/package/@enclave-vm/core): runs validated AgentScript in Node.js, with run-time checks and limits
- [`@enclave-vm/browser`](https://www.npmjs.com/package/@enclave-vm/browser): runs validated AgentScript in the browser, in nested sandboxed iframes

## Documentation

- Guides and reference: https://agentfront.dev/docs/guides/enclave
- AgentScript language reference: [docs/AGENTSCRIPT.md](https://github.com/agentfront/enclave/blob/main/libs/ast/docs/AGENTSCRIPT.md)
- Repository: https://github.com/agentfront/enclave
- Reporting a vulnerability: [SECURITY.md](https://github.com/agentfront/enclave/blob/main/SECURITY.md)

## License

Apache-2.0. See [LICENSE](https://github.com/agentfront/enclave/blob/main/LICENSE).
