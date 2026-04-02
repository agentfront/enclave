#!/usr/bin/env node
/**
 * Sync all @enclave-vm/* package versions across the monorepo.
 *
 * Usage:
 *   node scripts/sync-versions.mjs <version>
 *
 * Updates:
 *   - "version" field in each libs/<name>/package.json
 *   - All @enclave-vm/<name> dependency references in libs and apps package.json files
 *
 * Idempotent: running when versions are already correct produces no changes.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@enclave-vm/';
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/sync-versions.mjs <version>');
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`Invalid version format: ${version}`);
    process.exit(1);
  }

  const packageJsonPaths = discoverPackageJsons();
  let totalUpdated = 0;

  for (const { filePath, isLib } of packageJsonPaths) {
    const updated = syncPackageJson(filePath, version, isLib);
    if (updated) totalUpdated++;
  }

  if (totalUpdated === 0) {
    console.log(`All versions already at ${version} — no changes needed.`);
  } else {
    console.log(`\nUpdated ${totalUpdated} file(s) to version ${version}.`);
    console.log('Run "yarn install" to update yarn.lock.');
  }
}

function discoverPackageJsons() {
  const results = [];
  for (const dir of ['libs', 'apps']) {
    const dirPath = join(ROOT, dir);
    if (!existsSync(dirPath)) continue;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(dirPath, entry.name, 'package.json');
      if (existsSync(pkgPath)) {
        results.push({ filePath: pkgPath, isLib: dir === 'libs' });
      }
    }
  }
  return results;
}

function syncPackageJson(filePath, version, isLib) {
  const raw = readFileSync(filePath, 'utf8');
  const pkg = JSON.parse(raw);
  let changed = false;

  // Update version field for lib packages only
  if (isLib && pkg.version !== version) {
    console.log(`  ${filePath}: version ${pkg.version} → ${version}`);
    pkg.version = version;
    changed = true;
  }

  // Update all @enclave-vm/* dependency references
  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) continue;
    for (const [name, current] of Object.entries(pkg[section])) {
      if (name.startsWith(SCOPE) && current !== version) {
        console.log(`  ${filePath}: ${section}.${name} ${current} → ${version}`);
        pkg[section][name] = version;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
  }

  return changed;
}

main();
