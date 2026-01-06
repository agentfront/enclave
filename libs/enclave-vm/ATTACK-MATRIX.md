# Enclave Security Attack Matrix

**Version:** 2.4.0
**Last Updated:** 2026-01-06
**Total Attack Vectors:** 500+
**Test Coverage:** 100%

## Overview

This document provides a comprehensive mapping of all security tests in the enclave-vm and ast-guard packages. Each test is categorized by:

- **ATK Prefix**: Attack category identifier
- **CWE**: Common Weakness Enumeration reference
- **CVE**: Common Vulnerabilities and Exposures (where applicable)

## ATK Category Reference

### CWE-Based Categories

| ATK Prefix    | CWE      | CWE Name                         | Description                                        |
| ------------- | -------- | -------------------------------- | -------------------------------------------------- |
| **ATK-CINJ**  | CWE-94   | Code Injection                   | eval, Function constructor, indirect eval          |
| **ATK-PPOL**  | CWE-1321 | Prototype Pollution              | `__proto__`, setPrototypeOf, constructor.prototype |
| **ATK-CESC**  | CWE-693  | Protection Mechanism Failure     | Sandbox escape, constructor chains                 |
| **ATK-RSRC**  | CWE-400  | Resource Exhaustion              | Memory bombs, CPU exhaustion, BigInt attacks       |
| **ATK-REDOS** | CWE-1333 | Inefficient Regex                | ReDoS, catastrophic backtracking                   |
| **ATK-SSRF**  | CWE-918  | Server-Side Request Forgery      | Internal network access, metadata endpoints        |
| **ATK-LOOP**  | CWE-835  | Infinite Loop                    | while(true), for(;;), recursion depth              |
| **ATK-ASYNC** | CWE-770  | Uncontrolled Resource Allocation | Promise bombs, microtask flooding                  |
| **ATK-IOFL**  | CWE-779  | Logging of Excessive Data        | Console flooding, output size limits               |
| **ATK-SRLZ**  | CWE-502  | Deserialization                  | Untrusted data, circular references                |
| **ATK-GLBL**  | CWE-749  | Exposed Dangerous Method         | process, require, global access                    |
| **ATK-UFMT**  | CWE-838  | Inappropriate Encoding           | Unicode homoglyphs, BiDi attacks                   |
| **ATK-REFL**  | CWE-470  | Unsafe Reflection                | Reflect API, Proxy abuse                           |
| **ATK-TIME**  | CWE-208  | Observable Timing Discrepancy    | Side-channel timing attacks                        |
| **ATK-SYMB**  | CWE-915  | Dynamic Object Modification      | Symbol-based attacks                               |
| **ATK-TOOL**  | CWE-284  | Improper Access Control          | Tool call security, operation filtering            |
| **ATK-COBS**  | CWE-693  | Constructor Obfuscation          | String building to bypass AST                      |
| **ATK-FGAD**  | CWE-693  | Function Gadgets                 | Primitive chain attacks                            |
| **ATK-RTME**  | CWE-693  | Runtime Attacks                  | AST-bypass runtime vectors                         |
| **ATK-DVM**   | CWE-284  | Double VM Security               | Parent VM validation                               |
| **ATK-ISOB**  | CWE-693  | Isolation Breakout               | WeakRef, ShadowRealm, debugger                     |

### CVE-Based Categories

| ATK Prefix             | CVE            | Product  | Description                               |
| ---------------------- | -------------- | -------- | ----------------------------------------- |
| **ATK-CVE-2023-29017** | CVE-2023-29017 | vm2      | Exception Handler Prototype Pollution     |
| **ATK-CVE-2023-30547** | CVE-2023-30547 | vm2      | AsyncFunction Constructor Escape          |
| **ATK-CVE-2023-32313** | CVE-2023-32313 | vm2      | Proxy + Reflect Bypass                    |
| **ATK-CVE-2023-37466** | CVE-2023-37466 | vm2      | Host Object Manipulation (WeakMap/Symbol) |
| **ATK-CVE-2021-42574** | CVE-2021-42574 | Multiple | Trojan Source (BiDi Unicode)              |
| **ATK-CVE-2019-11358** | CVE-2019-11358 | jQuery   | Prototype Pollution via $.extend          |
| **ATK-CVE-2021-23337** | CVE-2021-23337 | Lodash   | Prototype Pollution                       |

