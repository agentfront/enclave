// The security specs of this library are not in this repository: they are in the private
// submodule `security-tests` (see SECURITY-TESTS.md). Where it is checked out they are part of
// this run; elsewhere the run has the public specs only.
// (`require`, not `import`: Jest loads this file as CommonJS, and an import would make Node load it as an ES module.)
const securitySpecs = require('node:path').join(__dirname, '../../security-tests/specs/ast');
const hasSecuritySpecs = require('node:fs').existsSync(securitySpecs);

module.exports = {
  displayName: 'ast-guard',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', ...(hasSecuritySpecs ? [securitySpecs] : [])],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.[tj]s$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2022',
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/ast-guard',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/src/index.ts', // Ignore index.ts (re-exports only, no logic to test)
  ],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/security-tests/specs/ast/**/*.spec.ts'],
  testTimeout: 60000,
};
