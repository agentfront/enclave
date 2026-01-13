#!/usr/bin/env node
/**
 * Enclave Runtime CLI
 *
 * Standalone runtime worker that can be deployed independently.
 *
 * Usage:
 *   npx enclave-runtime [options]
 *
 * Options:
 *   --port <port>          Port to listen on (default: 3001)
 *   --host <host>          Host to bind to (default: 0.0.0.0)
 *   --max-sessions <n>     Maximum concurrent sessions (default: 10)
 *   --debug                Enable debug logging
 *   --help                 Show help
 *
 * @packageDocumentation
 */

import { createRuntimeWorker } from './runtime-worker';
import type { RuntimeConfig } from './types';

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): RuntimeConfig {
  const config: RuntimeConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--port':
        config.port = parseInt(args[++i], 10);
        break;

      case '--host':
        config.host = args[++i];
        break;

      case '--max-sessions':
        config.maxSessions = parseInt(args[++i], 10);
        break;

      case '--debug':
        config.debug = true;
        break;

      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;

      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return config;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Enclave Runtime Worker

Usage:
  npx enclave-runtime [options]

Options:
  --port <port>          Port to listen on (default: 3001)
  --host <host>          Host to bind to (default: 0.0.0.0)
  --max-sessions <n>     Maximum concurrent sessions (default: 10)
  --debug                Enable debug logging
  --help, -h             Show this help message

Examples:
  npx enclave-runtime --port 3001
  npx enclave-runtime --port 8080 --max-sessions 20 --debug
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = parseArgs(args);

  console.log('Starting Enclave Runtime Worker...');
  console.log(`  Port: ${config.port ?? 3001}`);
  console.log(`  Host: ${config.host ?? '0.0.0.0'}`);
  console.log(`  Max Sessions: ${config.maxSessions ?? 10}`);
  console.log(`  Debug: ${config.debug ?? false}`);

  const worker = createRuntimeWorker(config);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await worker.stop();
    console.log('Runtime stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the worker
  await worker.start();

  console.log('Runtime worker is running');
  console.log(`  PID: ${process.pid}`);

  // Print stats periodically
  if (config.debug) {
    setInterval(() => {
      const stats = worker.getStats();
      console.log('Stats:', {
        activeSessions: stats.activeSessions,
        totalSessions: stats.totalSessions,
        uptimeMs: stats.uptimeMs,
        memoryMB: Math.round(stats.memoryUsage.heapUsed / 1024 / 1024),
      });
    }, 30000);
  }
}

// Run main
main().catch((error) => {
  console.error('Failed to start runtime:', error);
  process.exit(1);
});
