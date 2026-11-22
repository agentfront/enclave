# Changelog

All notable changes to the Enclave monorepo will be documented in this file.

For detailed changes to individual packages, see their respective changelogs:

- [enclave-vm](libs/enclave-vm/CHANGELOG.md)
- [ast-guard](libs/ast-guard/CHANGELOG.md)

## [Unreleased]

- `@enclave-vm/ast`: GHSA-jqf3-vx4j-7p22 and what is like it (ATK-PCHAIN, ATK-REFL, ATK-TSTR, ATK-VBOUND). A computed property key that is made of constants is evaluated and compared with the refused names in whatever way it is spelled, and one the validator cannot compute, or whose computed value could differ from the engine's, is refused (`STATIC_KEY_UNRESOLVED`) instead of accepted unread. The STRICT and SECURE presets refuse a listed name as the key of a destructuring pattern and look for it in the variable or parameter a key is read through; they refuse the reflection entry points and the structured stack trace API by property name, and `{ __proto__: x }`. `NoEvalRule` reads a string handed to a timer in every spelling and refuses a timer used as a value. The work done for a key is bounded, and a source too deep to walk is an issue (`SOURCE_TOO_DEEP`), not an exception. A script these presets accepted can be refused now; `libs/ast/CHANGELOG.md` says which. Scripts validated as AgentScript by `@enclave-vm/core` were stopped by the key guard at run time; they are refused by the validator now.

## [2.20.0] - 2026-11-21

A follow-up to 2.19.0: two more layers behind the validator, and the dependency and code-scanning alerts of the repository. `libs/core/CHANGELOG.md` has the changes a host of `@enclave-vm/core` will notice.

- `@enclave-vm/browser`: a script validated as AgentScript runs in a realm that cannot run a regular expression (ATK-RXRT in `SECURITY-TESTS.md`). The matcher methods of `RegExp.prototype` throw `TypeError: Regular expressions are not available in this sandbox`, the prototype is frozen, and the names `RegExp` and `URLPattern` are not in the realm. This is what `@enclave-vm/core` does with the realm allowlist; until now the browser had the validator only. With another preset, or with `validate: false`, the realm is as before.
- `@enclave-vm/core`, interpreter adapter: `maxCallDepth` is counted along each chain of calls, and the new `maxPendingCalls` bounds the calls an execution has in progress.
- `@enclave-vm/broker` depends on `minimatch` 11 (`^11.0.1`, was `^10.2.5`) for the glob patterns of its event filter. `minimatch` 11.0.4 and later need Node.js 20 or 22+; its changelog lists the matching edge cases that changed. The glob patterns of the event filter have a test now.
- Tooling: the root `resolutions` move `glob` to 14 (Jest) and the `minimatch` of `@typescript-eslint/typescript-estree` to 11. Nx pins `minimatch` 10.2.5 and uses an API that 11 removed, so that copy stays until Nx moves.

### Security

- `@enclave-vm/broker`: `cancelOnFirstError` also stops later tools when the core bridge refuses a successful handler result. `maxToolResultBytes` measures the sanitized Map or Set copy, so a collection whose raw JSON is small cannot bypass the result limit.
- `@enclave-vm/client`: a deferred stop after a cancelled creation does not delete a newer session with the same ID. `@enclave-vm/react` keeps the current render's configuration in context when an equal new object reuses its client.
- `@enclave-vm/broker`: the kept history and a tool-call event are measured in UTF-8 bytes, as `history.maxBytes` states it; nothing is appended after a session's `final` event; and `sessionTtlMs` (for an HTTP session, its request's `maxExecutionMs`) cancels a session that is still running when it is reached, where it used to wait for the next cleanup (ATK-BRK-16, ATK-BRK-112, ATK-BRK-113, ATK-BRK-115).
- `@enclave-vm/client`: a stop that gets 404 while the request creating the session has not settled is not taken for a confirmation: `onError` gets `CANCEL_FAILED`, and the stop is sent again once the creation request settles (ATK-CLIENT-18).
- `@enclave-vm/react`: the provider compares its configuration with a copy of what it held when the client was built, so a configuration changed in place gets a new client (ATK-REACT-03).
- `@enclave-vm/runtime`: a WebSocket connect in progress fails when the channel is closed or the socket closes before it opened, instead of staying pending (ATK-RUNTIME-12).
- `@enclave-vm/react`: the state of `useEnclaveSession` belongs to the latest `execute` of the current client. When the provider's client changes, the state is reset and a run of the previous client no longer writes to it or calls the hook's callbacks; a run that finishes after a later one started leaves the later run's state and its cancellation alone, so `cancel()` still reaches it. Each `execute` still resolves with its own result (ATK-REACT-01, ATK-REACT-02).
- `@enclave-vm/broker`: a tool result larger than the sandbox's `toolBridge.maxPayloadBytes` is a failed call in the session itself (`TOOL_BRIDGE_RESPONSE_TOO_LARGE`), so `cancelOnFirstError` stops the session at it. The bridge refused it after the session had counted the call as a success, and a later tool could still run (ATK-BRK-114).
- `@enclave-vm/broker`: the periodic poll of an OpenAPI specification sends the source's `headers` to the specification's origin only; a redirect to another origin is followed without them, as for the first load (ATK-BRK-110).
- `@enclave-vm/broker`: the message and code of an exception a tool handler throws reach the script, and the final event when the script does not catch it, with the value of each secret that handler was given replaced by `[REDACTED]` (ATK-BRK-109). Only the value as it is is recognised, not an encoded or partial form: a handler should still not put a secret into an error.

