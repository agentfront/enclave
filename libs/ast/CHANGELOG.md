# Changelog

All notable changes to `ast-guard` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### After 2.19.1: a review of every package

Draft for the maintainer. The invariants are listed under "Layer 1: static" in `SECURITY-TESTS.md`.

#### Changed: what a host will notice

- **The pre-scanner refuses a configuration that would switch a check off.** A preset name that does not exist threw nothing and scanned without a single limit; it is a `TypeError` now. So is an override that is not a number of at least 0 (`NaN` compared false with every size), a switch that is not a boolean, and a regex mode that does not exist. `Infinity` still stands for the pre-scanner's own maximum, and an override passed as `undefined` is an override that was not given.
- **A blocked regular-expression literal is reported as blocked.** With `regexMode: 'block'` (the `agentscript` preset) the pre-scanner answered `PRESCANNER_REGEX_COUNT` ("exceeds maximum allowed (0)"); it answers `PRESCANNER_REGEX_BLOCKED` with the literal's position.
- **A validation result is bounded.** Without `maxIssues` a validation collects at most `DEFAULT_MAX_ISSUES` (100) issues (`0` still collects all), an unknown-global issue states the list of allowed globals once per validation, and a validation that stopped early is never `valid`: such a result has `incomplete: true` (ATK-VBOUND).
- **`Object` is used directly** under the AgentScript preset (`requireDirectObjectUse`): `Object.name` with a name written in the source, a call, a construction, `typeof`, `instanceof`. An alias, passing or storing it, destructuring from it and a member name computed at run time are refused with `OBJECT_INDIRECT_USE`. A reflection static of `Object` is refused wherever it is read.
- **Syntax allowlist.** `using` and `await using` declarations, `for await` loops and generator functions are constructs of their own (`UsingDeclaration`, `AwaitUsingDeclaration`, `ForAwaitStatement`, `GeneratorFunction`): refused by AgentScript, allowed only when listed under that name. `allowedFunctionNames` allows one declaration with the wrapper's shape.
- **STRICT and SECURE presets** refuse `this` as a value in every position (ATK-GTHIS).
- **Regular-expression methods** (`match`, `matchAll`, `search`) are seen through `call` / `apply` / `bind`, in every static spelling of the name and without an argument. New option `requireDirectCall` (AgentScript preset: `requireDirectRegexMethodCalls`), off by default.
- **Tool namespaces.** `normalizeToolNamespaces` refuses `then`, `toString`, `valueOf`, `toLocaleString` and `toJSON` as method names and as namespace names (ATK-NSHOOK).
- **Reserved names.** `reservedPrefixes` adds to the prefixes of the runtime (`__ag_`, `__safe_`) instead of replacing them; `__maxIterations`, the runtime's name for the iteration limit, is reserved as well.
- **`transformAgentScript`** takes `maxIterations` and writes it as a number into each loop check; without it, a script that uses the runtime's name for the limit is refused. `transformConcatenation` has the options `compoundAssignment` (default true: `x += y` is charged like `x + y`) and `arraySpread`.
- **`rewriteImports`.** A dynamic import of a listed package is rewritten and one of another package refused; a computed specifier is refused; versions with path or URL characters and a base URL with credentials, a query or a fragment are refused (ATK-IMPRW).
- **`UnicodeSecurityRule`** reports the tag characters (U+E0000 to U+E007F) as invisible characters, and locates its matches in linear time.

#### Security

- **`transformComputed`.** A computed key that is rewritten is printed as the string literal of its new value whatever characters it holds (ATK-XFORM).
- **JSON callbacks.** Only the global `undefined` counts as "no replacer or reviver", not a variable of the script with that name.
- **Call targets.** `NoCallTargetAssignmentRule` sees every write and every declaration of a protected name: destructuring, loop heads, `++` / `--`, catch-clause patterns, default values and class names.
- **Preset options hold for transformed code.** `requireCallTool` and `callToolValidation` know the call as `callTool` and as `__safe_callTool`.

## [2.19.0] - 2026-11-12

