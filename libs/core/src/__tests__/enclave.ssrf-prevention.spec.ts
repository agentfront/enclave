/**
 * SSRF (Server-Side Request Forgery) Prevention Tests
 *
 * Category: ATK-SSRF (Attack Vector Category 10)
 *
 * Tests protection against "Confused Deputy" attacks where user-controlled
 * code attempts to make requests to internal services, metadata endpoints,
 * or local filesystem via the tool handler.
 *
 * Defense layers:
 * 1. URL scheme validation (block file://, gopher://, etc.)
 * 2. Host validation (block localhost, 127.0.0.1, internal IPs)
 * 3. Operation name whitelisting in double VM
 * 4. Tool handler URL validation (application level)
 *
 * Test Categories:
 * - ATK-SSRF-01 to ATK-SSRF-05: Localhost/Loopback Blocking
 * - ATK-SSRF-06 to ATK-SSRF-07: File Protocol Blocking
 * - ATK-SSRF-08 to ATK-SSRF-09: Dangerous Protocol Blocking
 * - ATK-SSRF-10 to ATK-SSRF-13: Private IP Range Blocking
 * - ATK-SSRF-14 to ATK-SSRF-15: Cloud Metadata Endpoint Blocking
 * - ATK-SSRF-16 to ATK-SSRF-19: URL Obfuscation Bypass Prevention
 * - ATK-SSRF-20 to ATK-SSRF-21: Double VM Operation Filtering
 * - ATK-SSRF-22 to ATK-SSRF-24: Safe Request Patterns
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import type { ToolHandler } from '../types';

/**
 * Helper to create a tool handler that validates URLs for SSRF
 */
function createSSRFProtectedToolHandler(): {
  handler: ToolHandler;
  attemptedUrls: string[];
  blockedUrls: string[];
} {
  const attemptedUrls: string[] = [];
  const blockedUrls: string[] = [];

  // Patterns that should be blocked
  const blockedPatterns = [
    /^file:/i,
    /^gopher:/i,
    /^dict:/i,
    /^ftp:/i,
    /^ldap:/i,
    /^tftp:/i,
    /^data:/i,
    /^javascript:/i,
    /^vbscript:/i,
    /localhost/i,
    /127\.0\.0\.1/,
    /\[::1\]/,
    /0\.0\.0\.0/,
    /169\.254\.\d+\.\d+/, // Link-local
    /10\.\d+\.\d+\.\d+/, // Private Class A
    /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/, // Private Class B
    /192\.168\.\d+\.\d+/, // Private Class C
    /metadata\.google\.internal/i,
    /169\.254\.169\.254/, // AWS/GCP metadata
    /metadata\.azure\.com/i,
    /instance-data/i,
  ];

  const handler: ToolHandler = async (name, args) => {
    if (name === 'httpRequest' || name === 'fetch' || name === 'http:request') {
      const url = (args as { url?: string }).url;
      if (url) {
        attemptedUrls.push(url);

        // Check against blocked patterns
        for (const pattern of blockedPatterns) {
          if (pattern.test(url)) {
            blockedUrls.push(url);
            throw new Error(`SSRF attempt blocked: ${url}`);
          }
        }

        // Check for URL obfuscation attempts
        try {
          const parsed = new URL(url);
          // Re-check hostname after parsing (handles encoding tricks)
          // Note: URL.hostname returns '::1' without brackets for IPv6
          const hostname = parsed.hostname.toLowerCase();
          if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname === '0.0.0.0' ||
            hostname.endsWith('.internal') ||
            hostname.endsWith('.local')
          ) {
            blockedUrls.push(url);
            throw new Error(`SSRF attempt blocked (hostname): ${hostname}`);
          }
        } catch (e) {
          if ((e as Error).message.includes('SSRF')) {
            throw e;
          }
          // Invalid URL - block it
          blockedUrls.push(url);
          throw new Error(`SSRF attempt blocked (invalid URL): ${url}`);
        }

        return { success: true, data: `Mock response for ${url}` };
      }
    }

    return { success: true };
  };

  return { handler, attemptedUrls, blockedUrls };
}