---

## Test File Mapping

### enclave-vm Package

#### ATK-REDOS: ReDoS Attack Prevention (CWE-1333)

**File:** `enclave.redos-attacks.spec.ts`
**Tests:** 23
**Status:** ✅ Reorganized

| Test ID      | Description                        | Defense Layer       |
| ------------ | ---------------------------------- | ------------------- |
| ATK-REDOS-01 | Block classic (x+x+)+y pattern     | PRESCANNER_REDOS    |
| ATK-REDOS-02 | Block nested quantifier (a+)+      | PRESCANNER_REDOS    |
| ATK-REDOS-03 | Block alternation overlap (a\|a)+  | PRESCANNER_REDOS    |
| ATK-REDOS-04 | Block polynomial ReDoS ([a-z]+)\*$ | PRESCANNER_REDOS    |
| ATK-REDOS-05 | Block email-style ReDoS            | PRESCANNER_REDOS    |
| ATK-REDOS-06 | Block regex on large strings       | NO_REGEX_LITERAL    |
| ATK-REDOS-07 | Block regex with many groups       | UNKNOWN_GLOBAL      |
| ATK-REDOS-08 | Block String.match() with regex    | PRESCANNER_REDOS    |
| ATK-REDOS-09 | Block String.replace() with regex  | PRESCANNER_REDOS    |
| ATK-REDOS-10 | Block String.split() with regex    | PRESCANNER_REDOS    |
| ATK-REDOS-11 | Block URL validation ReDoS         | NO_REGEX_LITERAL    |
| ATK-REDOS-12 | Block HTML tag ReDoS               | NO_REGEX_LITERAL    |
| ATK-REDOS-13 | Block IPv4 validation ReDoS        | NO_REGEX_LITERAL    |
| ATK-REDOS-14 | Block dynamic evil regex           | UNKNOWN_GLOBAL      |
| ATK-REDOS-15 | Block user-controlled pattern      | UNKNOWN_GLOBAL      |
| ATK-REDOS-16 | Block ALL regex literals           | NO_REGEX_LITERAL    |
| ATK-REDOS-17 | Block regex .test() calls          | NO_REGEX_LITERAL    |
| ATK-REDOS-18 | Block RegExp constructor           | UNKNOWN_GLOBAL      |
| ATK-REDOS-19 | Allow String.includes()            | ✅ Safe Alternative |
| ATK-REDOS-20 | Allow String.startsWith()          | ✅ Safe Alternative |
| ATK-REDOS-21 | Allow String.endsWith()            | ✅ Safe Alternative |
| ATK-REDOS-22 | Allow String.indexOf()             | ✅ Safe Alternative |
| ATK-REDOS-23 | Allow charCodeAt validation        | ✅ Safe Alternative |

#### ATK-ASYNC: Async/Promise Bomb Prevention (CWE-770)

**File:** `enclave.async-bomb-attacks.spec.ts`
**Tests:** 24
**Status:** ✅ Reorganized

