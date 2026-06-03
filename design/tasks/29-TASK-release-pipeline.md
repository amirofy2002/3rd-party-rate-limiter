# 29-TASK-release-pipeline

## Goal

CI/CD: lint, typecheck, test, integration test, benchmark, build, publish. Architecture §25 Phase 4.

## Dependencies

- All previous tasks (publishable artifact assumes Phase 1-3 complete).

## Logic

### `.github/workflows/ci.yml`

Jobs (matrix: Node 18, 20, 22 on `ubuntu-latest`):

- `lint`: `pnpm lint`
- `typecheck`: `pnpm typecheck`
- `test`: `pnpm test --coverage`, upload coverage to Codecov.
- `integration`: requires Docker; runs `pnpm test:integration` (testcontainers Redis).
- `bench`: runs benchmarks, compares vs `benchmarks/baselines/`, fails on >10% regression.
- `build`: `pnpm build`; uploads artifact.

### `.github/workflows/release.yml`

Trigger: tags `v*`.

Steps:

- Run full CI suite.
- `pnpm build`.
- `pnpm publish --provenance --access public` (NPM provenance for supply-chain integrity).
- Create GitHub Release with auto-generated notes via `changesets` or `release-please`.

### Tooling

- `changesets`: manage semver bumps and changelog.
- `npm-package-json-lint`: enforce required fields.
- `publint`: validate package shape pre-publish.
- `attw` (`@arethetypeswrong/cli`): verify type resolution for ESM + CJS consumers.

### `package.json` additions

- `files`: `["dist", "README.md", "LICENSE"]`
- `publishConfig.access`: `"public"`
- `repository.url`, `bugs.url`, `homepage`, `license`, `author`.

## Tests

- CI green on PR to `main`.
- `pnpm pack --dry-run` shows expected files only (no test, no design folder, no examples).
- `attw --pack` passes for both ESM and CJS resolution.
- Publish dry-run: `pnpm publish --dry-run` succeeds.

## Edge Cases

- NPM 2FA / OIDC: use NPM provenance via GitHub OIDC (no long-lived token).
- Pre-release tags (e.g. `v0.1.0-rc.1`): publish with `--tag next`, not `latest`.
- Breaking changes mid-zero-version (0.x): document semver-zero policy in README.
- Changesets PR vs direct tag: prefer changesets PR flow to gate releases.
- Bundling Lua scripts: confirm `dist/` includes `.lua` files via `tsup` asset copy or `files` array.

## Acceptance

First successful `v0.1.0` publish to NPM with provenance badge visible. Install + smoke test in fresh project works.
