# Analyze Version Bump

Analyze the git diff for the affected libraries and determine the appropriate semantic version bump for each.

## Context

You are analyzing code changes in an Nx monorepo. The affected projects are provided via the `AFFECTED_PROJECTS` environment variable (comma-separated list). The base reference for comparison is in `BASE_REF`. If `IS_FIRST_RELEASE` is "true", this is the first release and all projects should be set to version `1.0.0`.

## Rules for Version Bumping

### MAJOR (breaking change)

Use major bump when:

- Public exports are removed or renamed
- Function signatures change (parameters added/removed as required, return types changed)
- Public APIs are removed or renamed
- Breaking changes to configuration or behavior
- Incompatible changes to data structures or interfaces

### MINOR (new feature)

Use minor bump when:

- New public exports or functions are added
- New files in `src/` directory (excluding tests)
- New optional parameters added to existing functions
- New configuration options added
- Backward-compatible functionality additions

### PATCH (bug fix)

Use patch bump when:

- Bug fixes that don't change the API
- Documentation changes only
- Test changes only
- Internal refactoring with no API changes
- Dependency updates (non-breaking)
- Performance improvements without API changes

## Instructions

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

## Output Format

Return a JSON object matching the output schema with:

- `projects`: Array of project version decisions
  - `name`: Project name (e.g., "ast-guard")
  - `bump`: One of "major", "minor", "patch", or "none"
  - `newVersion`: The calculated new version string (e.g., "1.2.0")
  - `reason`: Brief explanation of why this bump type was chosen

## Example Output

```json
{
  "projects": [
    {
      "name": "ast-guard",
      "bump": "minor",
      "newVersion": "1.1.0",
      "reason": "Added new sanitizeHtml export function"
    },
    {
      "name": "vectoriadb",
      "bump": "patch",
      "newVersion": "1.0.1",
      "reason": "Fixed memory leak in vector storage"
    }
  ]
}
```
