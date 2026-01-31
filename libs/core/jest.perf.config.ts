export default {
  displayName: 'enclave-vm-perf',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],

  // Only run performance tests
  testMatch: ['<rootDir>/src/__tests__/perf/**/*.perf.spec.ts'],

  // Performance tests need longer timeout (2 minutes per test)
  testTimeout: 120000,

  // Note: Coverage is disabled by not configuring collectCoverage
  // (instrumentation affects performance measurements)

  // Run tests serially to avoid interference between benchmarks
  maxWorkers: 1,

  // Custom reporter for JSON output
  reporters: [
    'default',
    ['<rootDir>/src/__tests__/perf/utils/benchmark-reporter.ts', { outputFile: 'perf-results.json' }],
  ],

  // Setup file to clear metrics between runs
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/perf/setup.ts'],
};