| Test ID      | Description                       | Defense Layer   |
| ------------ | --------------------------------- | --------------- |
| ATK-ASYNC-01 | Block Promise constructor         | UNKNOWN_GLOBAL  |
| ATK-ASYNC-02 | Block Promise.resolve()           | UNKNOWN_GLOBAL  |
| ATK-ASYNC-03 | Block new Promise()               | UNKNOWN_GLOBAL  |
| ATK-ASYNC-04 | Block setTimeout                  | UNKNOWN_GLOBAL  |
| ATK-ASYNC-05 | Block setInterval                 | UNKNOWN_GLOBAL  |
| ATK-ASYNC-06 | Block queueMicrotask              | UNKNOWN_GLOBAL  |
| ATK-ASYNC-07 | Block setImmediate                | UNKNOWN_GLOBAL  |
| ATK-ASYNC-08 | Block process.nextTick            | UNKNOWN_GLOBAL  |
| ATK-ASYNC-09 | Block Promise.all() flood         | UNKNOWN_GLOBAL  |
| ATK-ASYNC-10 | Block Promise.race() flood        | UNKNOWN_GLOBAL  |
| ATK-ASYNC-11 | Block recursive promise chain     | UNKNOWN_GLOBAL  |
| ATK-ASYNC-12 | Block unresolved accumulation     | UNKNOWN_GLOBAL  |
| ATK-ASYNC-13 | Block queueMicrotask flood        | UNKNOWN_GLOBAL  |
| ATK-ASYNC-14 | Block .then() flooding            | UNKNOWN_GLOBAL  |
| ATK-ASYNC-15 | Block self-replicating microtasks | UNKNOWN_GLOBAL  |
| ATK-ASYNC-16 | Allow async function declaration  | ✅ Safe Pattern |
| ATK-ASYNC-17 | Allow sync ops in async           | ✅ Safe Pattern |
| ATK-ASYNC-18 | Allow callTool in async           | ✅ Safe Pattern |
| ATK-ASYNC-19 | Allow multiple await callTool     | ✅ Safe Pattern |
| ATK-ASYNC-20 | Handle generator functions        | VM Isolated     |
| ATK-ASYNC-21 | Protect infinite generator        | Iteration Limit |
| ATK-ASYNC-22 | Protect tight sync loops          | Iteration Limit |
| ATK-ASYNC-23 | Protect nested sync loops         | Iteration Limit |
| ATK-ASYNC-24 | Allow loops within limits         | ✅ Safe Pattern |

#### ATK-SSRF: SSRF Attack Prevention (CWE-918)

**File:** `enclave.ssrf-prevention.spec.ts`
**Tests:** 24
**Status:** ✅ Reorganized

| Test ID     | Description                 | Defense Layer       |
| ----------- | --------------------------- | ------------------- |
| ATK-SSRF-01 | Block localhost             | URL Validation      |
| ATK-SSRF-02 | Block 127.0.0.1             | URL Validation      |
| ATK-SSRF-03 | Block [::1] IPv6            | URL Validation      |
| ATK-SSRF-04 | Block localhost:port        | URL Validation      |
| ATK-SSRF-05 | Block 0.0.0.0               | URL Validation      |
| ATK-SSRF-06 | Block file:///etc/passwd    | URL Validation      |
| ATK-SSRF-07 | Block file:// paths         | URL Validation      |
| ATK-SSRF-08 | Block gopher://             | URL Validation      |
| ATK-SSRF-09 | Block dict/ldap/tftp        | URL Validation      |
| ATK-SSRF-10 | Block 10.x.x.x              | URL Validation      |
| ATK-SSRF-11 | Block 172.16-31.x.x         | URL Validation      |
| ATK-SSRF-12 | Block 192.168.x.x           | URL Validation      |
| ATK-SSRF-13 | Block 169.254.x.x           | URL Validation      |
| ATK-SSRF-14 | Block AWS metadata          | URL Validation      |
| ATK-SSRF-15 | Block GCP metadata          | URL Validation      |
| ATK-SSRF-16 | Block decimal IP encoding   | URL Validation      |
| ATK-SSRF-17 | Block hex IP encoding       | URL Validation      |
| ATK-SSRF-18 | Block URL-encoded localhost | URL Validation      |
| ATK-SSRF-19 | Block localhost TLDs        | URL Validation      |
| ATK-SSRF-20 | Block disallowed operations | Operation Whitelist |
| ATK-SSRF-21 | Block blacklisted patterns  | Operation Blacklist |
| ATK-SSRF-22 | Allow public HTTPS          | ✅ Safe Pattern     |
| ATK-SSRF-23 | Allow public HTTP           | ✅ Safe Pattern     |
| ATK-SSRF-24 | Allow whitelisted ops       | ✅ Safe Pattern     |

#### ATK-RSRC: Resource Exhaustion Prevention (CWE-400)