A security release of the static layer. The invariants behind each item, and the categories of the tests that pin them, are listed under "Layer 1: static" in `SECURITY-TESTS.md`; nothing here says more than that file does.

### Security

- **Syntax allowlist (ATK-SYNTAX).** The AgentScript preset refuses every syntax node that is not part of the language, through the new `AllowedSyntaxRule` and `AGENTSCRIPT_ALLOWED_NODE_TYPES`. `this`, classes, `new.target`, `import.meta`, `debugger`, `with`, generators and dynamic `import()` are refused because they are not on the list, not because a rule names each of them, so syntax nobody thought of is refused too.
- **Globals are resolved by lexical scope (ATK-SCOPE).** `UnknownGlobalRule` and the identifier transform no longer keep one set of declared names for the whole program. A declaration in a block, an arrow function or a catch clause makes a name local only there. Where two readings of the language disagree, the narrower one is used.
- **Writes are checked like reads (ATK-GWRITE).** Assigning to a global or to a reserved runtime name is refused in every target position: a plain assignment, a destructuring pattern, a `for…of` or `for…in` head, `++`/`--` and `delete`. `ReservedPrefixRule` covers bindings and member targets in the same positions.
- **Prototype chain and reflection by property name (ATK-PCHAIN, ATK-REFL).** `constructor`, `prototype` and `__proto__` are refused as property names in every statically resolvable spelling and position. `DisallowedIdentifierRule` also refuses the reflection entry points by property name (`AGENTSCRIPT_DISALLOWED_PROPERTIES`: the prototype and descriptor functions of `Object` and the legacy accessor methods), whatever object they are read from, and the `{ __proto__: x }` literal key. `NoComputedDestructuringRule` refuses the same names as destructuring keys.
- **Direct use only (ATK-CTGT, ATK-JSONCB).** `callTool` and `JSON` may only appear as direct calls. An alias, `.call` / `.apply` / `.bind`, a tagged template, a spread, a sequence callee, a computed method name or passing the function as a value is refused, since each takes the call out of sight of the argument checks.
- **JSON methods (ATK-JSONCB).** Of `JSON`, only `parse` and `stringify` may be called, and the callback check resolves the method name in every static spelling the direct-use check accepts. The direct-use check follows lexical scope: it applies to the global, not to a variable of the script that has the same name.
- **Method names in every static spelling (ATK-RXSTR, ATK-RSRC).** `NoRegexMethodsRule` and the `repeat` / `join` / `fill` checks of `ResourceExhaustionRule` resolve a method name written as `x.name`, `x['name']` or a template literal without substitutions; they read only the first form, or the first two.
- **Regular expressions from strings (ATK-RXSTR).** A string passed to `match`, `matchAll` or `search` is treated as the regular expression it becomes, also in the tagged-template form and when the argument is not a literal. A method of that name on a global the host declared as an object (`hostObjectGlobals` of the preset: a tool namespace, say) and a call with an object literal of data keep the warning. A global that is not declared may be a string, and is treated as one.
- **Loop counters (ATK-LCTR).** The loop transform never hands out a counter name that the script mentions anywhere.

### Added

- `AllowedSyntaxRule` with `AllowedSyntaxOptions`, `AGENTSCRIPT_ALLOWED_NODE_TYPES` and `AGENTSCRIPT_DISALLOWED_PROPERTIES`.
- AgentScript preset option `additionalAllowedSyntax`, which re-enables a node type for a host that does not run untrusted code.
- Rule options, all off by default outside the AgentScript preset: `disallowedProperties` and `blockProtoInObjectLiterals` (`DisallowedIdentifierRule`), `requireDirectCall` (`StaticCallTargetRule`), `requireDirectUse` (`NoJsonCallbacksRule`), `additionalDangerousKeys` (`NoComputedDestructuringRule`) and `allowGlobalAssignment` (`UnknownGlobalRule`).
- `NoComputedDestructuringRule` and `NoJsonCallbacksRule`, with their option types, are exported from the package entry.
- AgentScript preset option `hostObjectGlobals`, and `hostObjectNames` of `NoRegexMethodsRule`: the globals that are objects of the host, on which a method called `match`, `matchAll` or `search` is the host's own.

