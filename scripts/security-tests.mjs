#!/usr/bin/env node
/**
 * Runs the security tests against this working tree.
 *
 * The tests are not in this repository. They live in a private one, which this repository includes
 * as the git submodule `security-tests`: scripts that try to leave the sandbox are kept out of
 * public view. Maintainers check it out with `git submodule update --init security-tests`.
 *
 *   yarn test-script [args]            the AgentScript case runner (`--help` lists its options)
 *   yarn test-script --suite           every case of the case suite
 *   yarn test:security                 everything: the case suite, the specs and the browser specs
 *   node scripts/security-tests.mjs --specs [ast|core ...] [-- <jest arguments>]
 *   node scripts/security-tests.mjs --e2e [-- <playwright arguments>]
 *
 *   --summary      print totals only (see below)
 *   --if-present   exit with 0 instead of 2 where the submodule is not checked out
 *   --fingerprint  print a hash of the specs (an Nx input, so a cached test run is not replayed
 *                  after the specs changed)
 *
 * --summary is for logs that are public, such as the CI of this repository. Nothing a test prints
 * reaches the output: every part runs as a child process whose output is discarded, and reports
 * through a result file (Jest, Playwright) or through one line of a fixed shape (the case suite).
 * What is printed is a count per part. No name, no script, no value, no path.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submodule = path.join(root, 'security-tests');
const launcher = path.join(submodule, 'test-script', 'index.mjs');
const specs = path.join(submodule, 'specs');
const scratch = path.join(root, 'tmp', 'security-tests');
const rootRequire = createRequire(path.join(root, 'package.json'));

/** Libraries whose security specs run under Jest, with the library's own Jest configuration. */
const JEST_LIBRARIES = ['ast', 'core'];
/** The Playwright project of libs/browser/playwright.config.ts that holds the browser specs. */
const BROWSER_PROJECT = 'chromium-security';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const own = separator < 0 ? argv : argv.slice(0, separator);
const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
const has = (name) => own.includes(name);

const summary = has('--summary');
const optional = has('--if-present');

function say(line) {
  process.stdout.write(`${line}\n`);
}

/** Runs a part as a child process. In summary mode nothing it writes reaches this process's output. */
function run(args, { cwd = root, env = {}, capture = false } = {}) {
  const quiet = summary || capture;
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  return { code: result.status ?? 1, stdout: quiet ? (result.stdout ?? '') : '' };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function resultFile(name) {
  mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, name);
  rmSync(file, { force: true });
  return file;
}

const HOW_TO_REPRODUCE =
  'Details are not written to this log. Run it locally with the private submodule checked out:\n' +
  '  git submodule update --init security-tests && yarn test:security';

// ---------------------------------------------------------------------------------------------
// The AgentScript case suite (security-tests/test-script)
// ---------------------------------------------------------------------------------------------

/** The one line the case runner prints with --summary: counts per verdict. */
const CASE_SUMMARY_LINE = /^security case suite: \d+ [A-Z][A-Z_-]*(?:, \d+ [A-Z][A-Z_-]*)* of \d+$/;

function runCases(args) {
  const result = run([launcher, ...args]);
  if (summary) {
    const line = result.stdout.split('\n').find((candidate) => CASE_SUMMARY_LINE.test(candidate));
    say(line ?? `security case suite: the run did not report its totals (exit code ${result.code})`);
    if (result.code === 0 && !line) return 1;
  }
  return result.code;
}

// ---------------------------------------------------------------------------------------------
// The specs (security-tests/specs/<library>), run by the library's Jest configuration
// ---------------------------------------------------------------------------------------------