**File:** `resource-exhaustion.spec.ts`
**Tests:** ~30
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                        | Defense Layer       |
| ----------- | ---------------------------------- | ------------------- |
| ATK-RSRC-01 | Block large BigInt exponent        | AST BIGINT_EXPONENT |
| ATK-RSRC-02 | Block very large BigInt            | AST BIGINT_EXPONENT |
| ATK-RSRC-03 | Allow small BigInt                 | ✅ Safe Pattern     |
| ATK-RSRC-04 | Allow BigInt up to limit           | ✅ Safe Pattern     |
| ATK-RSRC-05 | Block while(true)                  | AST INFINITE_LOOP   |
| ATK-RSRC-06 | Block for(;;)                      | AST INFINITE_LOOP   |
| ATK-RSRC-07 | Block while(1)                     | AST INFINITE_LOOP   |
| ATK-RSRC-08 | Enforce for loop iteration limit   | Runtime             |
| ATK-RSRC-09 | Enforce while loop iteration limit | Runtime             |
| ATK-RSRC-10 | Enforce nested loop limits         | Runtime             |
| ATK-RSRC-11 | Enforce recursion depth limit      | Runtime             |
| ATK-RSRC-12 | Block large array allocation       | Runtime/Timeout     |
| ATK-RSRC-13 | Block string repeat bomb           | Runtime/Timeout     |
| ATK-RSRC-14 | Block JSON.parse bomb              | Runtime/Timeout     |
| ATK-RSRC-15 | Allow operations within limits     | ✅ Safe Pattern     |

#### ATK-IOFL: I/O Flood Prevention (CWE-779)

**File:** `enclave.io-flood.spec.ts`
**Tests:** ~15
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                | Defense Layer         |
| ----------- | -------------------------- | --------------------- |
| ATK-IOFL-01 | Limit console output bytes | maxConsoleOutputBytes |
| ATK-IOFL-02 | Track output across calls  | Cumulative Tracking   |
| ATK-IOFL-03 | Track across all methods   | log/warn/error/info   |
| ATK-IOFL-04 | Allow output within limits | ✅ Safe Pattern       |
| ATK-IOFL-05 | Limit console call count   | maxConsoleCalls       |
| ATK-IOFL-06 | Enforce rate limiting      | Rate Limiter          |

#### ATK-LOOP: Infinite Loop Prevention (CWE-835)

**File:** `enclave.infinite-loop-attacks.spec.ts`
**Tests:** ~50
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                      | Defense Layer     |
| ----------- | -------------------------------- | ----------------- |
| ATK-LOOP-01 | Block for(;;) at AST             | AST Validation    |
| ATK-LOOP-02 | Block for(;true;)                | AST Validation    |
| ATK-LOOP-03 | Block while(true)                | ForbiddenLoopRule |
| ATK-LOOP-04 | Block do-while(true)             | ForbiddenLoopRule |
| ATK-LOOP-05 | Handle array.push during for-of  | Iteration Limit   |
| ATK-LOOP-06 | Handle map callback modification | Iteration Limit   |
| ATK-LOOP-07 | Handle counter manipulation      | Iteration Limit   |
| ATK-LOOP-08 | Handle recursive getter          | Iteration Limit   |
| ATK-LOOP-09 | Handle circular toString         | Iteration Limit   |
| ATK-LOOP-10 | Block infinite generator         | Iteration Limit   |

#### ATK-COBS: Constructor Obfuscation (CWE-693)

**File:** `constructor-obfuscation-attacks.spec.ts`
**Tests:** ~40
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                          | Defense Layer  |
| ----------- | ------------------------------------ | -------------- |
| ATK-COBS-01 | Block string concat "con"+"structor" | SecureProxy    |
| ATK-COBS-02 | Block template literal building      | SecureProxy    |
| ATK-COBS-03 | Block Array.join building            | SecureProxy    |
| ATK-COBS-04 | Block String.fromCharCode            | SecureProxy    |
| ATK-COBS-05 | Block reverse string                 | SecureProxy    |
| ATK-COBS-06 | Block Base64 decode                  | SecureProxy    |
| ATK-COBS-07 | Block hex escape sequences           | SecureProxy    |
| ATK-COBS-08 | Block unicode escapes                | SecureProxy    |
| ATK-COBS-09 | Block computed property access       | AST Validation |

