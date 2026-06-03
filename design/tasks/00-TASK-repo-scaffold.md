# 00-TASK-repo-scaffold

## Goal

Bootstrap repo as TypeScript NPM library. ESM + CJS dual build, tree-shakeable, type declarations, source maps.

## Dependencies

None. First task.

## Logic

1. Initialize `package.json`:
   - `name`: `@bitazza/rate-limiter` (placeholder; confirm with user before publish)
   - `version`: `0.0.1`
   - `type`: `module`
   - `exports` map → ESM + CJS + types
   - `main`, `module`, `types` for legacy resolvers
   - `engines.node`: `>=18`
   - `sideEffects`: `false`
2. Install dev deps: `typescript`, `tsup` (dual build), `vitest`, `@vitest/coverage-v8`, `@sinonjs/fake-timers`, `fast-check`, `eslint`, `@typescript-eslint/*`, `prettier`.
3. Create `tsconfig.json`: strict, ES2022 target, NodeNext modules, declaration emit, sourcemaps.
4. Create `tsup.config.ts`: ESM + CJS, dts, split chunks off.
5. Create scripts: `build`, `dev`, `test`, `test:watch`, `test:coverage`, `lint`, `typecheck`, `format`.
6. Create base folder structure per architecture §24 (empty placeholders allowed).
7. Add `.gitignore`, `.editorconfig`, `.nvmrc`.
8. Add `README.md` stub pointing at `design/`.

## Tests

- `pnpm build` produces `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts`.
- `pnpm typecheck` exits 0 against empty placeholder files.
- `pnpm test` runs Vitest (no tests yet, passes).
- `pnpm lint` exits 0.

## Edge Cases

- Node 18+ ESM resolution: verify `exports` map resolves both extensions.
- CJS consumers must get `require()` working — test via a `examples/cjs-smoke.cjs` requiring built package.
- `sideEffects: false` must not strip event registration code; verify with example bundling later.
- Do not commit `dist/` or `node_modules/`.

## Acceptance

Repo builds clean, lints clean, types clean, no runtime deps yet.
