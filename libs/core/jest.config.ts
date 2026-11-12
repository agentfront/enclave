// The security specs of this library are not in this repository: they are in the private
// submodule `security-tests` (see SECURITY-TESTS.md). Where it is checked out they are part of
// this run; elsewhere the run has the public specs only.
// (`require`, not `import`: Jest loads this file as CommonJS, and an import would make Node load it as an ES module.)
const securitySpecs = require('node:path').join(__dirname, '../../security-tests/specs/core');
const hasSecuritySpecs = require('node:fs').existsSync(securitySpecs);

module.exports = {
  displayName: 'enclave-vm',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', ...(hasSecuritySpecs ? [securitySpecs] : [])],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],

  // The benchmarks under __tests__/perf are not part of this run: they assert timings, and here
  // they would share the machine with every other suite. They have a configuration of their own
  // that runs them one at a time (jest.perf.config.ts, `nx run core:test-perf`).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/__tests__/perf/'],

  // Coverage configuration
  coverageDirectory: '../../coverage/libs/enclave-vm',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
    '!src/**/index.ts', // Barrel exports
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    // Exclude files that are serialized and run inside VMs
    // Coverage instrumentation breaks these as the __cov functions don't exist in VM context
    '!src/double-vm/suspicious-patterns.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json'],
  // Coverage thresholds - set to current baseline, increase as coverage improves
  // Note: Some code (e.g., suspicious-patterns.ts) is serialized and runs in VM,
  // so it's not directly measurable by Jest coverage
  coverageThreshold: {
    global: {
      branches: 45,
      functions: 40,
      lines: 45,
      statements: 45,
    },
  },
};