### Changed

- The AgentScript preset is stricter. A script that used a construct outside the allowlist, assigned to a global, shadowed a global in one scope and used it in another, or reached `callTool` or `JSON` other than through a direct call is now refused, with an issue that names the construct. Ordinary AgentScript is unaffected. The other presets change only where a host switches the new options on.
- With the AgentScript preset, `text.match(pattern)`, `matchAll` and `search` are refused for any argument on a value of the script (they were a warning when the argument was not a literal), and `JSON` methods other than `parse` and `stringify` are refused.

### Fixed

- The identifier transform keeps the property key when it renames a destructuring target that has a default: `({ x = 1 } = source)` reads `x` from `source` as before.

## [2.4.0] - 2026-01-09

### Added

- Resource exhaustion rule and AgentScript preset now accept `allowDynamicArrayFill`, letting environments with runtime memory patches permit computed `Array.fill` sizes.

## [2.3.0] - 2026-01-08

### Added

- AgentScript preset now enables the new NoJsonCallbacksRule that blocks JSON.stringify/parse when replacer or reviver callbacks are supplied to prevent property-enumeration leaks (libs/ast-guard/src/presets/agentscript.preset.ts, libs/ast-guard/src/rules/no-json-callbacks.rule.ts).
- ResourceExhaustionRule gained maxArrayFillSize and detection for Array(n).fill()/Array(n) patterns so large fills or dynamically sized arrays are reported before execution (libs/ast-guard/src/rules/resource-exhaustion.rule.ts).

### Changed

- AgentScript preset documentation comments reflect the new array-fill coverage for Vector 1110 style attacks (libs/ast-guard/src/presets/agentscript.preset.ts).

## [2.2.0] - 2026-01-07

### Added

- AgentScript transformer now whitelists URI encoding helpers (`encodeURI`, `decodeURI`, `encodeURIComponent`, `decodeURIComponent`) so they survive transformation.
- AgentScript preset exports security-level-specific global lists (`AGENTSCRIPT_*`), a `getAgentScriptGlobals` helper, and accepts a new `securityLevel` option; the public index also re-exports the new constants and `SecurityLevel` type.

### Changed

- Default AgentScript allowed globals are derived from the chosen security level (falling back to STANDARD) before merging in user-specified identifiers.

### Fixed

- Regex pre-scanner analyzes user patterns through the new `safePatternTest`/`safePatternMatch` helpers so the detector’s own regular expressions are not exploitable.

### Security

- REDOS detection patterns now use bounded quantifiers and truncate inspected patterns, eliminating analyzer-driven ReDoS vectors.

## [2.1.0] - 2026-01-06

### Added

- Introduced ResourceExhaustionRule to detect BigInt exponentiation with huge exponents, oversized array constructors, string repeat/join bombs, and constructor/property obfuscation attempts (libs/ast-guard/src/rules/resource-exhaustion.rule.ts:1-239).
- AgentScript preset now enables ResourceExhaustionRule with sane defaults so DoS-style scripts are blocked by default and the rule is exported for custom presets (libs/ast-guard/src/presets/agentscript.preset.ts:434-447; libs/ast-guard/src/rules/index.ts:5-23).

## [2.0.0] - 2026-01-06

### Added

- `for`/`while`/`do-while` loops are now transformed with injected iteration counters that enforce the runtime `__maxIterations` limit instead of being rejected outright.
- Agentscript preset now allows the `__maxIterations` global and ships a new `InfiniteLoopRule` that flags obvious infinite-loop syntax.

### Changed

- Loop guards throw a string error when the iteration ceiling is exceeded, so host runtimes must expose `__maxIterations` for transformed scripts to run.

## [1.1.2] - 2026-01-05

### Fixed

- Template literal transforms now skip tagged template expressions so tag functions continue receiving the original raw template strings.

## [1.1.0] - 2025-12-11

### Added

