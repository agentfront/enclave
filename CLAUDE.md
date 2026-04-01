# CLAUDE.md

## Setup

Before running any commands, install dependencies with:

```bash
yarn install
```

## Verification

After every code change, the following commands must all pass before considering the work complete:

```bash
yarn lint
yarn format:check
yarn build
```

Run these from the repository root. Use `npx nx` to target individual projects (e.g., `npx nx build browser`).
