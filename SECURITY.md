# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

**⚠️ Please do NOT report security vulnerabilities through public GitHub issues.**

This project runs in production environments, and public disclosure of vulnerabilities before a fix is available could harm our users.

**Note:** Package name on npm is @enclave-vm/core (formerly enclave-vm).

### How to Report

Report security vulnerabilities via one of these private channels:

1. **GitHub Security Advisories** (preferred): Use the "Report a vulnerability" button in the Security tab of this repository
2. **Email**: david@frontegg.com (include "@enclave-vm/core" in subject)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 7 days
- **Status updates**: At least every 14 days
- **Resolution target**: Critical issues within 30 days

### Safe Harbor

We consider security research conducted in good faith to be authorized. We will not pursue legal action against researchers who:

- Act in good faith
- Avoid privacy violations and data destruction
- Do not exploit vulnerabilities beyond proof-of-concept
- Report findings promptly and privately

### Disclosure Policy

We follow coordinated disclosure. We will publicly acknowledge your contribution (unless you prefer anonymity) after a fix is released.

Key points:

1. Use GitHub Security Advisories - built-in private reporting, no email exposure
2. Clear "do not" statement - explicitly tell people not to use public issues
3. Response timeline commitments - sets expectations
4. Safe harbor - encourages researchers to report without fear of legal action


## Scope

### In scope (authorized testing targets)
- https://enclave.agentfront.dev (public demo / security testing sandbox)

### Out of scope
- Any other Frontegg/AgentFront environments, domains, APIs, or customer tenants not explicitly listed above
- Attempts to access other users’ data, accounts, or tenants
- Denial of Service (DoS), stress testing, or automated scanning that degrades availability

### Rules of engagement
- Use only test accounts/data you own or that we provide
- Avoid privacy violations and data destruction
- No persistence (no backdoors, no long-lived shells, no planting credentials)
- Keep proof-of-concept minimal: demonstrate impact without accessing sensitive files (e.g., avoid reading /etc/passwd)