#### ATK-FGAD: Function Gadget Attacks (CWE-693)

**File:** `function-gadget-attacks.spec.ts`
**Tests:** ~50
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                     | Defense Layer |
| ----------- | ------------------------------- | ------------- |
| ATK-FGAD-01 | String.constructor.constructor  | VM Isolation  |
| ATK-FGAD-02 | Number.constructor.constructor  | VM Isolation  |
| ATK-FGAD-03 | Array.constructor.constructor   | VM Isolation  |
| ATK-FGAD-04 | Array.map callback injection    | VM Isolation  |
| ATK-FGAD-05 | Array.filter callback injection | VM Isolation  |
| ATK-FGAD-06 | valueOf coercion exploitation   | VM Isolation  |
| ATK-FGAD-07 | toString coercion exploitation  | VM Isolation  |
| ATK-FGAD-08 | Function.prototype.call         | VM Isolation  |
| ATK-FGAD-09 | Function.prototype.apply        | VM Isolation  |
| ATK-FGAD-10 | Tagged template attacks         | SecureProxy   |
| ATK-FGAD-11 | JSON.parse reviver attack       | VM Isolation  |
| ATK-FGAD-12 | Getter/setter attacks           | VM Isolation  |

#### ATK-CVE: Known CVE Exploits

**File:** `runtime-attack-vectors.spec.ts` (Category 5)
**Tests:** ~9
**Status:** 🔄 Pending Reorganization

| Test ID               | CVE            | Description               | Defense Layer  |
| --------------------- | -------------- | ------------------------- | -------------- |
| ATK-CVE-2023-29017-01 | CVE-2023-29017 | Exception handler escape  | VM Isolation   |
| ATK-CVE-2023-30547-01 | CVE-2023-30547 | AsyncFunction constructor | VM Isolation   |
| ATK-CVE-2023-32313-01 | CVE-2023-32313 | Proxy + Reflect bypass    | AST NO_REFLECT |
| ATK-CVE-2023-32313-02 | CVE-2023-32313 | Proxy.revocable escape    | AST NO_REFLECT |
| ATK-CVE-2023-37466-01 | CVE-2023-37466 | WeakMap host object       | AST Blocked    |
| ATK-CVE-2023-37466-02 | CVE-2023-37466 | Symbol.for escape         | AST Blocked    |

---

### ast-guard Package

#### ATK-UFMT: Unicode Security (CWE-838)

**File:** `unicode-security.spec.ts`
**Tests:** ~35
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                   | Defense Layer       |
| ----------- | ----------------------------- | ------------------- |
| ATK-UFMT-01 | Detect Cyrillic "а" homoglyph | UnicodeSecurityRule |
| ATK-UFMT-02 | Detect Cyrillic "е" homoglyph | UnicodeSecurityRule |
| ATK-UFMT-03 | Detect Greek "ο" homoglyph    | UnicodeSecurityRule |
| ATK-UFMT-04 | Detect fullwidth letters      | UnicodeSecurityRule |
| ATK-UFMT-05 | Detect BiDi RLO (U+202E)      | UnicodeSecurityRule |
| ATK-UFMT-06 | Detect BiDi LRO (U+202D)      | UnicodeSecurityRule |
| ATK-UFMT-07 | Detect ZWNJ in identifiers    | UnicodeSecurityRule |
| ATK-UFMT-08 | Detect ZWJ in identifiers     | UnicodeSecurityRule |
| ATK-UFMT-09 | Detect ZWSP in strings        | UnicodeSecurityRule |
| ATK-UFMT-10 | Detect BOM/ZWNBSP             | UnicodeSecurityRule |

#### ATK-ISOB: Isolation Breakout (CWE-693)

**File:** `isolation-breakout.spec.ts`
**Tests:** ~25
**Status:** 🔄 Pending Reorganization

