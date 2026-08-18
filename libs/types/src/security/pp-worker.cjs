'use strict';

// Runs the untrusted invocations in a throwaway process; the parent reads only a verdict.
// Requires the built dist (run `nx build types` first) so require() resolves the published CJS.
const enclaveTypes = require('@enclave-vm/types');

function prototypeHasOwn(propertyName) {
  return Object.prototype.hasOwnProperty.call(Object.prototype, propertyName);
}

function runResearcherPoc() {
  const accessorChains = ['BaseEventSchema._zod.constr', 'CallIdSchema._zod.constr'];
  for (const accessorChain of accessorChains) {
    try {
      const props = accessorChain.split('.').filter(Boolean);
      let current = enclaveTypes;
      let parent = null;
      for (const prop of props) {
        parent = current;
        if (current && current[prop] !== undefined) current = current[prop];
        else if (current && current.default && current.default[prop] !== undefined) current = current.default[prop];
      }
      if (typeof current === 'function') current.apply(parent, [{ '__proto__.ppBullseye': '123' }]);
    } catch {
      // Swallowed exactly as the researcher PoC does; prototype state is the only signal.
    }
  }
  return {
    pollutedCheck: prototypeHasOwn('check'),
    pollutedRegex: prototypeHasOwn('regex'),
    pollutedBullseye: prototypeHasOwn('ppBullseye'),
  };
}

function runCorrectedHypothesis() {
  try {
    enclaveTypes.BaseEventSchema.safeParse(JSON.parse('{"__proto__":{"pollutedRecord":true},"seq":0}'));
  } catch {
    // Validation failures are irrelevant; we assert only on prototype state.
  }
  try {
    const partialResultEvent = JSON.parse(
      '{"type":"partial_result","path":["__proto__","pollutedPath"],"data":{"x":1}}',
    );
    if (typeof enclaveTypes.parseStreamEvent === 'function') enclaveTypes.parseStreamEvent(partialResultEvent);
  } catch {
    // As above: only prototype state matters here.
  }
  return {
    pollutedRecord: prototypeHasOwn('pollutedRecord'),
    pollutedPath: prototypeHasOwn('pollutedPath'),
  };
}

const mode = process.argv[2];
const verdict = mode === 'researcher' ? runResearcherPoc() : runCorrectedHypothesis();
process.send(verdict);
process.exit(0);