function runSpecs(libraries) {
  let exitCode = 0;
  for (const library of libraries) {
    const directory = path.join(specs, library);
    const label = `security specs (${library})`;
    if (!JEST_LIBRARIES.includes(library) || !existsSync(directory)) {
      say(`${label}: there are no specs for this library`);
      exitCode = 1;
      continue;
    }
    const args = [
      rootRequire.resolve('jest/bin/jest'),
      '--config',
      path.join(root, 'libs', library, 'jest.config.ts'),
      // Only the private specs: the library's public ones run in `nx test <library>`.
      '--roots',
      directory,
    ];
    const report = summary ? resultFile(`specs-${library}.json`) : undefined;
    if (report) args.push('--json', '--outputFile', report, '--silent');
    const result = run([...args, ...forwarded], {
      cwd: path.join(root, 'libs', library),
      // What `nx test <library>` sets, for the TypeScript loader of jest.config.ts.
      env: {
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
          moduleResolution: 'node10',
          module: 'commonjs',
          customConditions: null,
        }),
      },
    });
    if (result.code !== 0) exitCode = 1;
    if (!report) continue;

    const json = readJson(report);
    if (!json || typeof json.numTotalTestSuites !== 'number') {
      say(`${label}: the run did not produce a result (exit code ${result.code})`);
      exitCode = 1;
    } else if (json.numTotalTestSuites === 0) {
      say(`${label}: no spec was found`);
      exitCode = 1;
    } else {
      // Jest counts a suite that could not be loaded among the failed ones.
      const failedSuites = json.numFailedTestSuites;
      say(
        `${label}: ${json.numPassedTestSuites} of ${json.numTotalTestSuites} suites passed` +
          (failedSuites > 0 ? `, ${failedSuites} failed` : '') +
          `; ${json.numTotalTests} tests: ${json.numPassedTests} passed, ${json.numFailedTests} failed, ` +
          `${json.numPendingTests + (json.numTodoTests ?? 0)} skipped`,
      );
      if (result.code === 0 && (failedSuites > 0 || json.numFailedTests > 0)) exitCode = 1;
    }
  }
  return exitCode;
}

// ---------------------------------------------------------------------------------------------
// The browser specs (security-tests/specs/browser), a project of the Playwright configuration
// ---------------------------------------------------------------------------------------------

function runBrowserSpecs() {
  const label = 'security browser specs';
  if (!existsSync(path.join(specs, 'browser'))) {
    say(`${label}: there are no browser specs`);
    return 1;
  }
  const args = [
    rootRequire.resolve('@playwright/test/cli'),
    'test',
    '--config',
    'playwright.config.ts',
    '--project',
    BROWSER_PROJECT,
  ];
  const env = {};
  const report = summary ? resultFile('specs-browser.json') : undefined;
  if (report) {
    // No trace, no report and no attachment is kept where the log is public.
    args.push('--reporter', 'json', '--trace', 'off', '--output', path.join(scratch, 'playwright-output'));
    env.PLAYWRIGHT_JSON_OUTPUT_FILE = report;
    env.PLAYWRIGHT_JSON_OUTPUT_NAME = report;
  }
  const result = run([...args, ...forwarded], { cwd: path.join(root, 'libs', 'browser'), env });
  if (!report) return result.code === 0 ? 0 : 1;

  const stats = readJson(report)?.stats;
  if (!stats || typeof stats.expected !== 'number') {
    say(`${label}: the run did not produce a result (exit code ${result.code})`);
    return 1;
  }
  const total = stats.expected + stats.unexpected + stats.flaky + stats.skipped;
  if (total === 0) {
    say(`${label}: no spec was found`);
    return 1;
  }
  say(
    `${label}: ${total} tests: ${stats.expected} passed, ${stats.unexpected} failed, ${stats.flaky} flaky, ${stats.skipped} skipped`,
  );
  return result.code === 0 && stats.unexpected === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------

/** A hash of every spec in the submodule, or `absent`. */
function fingerprint() {
  if (!existsSync(specs)) return 'absent';
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile())
        hash.update(path.relative(specs, file)).update('\0').update(readFileSync(file)).update('\0');
    }
  };
  walk(specs);
  return hash.digest('hex');
}

if (has('--fingerprint')) {
  say(fingerprint());
  process.exit(0);
}

if (!existsSync(launcher)) {
  console.error(
    'The security tests are not checked out.\n\n' +
      'They live in a private repository (agentfront/enclave-security-tests), included here as the\n' +
      'git submodule `security-tests`. With access to it:\n\n' +
      '  git submodule update --init security-tests\n',
  );
  process.exit(optional ? 0 : 2);
}

let exitCode;
if (has('--all')) {
  const parts = [runCases(['--suite', ...(summary ? ['--summary'] : [])]), runSpecs(JEST_LIBRARIES), runBrowserSpecs()];
  exitCode = parts.find((code) => code !== 0) ?? 0;
} else if (has('--specs')) {
  const named = own.filter((arg) => !arg.startsWith('--'));
  exitCode = runSpecs(named.length > 0 ? named : JEST_LIBRARIES);
} else if (has('--e2e')) {
  exitCode = runBrowserSpecs();
} else {
  // The case runner reads its own arguments (and knows --summary itself).
  exitCode = runCases(argv.filter((arg) => arg !== '--if-present'));
}

if (summary && exitCode !== 0) say(HOW_TO_REPRODUCE);
process.exit(exitCode);
