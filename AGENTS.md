# Repository Guidelines

## Project Structure & Module Organization

- `libs/<package>/` — publishable libraries (`src/`, `README.md`, `CHANGELOG.md`). Build output goes to `libs/<package>/dist/`.
- `apps/*-demo/` — small Node demos (entry: `src/main.ts`) for manual testing and examples.
- `docs/` — documentation content (Markdown/MDX).
- `scripts/` — repo tooling (release helpers, formatting/perf utilities).
- Generated: `coverage/`, `dist/`, `tmp/` (do not commit build artifacts).

## Build, Test, and Development Commands

```bash
yarn install          # install deps (Node >=22; see .nvmrc)
yarn build            # build all projects (Nx)
yarn test             # run all Jest suites (no Nx cache)
yarn lint             # ESLint across the workspace
yarn format           # Prettier on files changed vs main
yarn format:check     # verify formatting

nx build ast-guard    # build a single project
nx test enclave-vm    # test a single project
nx serve enclave-demo # run a demo app
```

Optional: `nx local-registry enclave` starts a local Verdaccio registry for publish testing.

## Coding Style & Naming Conventions

- Indentation: 2 spaces (`.editorconfig`). Formatting: Prettier (`.prettierrc`, 120 cols, single quotes, trailing commas).
- Linting: ESLint flat config (`eslint.config.mjs`); unused params/vars should be prefixed with `_`.
- Git hooks: Husky + `lint-staged` run `eslint --fix` and Prettier on staged changes.
- Prefer workspace import paths (e.g. `import { validate } from 'ast-guard'`) over deep cross-lib relative imports.

## Testing Guidelines

- Framework: Jest via Nx (`@nx/jest`).
- Test placement/naming: `src/__tests__/**/*.spec.ts`; performance tests live under `libs/enclave-vm/src/__tests__/perf/**/*.perf.spec.ts`.
- Coverage reports are written under `coverage/`; `enclave-vm` enforces a global coverage threshold (see `libs/enclave-vm/jest.config.ts`).

## Commit & Pull Request Guidelines

- Commit messages follow Conventional Commits in practice: `feat:`, `fix:`, `refactor:`, `chore(release): …` (optional scope like `feat(enclave-vm): …`).
- PRs should include: a short problem/solution description, test evidence (`yarn test` or `nx test <project>`), and security-impact notes for sandbox/VM changes. Link relevant issues and include logs/screenshots for demo behavior changes.

## Security & Configuration Tips

- This is a security-focused repo: prefer “add failing exploit test → fix → keep regression test” for hardening changes.
- If you find a vulnerability, follow `SECURITY.md` for responsible disclosure.
