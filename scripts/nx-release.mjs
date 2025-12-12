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

import { releaseVersion } from 'nx/release';
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

  const codexOutput = JSON.parse(fs.readFileSync(codexOutputPath, 'utf8'));
  const versionResults = {};
  const today = new Date().toISOString().split('T')[0];

  // Filter projects that need a version bump
  const projectsToBump = codexOutput.projects.filter((p) => p.bump !== 'none');

  if (projectsToBump.length === 0) {
    console.log('No projects need version bumps');
    process.exit(0);
  }

  console.log(`\nProjects to bump: ${projectsToBump.map((p) => p.name).join(', ')}`);

  // Process each project that needs a version bump
  for (const project of projectsToBump) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Versioning ${project.name} to ${project.newVersion} (${project.bump})`);
    console.log(`Reason: ${project.reason || 'N/A'}`);
    console.log('='.repeat(60));

    try {
      // Use Nx Release to bump version and sync dependencies
      // Git operations are disabled here - the workflow handles git commit/tag
      const { projectsVersionData } = await releaseVersion({
        specifier: project.newVersion,
        projects: [project.name],
        dryRun,
        verbose: true,
        gitCommit: false,
        gitTag: false,
      });

      versionResults[project.name] = project.newVersion;
      console.log(`✓ Version updated for ${project.name}`);

      // Apply Codex-generated changelog (Nx doesn't handle this)
      if (project.changelog && !dryRun) {
        const changelogPath = path.join('libs', project.name, 'CHANGELOG.md');
        if (fs.existsSync(changelogPath)) {
          const entry = formatChangelogEntry(project.newVersion, project.changelog, today);
          if (entry) {
            let content = fs.readFileSync(changelogPath, 'utf8');
            const unreleasedIdx = content.indexOf('## [Unreleased]');
            if (unreleasedIdx !== -1) {
              const afterUnreleased = content.indexOf('\n', unreleasedIdx) + 1;
              content =
                content.slice(0, afterUnreleased) +
                '\n' +
                entry +
                '\n' +
                content.slice(afterUnreleased);
              fs.writeFileSync(changelogPath, content);
              console.log(`✓ Updated changelog: ${changelogPath}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`✗ Failed to version ${project.name}:`, error.message);
      process.exit(1);
    }
  }

  // Update global changelog if provided
  if (codexOutput.globalChangelog && !dryRun) {
    updateGlobalChangelog(codexOutput.globalChangelog, versionResults, today);
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

  const versions = Object.values(versionResults);
  if (versions.length === 0) return;

  // Find max version
  const maxVersion = versions.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
  )[0];

  let content = fs.readFileSync(globalPath, 'utf8');

  let globalEntry = `## [${maxVersion}] - ${date}\n\n`;
  globalEntry += globalChangelog.summary + '\n\n';
  globalEntry += '### Updated Libraries\n\n';
  for (const p of globalChangelog.projects || []) {
    globalEntry += `- **${p.name}** v${p.version} - ${p.summary}\n`;
  }

  const unreleasedIdx = content.indexOf('## [Unreleased]');
  if (unreleasedIdx !== -1) {
    const afterUnreleased = content.indexOf('\n', unreleasedIdx) + 1;
    content =
      content.slice(0, afterUnreleased) + '\n' + globalEntry + '\n' + content.slice(afterUnreleased);
    fs.writeFileSync(globalPath, content);
    console.log('✓ Updated global changelog');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
