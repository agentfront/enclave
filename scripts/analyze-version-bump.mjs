#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Analyze git changes to determine semantic version bump type
 *
 * Usage: node scripts/analyze-version-bump.mjs <project-name> [base-ref]
 * Example: node scripts/analyze-version-bump.mjs ast-guard v1.0.0
 *
 * If base-ref is not provided, uses the latest tag or first commit.
 *
 * Returns: major | minor | patch
 */

const [, , projectName, baseRefArg] = process.argv;

if (!projectName) {
  console.error("Usage: node scripts/analyze-version-bump.mjs <project-name> [base-ref]");
  console.error("Example: node scripts/analyze-version-bump.mjs ast-guard v1.0.0");
  process.exit(1);
}

/**
 * Get the base reference for comparison
 * @returns {string} Git reference (tag or commit SHA)
 */
function getBaseRef() {
  if (baseRefArg) {
    return baseRefArg;
  }

  // Try to find the latest tag for this project
  try {
    const projectTag = execSync(`git tag --list "${projectName}@*" --sort=-version:refname`, {
      encoding: "utf8",
    }).trim();

    if (projectTag) {
      const firstTag = projectTag.split("\n")[0];
      console.error(`Using project tag: ${firstTag}`);
      return firstTag;
    }
  } catch {
    // No project-specific tags found
  }

  // Try global version tags
  try {
    const globalTag = execSync('git tag --list "v*" --sort=-version:refname', {
      encoding: "utf8",
    }).trim();

    if (globalTag) {
      const firstTag = globalTag.split("\n")[0];
      console.error(`Using global tag: ${firstTag}`);
      return firstTag;
    }
  } catch {
    // No global tags found
  }

  // Fall back to first commit (initial release)
  const firstCommit = execSync("git rev-list --max-parents=0 HEAD", {
    encoding: "utf8",
  }).trim();

  console.error(`No tags found, using first commit: ${firstCommit.slice(0, 8)}`);
  return firstCommit;
}

/**
 * Get changed files for a project since base ref
 * @param {string} projectPath - Path to the project
 * @param {string} baseRef - Git reference to compare against
 * @returns {Object} Object with arrays of changed files by type
 */