### After 2.19.1: a review of every package

Draft for the maintainer. A security review of 2.19.1 across all nine packages, with a fix and a test for what it found. The invariants are listed by category in `SECURITY-TESTS.md`, which also lists what is still open; `libs/core/CHANGELOG.md` and `libs/ast/CHANGELOG.md` have the changes a host of those packages will notice. The packages without a changelog of their own:

- `@enclave-vm/broker`
  - The limits the embedder gives the broker bound every session, however it is created. The body of `POST /sessions` is validated as a whole; a request may lower `maxToolCalls` and `maxExecutionMs` and cannot raise them; a limit that is not a number is refused when the broker or a session is created; `limits.maxToolResultBytes` and `ToolConfig.timeout` are enforced.
  - A session id names one session (`409 SESSION_EXISTS` for an id in use), is `s_` followed by 1 to 128 characters of `[A-Za-z0-9._:~-]`, and `maxSessions` holds (`503 MAX_SESSIONS_REACHED`).
  - New optional `identify(request)` hook of the session routes: with it a session belongs to the caller that created it, another caller gets the answer of an id that does not exist, and a request without an identity is answered with 401. Without the hook the routes do not tell callers apart, as before. The package does not authenticate; the README says so.
  - `POST /sessions/:sessionId/cancel`, the URL a session announces, ends the session like `DELETE`. A session ends when the caller that holds its stream goes away.
  - Event filters: an evaluation is bounded in time (`regexTimeoutMs` is enforced; new `budgetMs`), a filter in a request is validated against a schema with bounds (`400 INVALID_FILTER`), an event a filter could not evaluate is not sent, and the text of a pattern is not logged.
  - What a session keeps for a replay is bounded (`history: { maxEvents, maxBytes }`, 10,000 events and 4 MB by default; `410 EVENTS_GONE` for a replay below what is kept), as are the streams of a session (`maxStreamsPerSession`, 8; `429 TOO_MANY_STREAMS`) and what a slow reader may leave unread (`maxBufferedBytes`, 8 MB).
  - OpenAPI tools: a path parameter fills its own segment (`INVALID_PATH_PARAMETER` otherwise); the upstream credential and pinned headers go to the upstream's origin only, also across redirects; responses and specifications are bounded in size and time (`maxResponseBytes`, `maxSpecBytes`, `specTimeoutMs`); a source that fails while polling does not end the process and never leaves the registry half changed.
  - Error answers hold a code and a fixed text. `createExpressRouter` is deprecated (it never registered a route): use `registerExpressRoutes`.
  - A cross-origin page may send `Authorization`: the preflight answer lists it next to `Content-Type`, `Accept` and `Last-Event-ID` (a browser client that sent a credential through the client's `headers` option was refused by the browser before). New option `allowedHeaders` of the session routes for further request headers.
- `@enclave-vm/client`
  - The constructor throws a `TypeError` for an option it does not implement (`encryption`, `auth`, `serverUrl`, `reconnect`, any unknown key) and for a value it cannot use.
  - `timeout` is enforced (60 s by default) for every request and for silence on a stream; a stream that ends without `final` is a lost connection.
  - `cancel()`, `cancelSession()` and an aborted `signal` end the session on the server (`DELETE /sessions/:id`); a stop the server did not confirm calls `onError('CANCEL_FAILED', …)`.
  - A reconnect continues after the last delivered event (`fromSeq`): each event is delivered once, nothing after `final`, one stream per session. New option `maxEventLength` (8 MiB).
  - A session id must start with `s_` and is encoded in every path. An encrypted event ends the session with `PARSE_ERROR`: the client does not implement encryption.
- `@enclave-vm/stream`
  - The NDJSON parsers have `maxLineLength` (8 MiB by default) and cost time in proportion to the length of a line, not to the number of chunks it arrives in.
  - An encrypted envelope authenticates its header (protocol version, session id, sequence number, key id): read one with the new `openEncryptedEnvelope` / `openEnvelope`. `decryptJson(payload)` no longer opens an envelope made by `createEncryptedEnvelope` / `createEnvelope`, so peers on mixed versions fail closed. Events of any size can be encrypted; `generateKeyPair` gives a private key that cannot be exported; a nonce counter beyond 32 bits and handshake parameters that are not implemented are refused. The key exchange is not authenticated, and no client or broker of this repository uses these primitives; the README says so.
- `@enclave-vm/react`: `EnclaveProvider` builds a new client when the values of its configuration change, so requests never go to a server or with credentials the current configuration does not name.
- `@enclave-vm/runtime`: the package does not execute scripts yet and now says so: `execute` rejects with `RuntimeNotImplementedError`, the channel gets a `final` event with `NOT_IMPLEMENTED`, no session is left behind, and the CLI exits with 1. `maxSessions` must be a positive integer, the default `host` is `127.0.0.1`, and a disconnected `WebSocketChannel` keeps at most 1,000 events.
- `@enclave-vm/browser`
  - Numeric limits must be finite numbers of 0 or more (`timeout` and `parentTimeoutBuffer` at most 2,147,483,647); `Infinity`, `NaN`, text and negative numbers throw a `TypeError` at construction. For "no limit" use `Number.MAX_SAFE_INTEGER`.
  - A custom global or tool namespace is the host's value under any name, also one that means something in the frame (`location`, `top`, `window`, …); names of the runtime (`__safe_*`, `__ag_*`, `__iter_*`, `__maxIterations`) throw a `TypeError`.
  - The frame documents run the two scripts this package wrote and no other, and open no connection, also with the validator off; with `validate: false` the document of the inner frame cannot be changed.
  - `doubleIframe.parentValidation.suspiciousPatterns` now take effect, evaluated on the host; an entry without `detect` throws. The built-in detectors cost time in proportion to the arguments.
  - The cumulative memory accounting cannot be switched off, and `padStart` / `padEnd` count toward `memoryLimit`.
  - The pre-scanner follows the AST preset, as in `@enclave-vm/core`: `BrowserEnclave` runs it on the script as it was written, with the pre-scanner preset named like `preset` (`agentscript` by default: 100 KB, 1,000 lines of at most 2,000 characters, no regular-expression literal, no bidirectional or invisible control character) and no longer with `standard`. New option `preScan: { preset?, config? }`; `preScan: { preset: 'standard' }` is the behaviour before.
  - The host prints and hands to tools only plain data it copied and measured. A script's own mistake in a tool call (a name over 256 characters, arguments nested over 100 levels) is an ordinary error, not a `PROTOCOL_VIOLATION`. New error code `SANDBOX_SETUP_FAILED`.
- Repository: `yarn test:security`, its CI job and `npx nx test <library>` cover the security specs of `broker`, `client`, `stream`, `react` and `runtime`.

## [2.19.0] - 2026-11-12

Draft for the maintainer. A security release of `@enclave-vm/core`, `@enclave-vm/ast` and `@enclave-vm/browser`: the sandbox boundary, the limits and the host process, each change with the test that pins it. See `SECURITY-TESTS.md` for the catalog and `libs/core/CHANGELOG.md` for the list of behaviour changes a host will notice.

### Repository

- The security tests moved out of this repository. Every suite that holds an attempt (the `ATK-*` suites and the other escape, bypass and exhaustion suites of `libs/ast`, `libs/core` and `libs/browser`), the per-test index and the attack write-ups of `libs/ast/docs` now live in a private repository, mounted here as the git submodule `security-tests`. `SECURITY-TESTS.md` keeps the public catalog of categories and invariants.
- With the submodule checked out, `yarn test`, `npx nx test <library>` and `npx nx test-e2e browser` run the public and the private suites; without it they run the public ones. `yarn test:security` runs the private ones alone.
- CI has a job "Security tests" that fetches the submodule with a read-only token and prints counts only, because its log is public.
- `npx nx test core` builds `core` first: its worker tests and the test of the worker entry point read the built package.
- `@enclave-vm/browser` has no changelog of its own: the host page no longer trusts its sandbox iframes (ATK-IFRAME in `SECURITY-TESTS.md`; see "Security Architecture" in the documentation of the package).
- `@enclave-vm/browser`: the host page refuses a tool call whose arguments hold more than 1,000,000 array items and object keys, and does not relay a console line whose size it cannot measure. A custom global that changes between a string and another kind of value after the enclave was created fails the run (`GLOBALS_CHANGED`): scripts are validated against what each global was then.

## 2026-01-09

Security-focused updates to enclave-vm plus a new AST Guard option for controlled Array.fill usage.

| Package    | Version | Highlights                                                                                    |
| ---------- | ------- | --------------------------------------------------------------------------------------------- |
| enclave-vm | 2.7.0   | Adds the JSON tool bridge, serialized size enforcement, and multiple security hardenings.     |
| ast-guard  | 2.4.0   | Adds the allowDynamicArrayFill option to the resource exhaustion rule and AgentScript preset. |

## 2026-01-08

Security-hardening release with stricter enclave VM sandboxing and new AST guards against JSON callback walkers.

| Package    | Version | Highlights                                                                                                                                      |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| enclave-vm | 2.6.0   | Introduced stack-trace sanitization controls, policy-violation reporting, and safer error/memory handling across single and double VM adapters. |
| ast-guard  | 2.3.0   | Added the JSON callback guard and expanded resource-exhaustion detection in the AgentScript preset.                                             |

## 2026-01-07

Security-focused release aligning enclave sandbox globals with AST guard while hardening regex analysis and namespace sanitization.

| Package    | Version | Highlights                                                                                     |
| ---------- | ------- | ---------------------------------------------------------------------------------------------- |
| enclave-vm | 2.5.0   | Sandbox now enforces security-level-specific globals and the double-VM bootstrap was hardened. |
| ast-guard  | 2.2.0   | Introduced security-level-aware AgentScript globals plus safer regex pre-scanning.             |

## 2026-01-06

Sandbox security was hardened in enclave-vm and ast-guard now blocks resource-exhaustion patterns by default.

| Package    | Version | Highlights                                                                                      |
| ---------- | ------- | ----------------------------------------------------------------------------------------------- |
| enclave-vm | 2.4.0   | Blocks Function/eval/Object.\* attacks and adds pre-allocation memory guards for all sandboxes. |
| ast-guard  | 2.1.0   | Ships the new ResourceExhaustionRule and enables it in the AgentScript preset.                  |

## 2026-01-06

Enhanced enclave-vm loop safety and scoring extensibility while ast-guard introduces guarded loop support requiring the new \_\_maxIterations runtime hook.

| Package    | Version | Highlights                                                                                                                                             |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| enclave-vm | 2.3.0   | Adds configurable rapid-enumeration thresholds, exposes the loop-iteration runtime hook, and allows custom analyzers in the local LLM scorer.          |
| ast-guard  | 2.0.0   | Transforms loops with iteration counters, requires runtimes to provide `__maxIterations`, and adds an InfiniteLoopRule for obvious endless constructs. |

## 2025-12-12

Transformer-dependent features now load Hugging Face models lazily with optional peer dependency.

| Package    | Version | Highlights                                                       |
| ---------- | ------- | ---------------------------------------------------------------- |
| enclave-vm | 1.0.2   | LocalLlmScorer lazy-loads transformers, optional peer dependency |

## 2025-12-11

Hardened ast-guard AgentScript preset with additional browser primitive blocks.

| Package   | Version | Highlights                                                      |
| --------- | ------- | --------------------------------------------------------------- |
| ast-guard | 1.1.0   | Blocks structuredClone/messaging APIs, queueMicrotask, import() |

## 2025-11-30

Initial release of the Enclave monorepo.

| Package    | Version | Highlights                                         |
| ---------- | ------- | -------------------------------------------------- |
| ast-guard  | 1.0.0   | AST-based JavaScript validator with CVE protection |
| enclave-vm | 1.0.0   | Secure AgentScript execution environment           |
