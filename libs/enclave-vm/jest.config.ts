export default {
  displayName: 'enclave-vm',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],

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
