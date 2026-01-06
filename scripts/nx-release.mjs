/**
 * Nx Release script that integrates with Codex AI output.
 *
 * This script reads version decisions from Codex and uses Nx Release's
 * programmatic API to bump versions and sync dependencies.
 * Changelogs are generated from Codex output (not Nx).
 *
 * Usage:
 *   CODEX_OUTPUT=.codex-release/release-output.json node scripts/nx-release.mjs
 *
 * Options:
 *   DRY_RUN=true - Preview changes without applying them
 */

import { releaseVersion } from 'nx/release/index.js';
import fs from 'fs';
import path from 'path';

async function main() {
  const codexOutputPath = process.env.CODEX_OUTPUT;
  const dryRun = process.env.DRY_RUN === 'true';

  if (!codexOutputPath) {
    console.error('Error: CODEX_OUTPUT environment variable not set');
    process.exit(1);
  }

  if (!fs.existsSync(codexOutputPath)) {
    console.error(`Error: Codex output file not found: ${codexOutputPath}`);
    process.exit(1);
  }

  console.log(`Reading Codex output from: ${codexOutputPath}`);
  console.log(`Dry run: ${dryRun}`);

  let codexOutput;
  try {
    codexOutput = JSON.parse(fs.readFileSync(codexOutputPath, 'utf8'));
  } catch (err) {
    console.error(`Error: Failed to parse Codex output file: ${err.message}`);
    process.exit(1);
  }

  if (!codexOutput.projects || !Array.isArray(codexOutput.projects)) {
    console.error('Error: Codex output missing or invalid "projects" array');
    process.exit(1);
  }

  const versionResults = {};
  const today = new Date().toISOString().split('T')[0];

  // Filter projects that need a version bump
  const projectsToBump = codexOutput.projects.filter((p) => p.bump !== 'none');

  if (projectsToBump.length === 0) {
    console.log('No projects need version bumps');
    process.exit(0);
  }

  console.log(`\nProjects to bump: ${projectsToBump.map((p) => p.name).join(', ')}`);

  // ============================================================
  // PHASE 1: Bump all versions first (allows Nx to sync dependencies)
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 1: Version bumping');
  console.log('='.repeat(60));

  for (const project of projectsToBump) {
    console.log(`\nVersioning ${project.name} to ${project.newVersion} (${project.bump})`);
    console.log(`Reason: ${project.reason || 'N/A'}`);

    try {
      // Use Nx Release to bump version and sync dependencies
      // Git operations are disabled here - the workflow handles git commit/tag
      await releaseVersion({
        specifier: project.newVersion,
        projects: [project.name],
        dryRun,
        verbose: true,
        gitCommit: false,
        gitTag: false,
      });

      console.log(`✓ Version updated for ${project.name}`);
    } catch (error) {
      console.error(`✗ Failed to version ${project.name}:`, error.message);
      process.exit(1);
    }
  }

  // ============================================================
  // PHASE 2: Read final versions from package.json files
  // (Nx may have bumped versions due to dependency sync)
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2: Reading final versions from package.json');
  console.log('='.repeat(60));

  for (const project of projectsToBump) {
    const pkgPath = path.join('libs', project.name, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      versionResults[project.name] = pkg.version;

      if (pkg.version !== project.newVersion) {
        console.log(`⚠ ${project.name}: Codex specified ${project.newVersion}, but final version is ${pkg.version} (dependency sync)`);
      } else {
        console.log(`✓ ${project.name}: ${pkg.version}`);
      }
    } catch (err) {
      console.error(`⚠ Failed to read package.json for ${project.name}: ${err.message}`);
      versionResults[project.name] = project.newVersion;
    }
  }

  // ============================================================
  // PHASE 3: Write changelogs using FINAL versions
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 3: Writing changelogs with final versions');
  console.log('='.repeat(60));

  if (!dryRun) {
    for (const project of projectsToBump) {
      if (project.changelog) {
        const finalVersion = versionResults[project.name];
        try {
          const changelogPath = path.join('libs', project.name, 'CHANGELOG.md');
          if (fs.existsSync(changelogPath)) {
            const entry = formatChangelogEntry(finalVersion, project.changelog, today);
            if (entry) {
              let content = fs.readFileSync(changelogPath, 'utf8');
              const unreleasedIdx = content.indexOf('## [Unreleased]');
              if (unreleasedIdx !== -1) {
                const afterUnreleased = content.indexOf('\n', unreleasedIdx) + 1;
                content = content.slice(0, afterUnreleased) + '\n' + entry + '\n' + content.slice(afterUnreleased);
                fs.writeFileSync(changelogPath, content);
                console.log(`✓ Updated changelog: ${changelogPath} (version ${finalVersion})`);
              } else {
                console.log(`⚠ Skipped changelog update for ${project.name}: missing "## [Unreleased]" section`);
              }
            }
          }
        } catch (err) {
          console.error(`⚠ Failed to update changelog for ${project.name}: ${err.message}`);
        }
      }
    }

    // Update global changelog if provided
    if (codexOutput.globalChangelog) {
      updateGlobalChangelog(codexOutput.globalChangelog, versionResults, today);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Version results:');
  for (const [name, version] of Object.entries(versionResults)) {
    console.log(`  ${name}: ${version}`);
  }
  console.log('='.repeat(60));

  // Output JSON for CI consumption
  console.log('\n__VERSION_RESULTS_JSON__');
  console.log(JSON.stringify({ versionResults }));
}

function formatChangelogEntry(version, changelog, date) {
  const categories = [
    { key: 'added', title: 'Added' },
    { key: 'changed', title: 'Changed' },
    { key: 'deprecated', title: 'Deprecated' },
    { key: 'removed', title: 'Removed' },
    { key: 'fixed', title: 'Fixed' },
    { key: 'security', title: 'Security' },
  ];

  let entry = `## [${version}] - ${date}\n`;
  let hasContent = false;

  for (const { key, title } of categories) {
    const items = changelog[key] || [];
    if (items.length > 0) {
      entry += `\n### ${title}\n\n`;
      items.forEach((item) => (entry += `- ${item}\n`));
      hasContent = true;
    }
  }

  return hasContent ? entry : null;
}

function updateGlobalChangelog(globalChangelog, versionResults, date) {
  const globalPath = 'CHANGELOG.md';
  if (!fs.existsSync(globalPath)) {
    console.log('Global CHANGELOG.md not found, skipping');
    return;
  }

  const projects = globalChangelog.projects || [];
  if (projects.length === 0) return;

  try {
    let content = fs.readFileSync(globalPath, 'utf8');

    // Build date-based entry with package table
    let globalEntry = `## ${date}\n\n`;
    globalEntry += globalChangelog.summary + '\n\n';
    globalEntry += '| Package | Version | Highlights |\n';
    globalEntry += '|---------|---------|------------|\n';
    for (const p of projects) {
      globalEntry += `| ${p.name} | ${p.version} | ${p.summary} |\n`;
    }

    const unreleasedIdx = content.indexOf('## [Unreleased]');
    if (unreleasedIdx !== -1) {
      const afterUnreleased = content.indexOf('\n', unreleasedIdx) + 1;
      content = content.slice(0, afterUnreleased) + '\n' + globalEntry + '\n' + content.slice(afterUnreleased);
      fs.writeFileSync(globalPath, content);
      console.log('✓ Updated global changelog');
    }
  } catch (err) {
    console.error(`⚠ Failed to update global changelog: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
