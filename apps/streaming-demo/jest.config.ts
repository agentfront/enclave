module.exports = {
  displayName: 'streaming-demo',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        isolatedModules: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/streaming-demo',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.test.ts', '!src/**/index.ts'],
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json'],
  testTimeout: 30000, // Longer timeout for WebSocket tests
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$)', '<rootDir>/../../libs/.*/dist/'],
};
