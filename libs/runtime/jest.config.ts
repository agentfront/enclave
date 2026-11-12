// The security specs of this library are not in this repository: they are in the private
// submodule `security-tests` (see SECURITY-TESTS.md). Where it is checked out they are part of
// this run; elsewhere the run has the public specs only.
// (`require`, not `import`: Jest loads this file as CommonJS, and an import would make Node load it as an ES module.)
const securitySpecs = require('node:path').join(__dirname, '../../security-tests/specs/runtime');
const hasSecuritySpecs = require('node:fs').existsSync(securitySpecs);

module.exports = {
  displayName: 'enclavejs-runtime',
  preset: '../../jest.preset.js',
  roots: ['<rootDir>/src', ...(hasSecuritySpecs ? [securitySpecs] : [])],
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/enclavejs-runtime',
};
