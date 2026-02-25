# CLAUDE.md

## Verification

After every code change, the following commands must all pass before considering the work complete:

```bash
pnpm lint
pnpm format:check
pnpm build
```

Run these from the repository root. Use `npx nx` to target individual projects (e.g., `npx nx build browser`).
