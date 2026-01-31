/**
 * ReDoS (Regular Expression Denial of Service) Attack Prevention Tests
 *
 * Category: ATK-REDOS (Attack Vector Category 8)
 *
 * Tests protection against CPU exhaustion via catastrophic backtracking
 * in regular expressions. The enclave implements BLANKET BLOCKING of all
 * regex literals and methods as a defense-in-depth strategy.
 *
 * Defense layers:
 * 1. AST-Level: NO_REGEX_LITERAL rule blocks all regex literals
 * 2. AST-Level: NO_REGEX_METHOD rule blocks .test(), .match(), etc.
 * 3. AST-Level: PRESCANNER_REDOS detects nested quantifiers
 * 4. Runtime: RegExp constructor not in allowed globals
 *
 * Test Categories:
 * - ATK-REDOS-01 to ATK-REDOS-05: AST-Level Blocking (Nested Quantifiers)
 * - ATK-REDOS-06 to ATK-REDOS-10: Large Input Processing
 * - ATK-REDOS-11 to ATK-REDOS-15: Real-World Vulnerable Patterns
 * - ATK-REDOS-16 to ATK-REDOS-18: Blanket Regex Blocking
 * - ATK-REDOS-19 to ATK-REDOS-23: Safe String Alternatives
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

describe('ATK-REDOS: ReDoS Attack Prevention', () => {
  // ============================================================================
  // ATK-REDOS-01 to ATK-REDOS-05: AST-Level Blocking (Nested Quantifiers)
  // These patterns are blocked at the AST level by the PRESCANNER_REDOS rule
  // ============================================================================
  describe('ATK-REDOS-01 to ATK-REDOS-05: AST-Level Blocking (Nested Quantifiers)', () => {
    it('ATK-REDOS-01: should block classic (x+x+)+y pattern at AST level', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Classic catastrophic backtracking pattern
        const result = /(x+x+)+y/.test("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        return result;
      `;
      const result = await enclave.run(code);

      // Should be blocked at AST level by PRESCANNER_REDOS
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/ReDoS|nested_quantifier|validation|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-02: should block nested quantifier (a+)+ pattern at AST level', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Nested quantifier attack
        const result = /(a+)+$/.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/ReDoS|nested_quantifier|validation|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-03: should block alternation with overlap (a|a)+', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Alternation with overlapping patterns
        const result = /(a|a)+$/.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/ReDoS|overlapping_alternation|validation|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-04: should block polynomial ReDoS ([a-z]+)*$', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Polynomial complexity attack
        const input = "a".repeat(50) + "!";
        const result = /([a-z]+)*$/.test(input);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/ReDoS|nested_quantifier|validation|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-05: should block email-style ReDoS pattern', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Common vulnerable email regex pattern
        const emailRegex = /^([a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*)+@/;
        const maliciousInput = "a".repeat(40) + "!";
        const result = emailRegex.test(maliciousInput);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/ReDoS|nested_quantifier|validation|regex.*not allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-REDOS-06 to ATK-REDOS-10: Large Input Processing
  // Tests that regex operations on large inputs are blocked
  // ============================================================================
  describe('ATK-REDOS-06 to ATK-REDOS-10: Large Input Processing', () => {
    it('ATK-REDOS-06: should block regex on very large strings', async () => {
      const enclave = new Enclave({ timeout: 2000, maxIterations: 100000 });
      const code = `
        // Large string with simple regex (linear time)
        const input = "a".repeat(1000000);
        const result = /a+/.test(input);
        return result;
      `;
      const result = await enclave.run(code);

      // Regex is blocked at AST level
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX/i);
      enclave.dispose();
    });

    it('ATK-REDOS-07: should block regex with many groups', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Many capturing groups
        const pattern = new RegExp("(" + "(a+)".repeat(20) + ")+");
        const input = "a".repeat(30) + "!";
        const result = pattern.test(input);
        return result;
      `;
      const result = await enclave.run(code);

      // RegExp constructor is blocked
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|RegExp|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-08: should block String.match() with regex', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        const input = "a".repeat(40) + "b";
        const result = input.match(/(a+)+$/);
        return !!result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|PRESCANNER_REDOS/i);
      enclave.dispose();
    });

    it('ATK-REDOS-09: should block String.replace() with regex', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        const input = "a".repeat(40) + "b";
        const result = input.replace(/(a+)+$/, "x");
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|PRESCANNER_REDOS/i);
      enclave.dispose();
    });

    it('ATK-REDOS-10: should block String.split() with regex', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        const input = "a".repeat(40) + "b";
        const result = input.split(/(a+)+$/);
        return result.length;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|PRESCANNER_REDOS/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-REDOS-11 to ATK-REDOS-15: Real-World Vulnerable Patterns
  // ============================================================================
  describe('ATK-REDOS-11 to ATK-REDOS-15: Real-World Vulnerable Patterns', () => {
    it('ATK-REDOS-11: should block URL validation ReDoS pattern', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Vulnerable URL regex pattern (real-world CVE)
        const urlRegex = /^(([a-z]+:\\/\\/)?([a-zA-Z0-9.-]+)(\\/[a-zA-Z0-9.-]*)*)*$/;
        const maliciousInput = "/".repeat(40) + "x";
        const result = urlRegex.test(maliciousInput);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|ReDoS/i);
      enclave.dispose();
    });

    it('ATK-REDOS-12: should block HTML tag ReDoS pattern', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Vulnerable HTML tag regex
        const tagRegex = /<([a-z]+)([^>]*)*(>|\\/>)/i;
        const maliciousInput = "<a " + "x".repeat(40) + "\\n";
        const result = tagRegex.test(maliciousInput);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|ReDoS/i);
      enclave.dispose();
    });

    it('ATK-REDOS-13: should block IPv4 validation ReDoS pattern', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Vulnerable IP regex pattern
        const ipRegex = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;
        const maliciousInput = "1".repeat(40);
        const result = ipRegex.test(maliciousInput);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex.*not allowed|NO_REGEX|ReDoS/i);
      enclave.dispose();
    });

    it('ATK-REDOS-14: should block dynamically constructed evil regex', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Dynamically build evil pattern
        const evilPattern = "(a+)+$";
        const regex = new RegExp(evilPattern);
        const input = "a".repeat(40) + "!";
        const result = regex.test(input);
        return result;
      `;
      const result = await enclave.run(code);

      // RegExp constructor is blocked
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|RegExp|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-15: should block regex with user-controlled pattern', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 10000 });
      const code = `
        // Simulating user-controlled regex pattern
        const userPattern = ".*".repeat(20);
        const regex = new RegExp(userPattern);
        const input = "a".repeat(100);
        const result = regex.test(input);
        return result;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|RegExp|not.*allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-REDOS-16 to ATK-REDOS-18: Blanket Regex Blocking
  // The enclave blocks ALL regex as blanket protection against ReDoS
  // ============================================================================
  describe('ATK-REDOS-16 to ATK-REDOS-18: Blanket Regex Blocking', () => {
    it('ATK-REDOS-16: should block ALL regex literals in default security mode', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        // Even simple regex literals are blocked
        const regex = /abc/;
        return regex.test("abc");
      `;
      const result = await enclave.run(code);

      // ALL regex is blocked as blanket protection
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/NO_REGEX_LITERAL|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-17: should block regex .test() method calls', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const regex = /simple/;
        return regex.test("simple");
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/NO_REGEX|regex.*not allowed/i);
      enclave.dispose();
    });

    it('ATK-REDOS-18: should block RegExp constructor access', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        return typeof RegExp;
      `;
      const result = await enclave.run(code);

      // RegExp is not in allowed globals
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|not.*allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-REDOS-19 to ATK-REDOS-23: Safe String Alternatives
  // String methods work as safe regex replacements
  // ============================================================================
  describe('ATK-REDOS-19 to ATK-REDOS-23: Safe String Alternatives', () => {
    it('ATK-REDOS-19: should allow String.includes() for pattern matching', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const email = "test@example.com";
        const hasAt = email.includes("@");
        const hasDot = email.includes(".");
        return hasAt && hasDot;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
      enclave.dispose();
    });

    it('ATK-REDOS-20: should allow String.startsWith() for URL validation', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const url = "https://example.com/path";
        const isValid = url.startsWith("https://") || url.startsWith("http://");
        return isValid;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
      enclave.dispose();
    });

    it('ATK-REDOS-21: should allow String.endsWith() for extension checking', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const filename = "document.pdf";
        const isPdf = filename.endsWith(".pdf");
        return isPdf;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
      enclave.dispose();
    });

    it('ATK-REDOS-22: should allow String.indexOf() for pattern location', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const text = "Hello World";
        const hasWorld = text.indexOf("World") !== -1;
        return hasWorld;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
      enclave.dispose();
    });

    it('ATK-REDOS-23: should allow character code validation for digits', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 100 });
      const code = `
        const str = "12345";
        let allDigits = true;
        for (let i = 0; i < str.length; i++) {
          const charCode = str.charCodeAt(i);
          if (charCode < 48 || charCode > 57) {
            allDigits = false;
          }
        }
        return allDigits && str.length > 0;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
      enclave.dispose();
    });
  });
});