| Test ID     | Description                   | Defense Layer        |
| ----------- | ----------------------------- | -------------------- |
| ATK-ISOB-01 | Block WeakRef constructor     | DisallowedIdentifier |
| ATK-ISOB-02 | Block FinalizationRegistry    | DisallowedIdentifier |
| ATK-ISOB-03 | Block ShadowRealm constructor | DisallowedIdentifier |
| ATK-ISOB-04 | Block Iterator constructor    | DisallowedIdentifier |
| ATK-ISOB-05 | Block Error.captureStackTrace | NoGlobalAccess       |
| ATK-ISOB-06 | Block Error.prepareStackTrace | NoGlobalAccess       |
| ATK-ISOB-07 | Block ArrayBuffer constructor | DisallowedIdentifier |
| ATK-ISOB-08 | Block SharedArrayBuffer       | DisallowedIdentifier |
| ATK-ISOB-09 | Block performance.now()       | DisallowedIdentifier |

---

## Defense Layer Summary

| Layer                       | Description                     | Implementation                              |
| --------------------------- | ------------------------------- | ------------------------------------------- |
| **L0: Pre-Scanner**         | Input validation before parsing | Size limits, nesting depth, ReDoS patterns  |
| **L1: AST Validation**      | Static code analysis            | Rules: NO_EVAL, NO_CONSTRUCTOR_ACCESS, etc. |
| **L2: Code Transformation** | Safe wrapper injection          | `__safe_for`, `__safe_callTool`, etc.       |
| **L3: AI Scoring Gate**     | Semantic analysis               | Risk scoring, exfiltration detection        |
| **L4: Runtime Sandbox**     | VM isolation + SecureProxy      | Node.js vm module, property traps           |
| **L5: Output Sanitization** | Result cleaning                 | Stack trace removal, path sanitization      |

---

## Quick Reference

### By CWE

```text
CWE-94  (Code Injection)     → ATK-CINJ-*
CWE-400 (Resource Exhaustion) → ATK-RSRC-*
CWE-502 (Deserialization)     → ATK-SRLZ-*
CWE-693 (Protection Failure)  → ATK-CESC-*, ATK-COBS-*, ATK-FGAD-*, ATK-ISOB-*
CWE-749 (Dangerous Method)    → ATK-GLBL-*
CWE-770 (Resource Allocation) → ATK-ASYNC-*
CWE-779 (Excessive Logging)   → ATK-IOFL-*
CWE-835 (Infinite Loop)       → ATK-LOOP-*
CWE-838 (Encoding Issues)     → ATK-UFMT-*
CWE-918 (SSRF)                → ATK-SSRF-*
CWE-1321 (Prototype Pollution) → ATK-PPOL-*
CWE-1333 (ReDoS)              → ATK-REDOS-*
```

### By CVE

```text
CVE-2023-29017 → ATK-CVE-2023-29017-* (vm2 exception handler)
CVE-2023-30547 → ATK-CVE-2023-30547-* (vm2 AsyncFunction)
CVE-2023-32313 → ATK-CVE-2023-32313-* (vm2 Proxy+Reflect)
CVE-2023-37466 → ATK-CVE-2023-37466-* (vm2 WeakMap/Symbol)
CVE-2021-42574 → ATK-CVE-2021-42574-* (Trojan Source)
```

---

## Running Tests

```bash
# Run all security tests
npx nx test enclave-vm

# Run specific category
npx nx test enclave-vm --testPathPatterns="enclave.redos-attacks"
npx nx test enclave-vm --testPathPatterns="enclave.async-bomb"
npx nx test enclave-vm --testPathPatterns="enclave.ssrf"

# Run by ATK prefix (after reorganization)
npx nx test enclave-vm --testNamePattern="ATK-RSRC"
npx nx test enclave-vm --testNamePattern="ATK-CVE"
```

---

## References

- [CWE Database](https://cwe.mitre.org/)
- [CVE Database](https://cve.mitre.org/)
- [OWASP Top 10](https://owasp.org/Top10/)
- [vm2 Deprecation Notice](https://github.com/patriksimek/vm2/issues/533)
