/**
 * ResourceExhaustionRule — laundered dangerous-key static detection
 *
 * Covers the gap the reported PoC exploited: a dangerous property name built by a coercion and
 * stored in a variable (`const c = String.fromCharCode(...); obj[c]`) evades use-site static
 * analysis. The rule now tracks such bindings and flags their use as a computed key.
 */

import { JSAstValidator } from '../validator';
import { ResourceExhaustionRule } from '../rules';

function makeValidator(): JSAstValidator {
  return new JSAstValidator([new ResourceExhaustionRule()]);
}

const opts = { rules: { 'resource-exhaustion': true } };

describe('ResourceExhaustionRule — laundered dangerous computed keys', () => {
  it('flags String.fromCharCode-built "constructor" used as a computed key', async () => {
    const code = `
      const c = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
      const F = obj[c];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CONSTRUCTOR_ACCESS')).toBe(true);
  });

  it('flags concatenation-built "constructor" used as a computed key', async () => {
    const code = `
      const k = 'construc' + 'tor';
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CONSTRUCTOR_ACCESS')).toBe(true);
  });

  it('does NOT hard-fail on a laundered "__proto__" (left to the runtime membrane/guard)', async () => {
    // __proto__ is intentionally handled at runtime (soft per security level), not by this
    // validation-time rule, to preserve PERMISSIVE's lenient behaviour.
    const code = `
      const k = '__pro' + 'to__';
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(true);
  });

  it('flags [..].join("")-built "prototype" used as a computed key', async () => {
    const code = `
      const k = ['pro', 'to', 'type'].join('');
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CONSTRUCTOR_ACCESS')).toBe(true);
  });

  it('flags a reassignment (=) that launders a dangerous key', async () => {
    const code = `
      let k = 'safe';
      k = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CONSTRUCTOR_ACCESS')).toBe(true);
  });

  it('flags a single-element [..].toString()-built "constructor" used as a computed key', async () => {
    const code = `
      const k = ['constructor'].toString();
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CONSTRUCTOR_ACCESS')).toBe(true);
  });

  it('does NOT flag a multi-element [..].toString() (comma-joined at runtime, never "constructor")', async () => {
    // ['con','struc','tor'].toString() === 'con,struc,tor' at runtime, NOT 'constructor'.
    const code = `
      const k = ['con', 'struc', 'tor'].toString();
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(true);
  });

  it('does NOT flag a benign coerced key (no false positive)', async () => {
    const code = `
      const k = String.fromCharCode(104, 105);
      const out = obj[k];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(true);
  });

  it('does NOT flag ordinary variable-keyed access (no false positive)', async () => {
    const code = `
      const key = 'name';
      const arr = [1, 2, 3];
      let x = 0;
      x = arr[x];
      const out = obj[key];
    `;
    const result = await makeValidator().validate(code, opts);
    expect(result.valid).toBe(true);
  });
});
