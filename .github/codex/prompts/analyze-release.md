# Analyze Release

Analyze the git diff for the affected libraries, determine semantic version bumps, generate changelog entries, and update documentation.

## Context

You are analyzing code changes in an Nx monorepo. The affected projects are provided via the `AFFECTED_PROJECTS` environment variable (comma-separated list). The base reference for comparison is in `BASE_REF`. If `IS_FIRST_RELEASE` is "true", this is the first release and all projects should be set to version `1.0.0`.

---

## Part 1: Version Bump Analysis

### Rules for Version Bumping

#### MAJOR (breaking change)

Use major bump when:

- Public exports are removed or renamed
- Function signatures change (parameters added/removed as required, return types changed)
- Public APIs are removed or renamed
- Breaking changes to configuration or behavior
- Incompatible changes to data structures or interfaces

#### MINOR (new feature)

Use minor bump when:

- New public exports or functions are added
- New files in `src/` directory (excluding tests)
- New optional parameters added to existing functions
- New configuration options added
- Backward-compatible functionality additions

#### PATCH (bug fix)

Use patch bump when:

- Bug fixes that don't change the API
- Documentation changes only
- Test changes only
- Internal refactoring with no API changes
- Dependency updates (non-breaking)
- Performance improvements without API changes

### Version Analysis Instructions

1. For each project in `AFFECTED_PROJECTS`:

   - Read the project's current `package.json` to get the current version
   - Analyze the git diff for files in `libs/{project}/`
   - Focus on changes to `src/` files (ignore tests, docs, configs)
   - Determine if changes are breaking (major), feature additions (minor), or fixes (patch)
   - Calculate the new version based on the bump type

2. If `IS_FIRST_RELEASE` is "true":

   - Set all projects to version `1.0.0`
   - Use reason: "Initial release"

3. If no meaningful changes are detected for a project:
   - Use `bump: "none"` to skip that project

---

## Part 2: Changelog Generation

Generate changelog entries following the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

### Changelog Structure

Each library has its own changelog at `libs/{project}/CHANGELOG.md`, plus there's a global changelog at `CHANGELOG.md` in the repo root.

### Changelog Categories

Use these categories (only include categories that have entries):

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Vulnerability fixes

### Changelog Instructions

1. For each project with a version bump:

   - Generate changelog entries based on the actual code changes
   - Be specific about what changed (function names, behaviors, etc.)
   - Group entries by category

2. For the global changelog:
   - Include a summary entry for each bumped project
   - Reference the project name and version

---

## Part 3: Documentation Updates

Update the Mintlify documentation based on the code changes in this release. Documentation lives in the `/docs` directory and uses Mintlify format.

### Documentation Instructions

1. **Review Changed Code**

   - For each project in `AFFECTED_PROJECTS`, examine the changes in `libs/{project}/src/`
   - Identify new exports, changed APIs, removed functionality
   - Note any configuration changes or new features

2. **Update API Documentation**

   - Update relevant pages in `/docs/api/` to match current exports
   - Ensure function signatures, parameters, and return types are accurate
   - Add documentation for new exports or functions

3. **Update Examples**

   - If functionality changed, update code examples in `/docs/examples/`
   - Ensure examples compile and demonstrate current API usage
   - Add new examples for significant new features

4. **Update Guides**

   - Update any guides in `/docs/guides/` that reference changed functionality
   - Add new guides for major new features if appropriate

### Documentation Guidelines

- Keep documentation concise and accurate
- Use consistent formatting with existing docs
- Include TypeScript code examples where relevant
- Don't remove documentation for features that still exist
- Add notes for breaking changes or migration steps

---

## Output Format

Return a JSON object matching the output schema with:

### `projects` array (version bumps + changelog)

- `name`: Project name (e.g., "ast-guard")
- `bump`: One of "major", "minor", "patch", or "none"
- `newVersion`: The calculated new version string (e.g., "1.2.0")
- `reason`: Brief explanation of why this bump type was chosen
- `changelog`: Object with changelog entries for this project
  - `added`: Array of strings (new features)
  - `changed`: Array of strings (changes to existing functionality)
  - `deprecated`: Array of strings (soon-to-be removed features)
  - `removed`: Array of strings (removed features)
  - `fixed`: Array of strings (bug fixes)
  - `security`: Array of strings (security fixes)

### `globalChangelog` object

- `summary`: Brief summary for the global CHANGELOG.md
- `projects`: Array of `{ name, version, summary }` for each bumped project

### `docs` object (documentation updates)

- `updated`: Boolean indicating if any documentation was changed
- `files`: Array of file paths that were modified or created
- `summary`: Brief description of the documentation changes made

## Example Output

```json
{
  "projects": [
    {
      "name": "ast-guard",
      "bump": "minor",
      "newVersion": "1.1.0",
      "reason": "Added new sanitizeHtml export function",
      "changelog": {
        "added": ["New `sanitizeHtml()` function for HTML content validation"],
        "changed": [],
        "deprecated": [],
        "removed": [],
        "fixed": [],
        "security": []
      }
    },
    {
      "name": "vectoriadb",
      "bump": "patch",
      "newVersion": "1.0.1",
      "reason": "Fixed memory leak in vector storage",
      "changelog": {
        "added": [],
        "changed": [],
        "deprecated": [],
        "removed": [],
        "fixed": ["Fixed memory leak when deleting vectors from namespace"],
        "security": []
      }
    }
  ],
  "globalChangelog": {
    "summary": "Minor updates to ast-guard and vectoriadb",
    "projects": [
      { "name": "ast-guard", "version": "1.1.0", "summary": "Added sanitizeHtml function" },
      { "name": "vectoriadb", "version": "1.0.1", "summary": "Fixed memory leak" }
    ]
  },
  "docs": {
    "updated": true,
    "files": ["docs/api/ast-guard.mdx", "docs/examples/basic-usage.mdx"],
    "summary": "Updated AST Guard API docs with new sanitizeHtml function, added usage example"
  }
}
```

## Notes

- If no documentation updates are needed, return `docs.updated: false` with empty files array
- Focus on accuracy over comprehensiveness
- Prioritize API documentation over marketing copy
- Changelog entries should be human-readable and useful to developers