describe('ATK-SSRF: SSRF Prevention', () => {
  // ============================================================================
  // ATK-SSRF-01 to ATK-SSRF-05: Localhost/Loopback Blocking
  // ============================================================================
  describe('ATK-SSRF-01 to ATK-SSRF-05: Localhost/Loopback Blocking', () => {
    it('ATK-SSRF-01: should block http://localhost requests', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'http://localhost' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      expect(blockedUrls).toContain('http://localhost');
      enclave.dispose();
    });

    it('ATK-SSRF-02: should block http://127.0.0.1 requests', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'http://127.0.0.1' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      expect(blockedUrls).toContain('http://127.0.0.1');
      enclave.dispose();
    });

    it('ATK-SSRF-03: should block http://127.0.0.1:PORT requests', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://127.0.0.1:8080' });
            results.push({ url: 'http://127.0.0.1:8080', blocked: false });
          } catch (e) {
            results.push({ url: 'http://127.0.0.1:8080', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://127.0.0.1:3000' });
            results.push({ url: 'http://127.0.0.1:3000', blocked: false });
          } catch (e) {
            results.push({ url: 'http://127.0.0.1:3000', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://127.0.0.1:6379' });
            results.push({ url: 'http://127.0.0.1:6379', blocked: false });
          } catch (e) {
            results.push({ url: 'http://127.0.0.1:6379', blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { url: string; blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });

    it('ATK-SSRF-04: should block IPv6 localhost [::1]', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'http://[::1]' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });

    it('ATK-SSRF-05: should block http://0.0.0.0 requests', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'http://0.0.0.0' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-06 to ATK-SSRF-07: File Protocol Blocking
  // ============================================================================
  describe('ATK-SSRF-06 to ATK-SSRF-07: File Protocol Blocking', () => {
    it('ATK-SSRF-06: should block file:///etc/passwd', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'file:///etc/passwd' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      expect(blockedUrls).toContain('file:///etc/passwd');
      enclave.dispose();
    });

    it('ATK-SSRF-07: should block various file:// paths', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'file:///etc/shadow' });
            results.push({ url: 'file:///etc/shadow', blocked: false });
          } catch (e) {
            results.push({ url: 'file:///etc/shadow', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'file:///proc/self/environ' });
            results.push({ url: 'file:///proc/self/environ', blocked: false });
          } catch (e) {
            results.push({ url: 'file:///proc/self/environ', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'FILE:///etc/passwd' });
            results.push({ url: 'FILE:///etc/passwd', blocked: false });
          } catch (e) {
            results.push({ url: 'FILE:///etc/passwd', blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { url: string; blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-08 to ATK-SSRF-09: Dangerous Protocol Blocking
  // ============================================================================
  describe('ATK-SSRF-08 to ATK-SSRF-09: Dangerous Protocol Blocking', () => {
    it('ATK-SSRF-08: should block gopher:// protocol', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'gopher://localhost:6379/_*1%0d%0a$4%0d%0aINFO%0d%0a' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });

    it('ATK-SSRF-09: should block various dangerous protocols', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'dict://localhost:11211/stat' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'ftp://localhost/etc/passwd' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'ldap://localhost:389/dc=example,dc=com' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-10 to ATK-SSRF-13: Private IP Range Blocking
  // ============================================================================
  describe('ATK-SSRF-10 to ATK-SSRF-13: Private IP Range Blocking', () => {
    it('ATK-SSRF-10: should block private Class A (10.x.x.x) IPs', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://10.0.0.1' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://10.255.255.255' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });

    it('ATK-SSRF-11: should block private Class B (172.16-31.x.x) IPs', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://172.16.0.1' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://172.31.255.255' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });

    it('ATK-SSRF-12: should block private Class C (192.168.x.x) IPs', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://192.168.0.1' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://192.168.1.1' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });

    it('ATK-SSRF-13: should block link-local (169.254.x.x) IPs', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://169.254.0.1' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://169.254.169.254' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-14 to ATK-SSRF-15: Cloud Metadata Endpoint Blocking
  // ============================================================================
  describe('ATK-SSRF-14 to ATK-SSRF-15: Cloud Metadata Endpoint Blocking', () => {
    it('ATK-SSRF-14: should block AWS metadata endpoint', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://169.254.169.254/latest/meta-data/' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });

    it('ATK-SSRF-15: should block GCP metadata endpoint', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://metadata.google.internal/computeMetadata/v1/' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' });
            results.push({ blocked: false });
          } catch (e) {
            results.push({ blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-16 to ATK-SSRF-19: URL Obfuscation Bypass Prevention
  // ============================================================================
  describe('ATK-SSRF-16 to ATK-SSRF-19: URL Obfuscation Bypass Prevention', () => {
    it('ATK-SSRF-16: should block decimal IP encoding (2130706433 = 127.0.0.1)', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            // 2130706433 = 127.0.0.1 in decimal
            const result = await callTool('httpRequest', { url: 'http://2130706433' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      // Should be blocked by URL parsing normalization
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });

    it('ATK-SSRF-17: should block hex IP encoding', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            // 0x7f000001 = 127.0.0.1 in hex
            const result = await callTool('httpRequest', { url: 'http://0x7f000001' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });

    it('ATK-SSRF-18: should block URL-encoded localhost', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            // %6c%6f%63%61%6c%68%6f%73%74 = localhost
            const result = await callTool('httpRequest', { url: 'http://%6c%6f%63%61%6c%68%6f%73%74' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      enclave.dispose();
    });

    it('ATK-SSRF-19: should block localhost with different TLDs', async () => {
      const { handler, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('httpRequest', { url: 'http://localhost.localdomain' });
            results.push({ url: 'localhost.localdomain', blocked: false });
          } catch (e) {
            results.push({ url: 'localhost.localdomain', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://test.localhost' });
            results.push({ url: 'test.localhost', blocked: false });
          } catch (e) {
            results.push({ url: 'test.localhost', blocked: true });
          }

          try {
            await callTool('httpRequest', { url: 'http://something.local' });
            results.push({ url: 'something.local', blocked: false });
          } catch (e) {
            results.push({ url: 'something.local', blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { url: string; blocked: boolean }[];
      // At least localhost variants should be blocked
      const localhostResult = results.find((r) => r.url.includes('localhost'));
      expect(localhostResult?.blocked).toBe(true);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-20 to ATK-SSRF-21: Double VM Operation Filtering
  // ============================================================================
  describe('ATK-SSRF-20 to ATK-SSRF-21: Double VM Operation Filtering', () => {
    it('ATK-SSRF-20: should block disallowed operation names', async () => {
      const calls: string[] = [];
      const toolHandler: ToolHandler = async (name, args) => {
        calls.push(name);
        return { success: true };
      };

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler,
        doubleVm: {
          parentValidation: {
            validateOperationNames: true,
            allowedOperationPattern: /^(db|api):[a-z]+$/i,
          },
        },
      });

      const code = `
        async function __ag_main() {
          try {
            // This should be blocked - doesn't match allowed pattern
            await callTool('httpRequest', { url: 'http://internal-service' });
            return { blocked: false };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(true);
      expect(calls).toEqual([]); // Never reached host
      enclave.dispose();
    });

    it('ATK-SSRF-21: should block blacklisted operation patterns', async () => {
      const calls: string[] = [];
      const toolHandler: ToolHandler = async (name, args) => {
        calls.push(name);
        return { success: true };
      };

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler,
        doubleVm: {
          parentValidation: {
            validateOperationNames: true,
            blockedOperationPatterns: [/^(shell|exec|system|spawn|http)/i],
          },
        },
      });

      // Note: callTool requires static string literals, so we test each individually
      const code = `
        async function __ag_main() {
          const results = [];

          try {
            await callTool('shell:exec', {});
            results.push({ op: 'shell:exec', blocked: false });
          } catch (e) {
            results.push({ op: 'shell:exec', blocked: true });
          }

          try {
            await callTool('exec:command', {});
            results.push({ op: 'exec:command', blocked: false });
          } catch (e) {
            results.push({ op: 'exec:command', blocked: true });
          }

          try {
            await callTool('httpRequest', {});
            results.push({ op: 'httpRequest', blocked: false });
          } catch (e) {
            results.push({ op: 'httpRequest', blocked: true });
          }

          return results;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const results = result.value as { op: string; blocked: boolean }[];
      results.forEach((r) => {
        expect(r.blocked).toBe(true);
      });
      expect(calls).toEqual([]);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-SSRF-22 to ATK-SSRF-24: Safe Request Patterns
  // ============================================================================
  describe('ATK-SSRF-22 to ATK-SSRF-24: Safe Request Patterns', () => {
    it('ATK-SSRF-22: should allow public HTTPS URLs', async () => {
      const { handler, attemptedUrls, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'https://api.example.com/data' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(false);
      expect(attemptedUrls).toContain('https://api.example.com/data');
      expect(blockedUrls).not.toContain('https://api.example.com/data');
      enclave.dispose();
    });

    it('ATK-SSRF-23: should allow public HTTP URLs', async () => {
      const { handler, attemptedUrls, blockedUrls } = createSSRFProtectedToolHandler();
      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler: handler,
      });

      const code = `
        async function __ag_main() {
          try {
            const result = await callTool('httpRequest', { url: 'http://public-api.example.org/v1/users' });
            return { blocked: false, result };
          } catch (e) {
            return { blocked: true, error: e.message };
          }
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect((result.value as { blocked: boolean }).blocked).toBe(false);
      enclave.dispose();
    });

    it('ATK-SSRF-24: should allow allowed operations through double VM', async () => {
      const calls: string[] = [];
      const toolHandler: ToolHandler = async (name, args) => {
        calls.push(name);
        return { success: true, data: 'result' };
      };

      const enclave = new Enclave({
        securityLevel: 'STANDARD',
        toolHandler,
        doubleVm: {
          parentValidation: {
            validateOperationNames: true,
            allowedOperationPattern: /^(db|api):[a-z]+$/i,
          },
        },
      });

      const code = `
        async function __ag_main() {
          const r1 = await callTool('db:query', { sql: 'SELECT 1' });
          const r2 = await callTool('api:get', { path: '/users' });
          return { r1, r2 };
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(calls).toEqual(['db:query', 'api:get']);
      enclave.dispose();
    });
  });
});