- AgentScript preset now blocks structuredClone, AbortController/AbortSignal, MessageChannel/MessagePort, BroadcastChannel, TextEncoder/TextDecoder, and Intl before code hits runtime (libs/ast-guard/src/presets/agentscript.preset.ts:292).
- AgentScript preset treats queueMicrotask as a disallowed timer primitive to mitigate microtask flooding attacks (libs/ast-guard/src/presets/agentscript.preset.ts:311).

### Security

- NoEvalRule now reports dynamic import() expressions so untrusted code cannot lazy-load modules (libs/ast-guard/src/rules/no-eval.rule.ts:4).

## [1.0.0] - 2025-01-23

### Added

- **Security Presets**: Pre-configured security levels for quick setup
  - `STRICT`: Maximum security (bank-grade) - blocks all dangerous patterns, loops, and async
  - `SECURE`: High security - blocks most dangerous patterns with some flexibility
  - `STANDARD`: Medium security - sensible defaults for most use cases
  - `PERMISSIVE`: Low security - minimal restrictions, only blocks eval
- New `Presets` object with factory functions for each security level
- `createPreset()` function to create presets by level
- Individual preset functions: `createStrictPreset()`, `createSecurePreset()`, `createStandardPreset()`, `createPermissivePreset()`
- Comprehensive preset customization via `PresetOptions` interface
- Support for overriding loop restrictions, async settings, and blocked identifiers
- Built-in API enforcement for required functions and argument validation
- 75+ new tests covering all preset configurations and real-world scenarios
- Extensive README documentation with preset usage examples and comparison matrix

### Changed

- Reorganized preset system into separate files in `src/presets/` directory for better maintainability
- Enhanced type safety by importing `FunctionArgumentConfig` from validation rules

### Security

- **Bank-Level Security Enhancements**: STRICT preset now blocks 90+ dangerous identifiers for maximum protection
  - **Prototype Manipulation**: Blocks `Object`, `Array`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `constructor`, `__proto__`, `prototype`
  - **Error Stack Manipulation**: Blocks all Error types (`Error`, `TypeError`, `ReferenceError`, `SyntaxError`, etc.) to prevent stack trace exploitation
  - **Reflection & Metaprogramming**: Blocks `Proxy` and `Reflect` to prevent property interception and manipulation
  - **Async Primitives**: Blocks `Promise` to prevent timing attacks and race conditions
  - **Pattern Matching**: Blocks `RegExp` to prevent ReDoS (Regular Expression Denial of Service) attacks
  - **Binary Data**: Blocks all TypedArrays, `ArrayBuffer`, `SharedArrayBuffer`, `DataView` to prevent memory manipulation
  - **WebAssembly**: Blocks `WebAssembly` to prevent native code execution
  - **Workers**: Blocks `Worker`, `SharedWorker`, `ServiceWorker` to prevent sandbox escape
  - **Internationalization**: Blocks `Intl` to prevent system information leakage
  - **Atomics**: Blocks `Atomics` to prevent `SharedArrayBuffer` manipulation
  - **Collections**: Blocks `Map`, `Set`, `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry` to prevent memory leaks and prototype pollution
  - **Dates & JSON**: Blocks `Date` (timing attacks) and `JSON` (circular reference attacks)
  - **Browser APIs**: Blocks `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `crypto`, `performance`
  - **Timers**: Blocks `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`
  - **Dynamic Loading**: Blocks `importScripts` (note: `import` keyword handled by parse errors in script mode)

- **Advanced Attack Detection Tests**: 35 comprehensive tests covering sophisticated attack vectors
  - Property access obfuscation (computed properties, string concatenation, template literals, Unicode escapes)
  - Prototype pollution (Object/Array/Symbol prototype manipulation)
  - Function construction bypasses (AsyncFunction, GeneratorFunction)
  - Sandbox escapes (Error stack manipulation, constructor chains)
  - Promise-based code execution and timing attacks
  - Symbol-based property access attacks
  - Proxy-based interception attacks
  - RegExp DoS (ReDoS) patterns
  - Memory exhaustion attacks
  - WebAssembly exploitation
  - Import/dynamic import detection (parse errors in script mode)
  - Worker-based isolation bypass
  - toString/valueOf manipulation
  - Getter/setter traps
  - Comprehensive bank-level lockdown validation
