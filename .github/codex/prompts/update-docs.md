# Update Documentation

Update the Mintlify documentation based on the code changes in this release.

## Context

You are updating documentation in an Nx monorepo after code changes. The affected projects are provided via the `AFFECTED_PROJECTS` environment variable (comma-separated list). Documentation lives in the `/docs` directory and uses Mintlify format.

## Instructions

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

5. **Update Changelog**
   - If a changelog exists, add entries for this release
   - Group changes by type (Added, Changed, Fixed, Removed)

## Guidelines

- Keep documentation concise and accurate
- Use consistent formatting with existing docs
- Include TypeScript code examples where relevant
- Don't remove documentation for features that still exist
- Add notes for breaking changes or migration steps

## Output Format

Return a JSON object matching the output schema with:

- `updated`: Boolean indicating if any documentation was changed
- `files`: Array of file paths that were modified or created
- `summary`: Brief description of the documentation changes made

## Example Output

```json
{
  "updated": true,
  "files": ["docs/api/ast-guard.mdx", "docs/examples/basic-usage.mdx"],
  "summary": "Updated AST Guard API docs with new sanitizeHtml function, added usage example"
}
```

## Notes

- If no documentation updates are needed, return `updated: false` with empty files array
- Focus on accuracy over comprehensiveness
- Prioritize API documentation over marketing copy
