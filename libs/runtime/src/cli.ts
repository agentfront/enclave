#!/usr/bin/env node
/**
 * Enclave Runtime CLI
 *
 * A standalone runtime worker is not implemented: `@enclave-vm/runtime` does not execute code
 * and starts no server. This program checks its arguments, says so, and exits with an error,
 * so that nothing takes it for a running service.
 *
 * Usage:
 *   npx enclave-runtime [options]
 *
 * Options:
 *   --port <port>          Reserved (nothing listens)
 *   --host <host>          Reserved (nothing listens)
 *   --max-sessions <n>     Reserved
 *   --debug                Reserved
 *   --help                 Show help
 *
 * @packageDocumentation
 */

import type { RuntimeConfig } from './types';

/**
 * Exit code of a run that did what was asked.
 */
const EXIT_OK = 0;

/**
 * Exit code for wrong arguments, and for the fact that there is nothing to start.
 */
const EXIT_ERROR = 1;

const NOT_IMPLEMENTED =
  'enclave-runtime: not implemented. @enclave-vm/runtime does not execute code and does not ' +
  'listen on a port, so there is no worker to start.\n' +
  'Run scripts with @enclave-vm/broker (sessions, tools and streaming over HTTP) or ' +
  '@enclave-vm/core (the sandbox).';

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_ERROR);
}

/**
 * The value of an option that takes one
 */
function valueOf(option: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    fail(`Option ${option} needs a value`);
  }
  return value;
}

/**
 * An option value that has to be a whole number of at least `minimum`
 */
function integerOf(option: string, value: string | undefined, minimum: number): number {
  const text = valueOf(option, value);
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`Option ${option} needs a whole number of ${minimum} or more, got "${text}"`);
  }
  return parsed;
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): RuntimeConfig {
  const config: RuntimeConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--port':
        config.port = integerOf(arg, args[++i], 0);
        break;

      case '--host':
        config.host = valueOf(arg, args[++i]);
        break;

      case '--max-sessions':
        config.maxSessions = integerOf(arg, args[++i], 1);
        break;

      case '--debug':
        config.debug = true;
        break;

      case '--help':
      case '-h':
        printHelp();
        process.exit(EXIT_OK);
        break;

      default:
        fail(`Unknown option: ${arg}`);
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

${NOT_IMPLEMENTED}

Usage:
  npx enclave-runtime [options]

Options (accepted and checked; none of them starts anything):
  --port <port>          Reserved (nothing listens)
  --host <host>          Reserved (nothing listens)
  --max-sessions <n>     Reserved
  --debug                Reserved
  --help, -h             Show this help message
`);
}

/**
 * Main entry point
 */
function main(): void {
  parseArgs(process.argv.slice(2));

  fail(NOT_IMPLEMENTED);
}

main();