function getChangedFiles(projectPath, baseRef) {
  const changes = {
    deleted: [],
    added: [],
    modified: [],
    renamed: [],
  };

  try {
    const diff = execSync(`git diff --name-status ${baseRef}..HEAD -- ${projectPath}`, {
      encoding: "utf8",
    }).trim();

    if (!diff) {
      return changes;
    }

    for (const line of diff.split("\n")) {
      if (!line.trim()) continue;

      const [status, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t"); // Handle files with tabs in names

      // Handle rename status (R100, R095, etc.)
      if (status.startsWith("R")) {
        changes.renamed.push(file);
      } else if (status === "D") {
        changes.deleted.push(file);
      } else if (status === "A") {
        changes.added.push(file);
      } else if (status === "M") {
        changes.modified.push(file);
      }
    }
  } catch (error) {
    console.error(`Error getting diff: ${error.message}`);
  }

  return changes;
}

/**
 * Check if a file is a source file (not test, doc, or config)
 * @param {string} file - File path
 * @returns {boolean}
 */
function isSourceFile(file) {
  // Source files are in src/ but not in __tests__
  if (!file.includes("/src/")) return false;
  if (file.includes("/__tests__/")) return false;
  if (file.includes(".spec.")) return false;
  if (file.includes(".test.")) return false;
  return true;
}

/**
 * Check if a file is an index/export file
 * @param {string} file - File path
 * @returns {boolean}
 */
function isExportFile(file) {
  const basename = path.basename(file);
  return basename === "index.ts" || basename === "index.js";
}

/**
 * Analyze changes and determine version bump type
 * @param {Object} changes - Changed files by type
 * @returns {string} major | minor | patch
 */
function analyzeChanges(changes) {
  const allChanges = [
    ...changes.deleted,
    ...changes.added,
    ...changes.modified,
    ...changes.renamed,
  ];

  if (allChanges.length === 0) {
    console.error("No changes detected");
    return "patch";
  }

  console.error(`Analyzing ${allChanges.length} changed files...`);

  // Check for deleted source files (breaking change)
  const deletedSourceFiles = changes.deleted.filter(isSourceFile);
  if (deletedSourceFiles.length > 0) {
    console.error(`Found ${deletedSourceFiles.length} deleted source files - MAJOR`);
    console.error(`  ${deletedSourceFiles.slice(0, 3).join("\n  ")}`);
    return "major";
  }

  // Check for renamed source files (potentially breaking)
  const renamedSourceFiles = changes.renamed.filter((f) => {
    const parts = f.split("\t");
    return parts.some(isSourceFile);
  });
  if (renamedSourceFiles.length > 0) {
    console.error(`Found ${renamedSourceFiles.length} renamed source files - MAJOR`);
    return "major";
  }

  // Check for modified index/export files (could be breaking or new features)
  const modifiedExportFiles = changes.modified.filter(isExportFile);
  if (modifiedExportFiles.length > 0) {
    // Modified exports could be breaking - treat as minor to be safe
    // A proper implementation would parse the exports and compare
    console.error(`Found ${modifiedExportFiles.length} modified export files - MINOR`);
    return "minor";
  }

  // Check for new source files (new feature)
  const newSourceFiles = changes.added.filter(isSourceFile);
  if (newSourceFiles.length > 0) {
    console.error(`Found ${newSourceFiles.length} new source files - MINOR`);
    console.error(`  ${newSourceFiles.slice(0, 3).join("\n  ")}`);
    return "minor";
  }

  // Check for package.json changes (dependency updates)
  const packageJsonChanged = allChanges.some((f) => f.endsWith("package.json"));
  if (packageJsonChanged) {
    console.error("package.json changed - MINOR");
    return "minor";
  }

  // Check for any source file modifications
  const modifiedSourceFiles = changes.modified.filter(isSourceFile);
  if (modifiedSourceFiles.length > 0) {
    console.error(`Found ${modifiedSourceFiles.length} modified source files - PATCH`);
    return "patch";
  }

  // Only non-source changes (docs, tests, configs)
  console.error("Only non-source changes detected - PATCH");
  return "patch";
}

/**
 * Set version for a project (used for first release)
 * @param {string} projectName - Name of the project
 * @param {string} version - Version to set
 */
async function setVersion(projectName, version) {
  const packagePath = path.join(process.cwd(), "libs", projectName, "package.json");

  try {
    const content = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(content);
    const oldVersion = pkg.version;
    pkg.version = version;
    await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.error(`Set ${projectName} version: ${oldVersion} → ${version}`);
  } catch (error) {
    console.error(`Error setting version: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Bump version for a project
 * @param {string} projectName - Name of the project
 * @param {string} bumpType - major | minor | patch
 */
async function bumpVersion(projectName, bumpType) {
  const packagePath = path.join(process.cwd(), "libs", projectName, "package.json");

  try {
    const content = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(content);
    const oldVersion = pkg.version || "0.0.0";
    const [major, minor, patch] = oldVersion.split(".").map(Number);

    let newVersion;
    switch (bumpType) {
      case "major":
        newVersion = `${major + 1}.0.0`;
        break;
      case "minor":
        newVersion = `${major}.${minor + 1}.0`;
        break;
      case "patch":
      default:
        newVersion = `${major}.${minor}.${patch + 1}`;
        break;
    }

    pkg.version = newVersion;
    await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.error(`Bumped ${projectName}: ${oldVersion} → ${newVersion} (${bumpType})`);

    // Output new version for CI
    console.log(newVersion);
  } catch (error) {
    console.error(`Error bumping version: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Check if this is the first release (no prior tags)
 * @returns {boolean}
 */
function isFirstRelease() {
  try {
    // Check for any project-specific or global tags
    const projectTags = execSync(`git tag --list "${projectName}@*"`, { encoding: "utf8" }).trim();
    const globalTags = execSync('git tag --list "v*"', { encoding: "utf8" }).trim();

    return !projectTags && !globalTags;
  } catch {
    return true;
  }
}

async function main() {
  const projectPath = `libs/${projectName}`;

  // Verify project exists
  try {
    await fs.access(path.join(process.cwd(), projectPath));
  } catch {
    console.error(`Project not found: ${projectPath}`);
    process.exit(1);
  }

  // Check for first release
  if (isFirstRelease()) {
    console.error("First release detected - setting version to 1.0.0");
    await setVersion(projectName, "1.0.0");
    console.log("1.0.0");
    return;
  }

  const baseRef = getBaseRef();
  console.error(`Base ref: ${baseRef}`);

  const changes = getChangedFiles(projectPath, baseRef);

  const totalChanges =
    changes.deleted.length + changes.added.length + changes.modified.length + changes.renamed.length;

  if (totalChanges === 0) {
    console.error("No changes detected for this project");
    // Still output current version
    const packagePath = path.join(process.cwd(), projectPath, "package.json");
    const content = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(content);
    console.log(pkg.version || "0.0.0");
    return;
  }

  const bumpType = analyzeChanges(changes);
  await bumpVersion(projectName, bumpType);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
