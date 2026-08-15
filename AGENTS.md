# api-next — Agent Rules

Clean-foundation rewrite of the Pirate API on Effect TS v4 + Cloudflare
Workers. The architecture, non-negotiables, and milestones live in the
workspace control plane: `../docs/specs/api-next/000-foundation.md` and
`001-execution-lanes.md`. Read both before working here.

## Effect v4

This repository pins `effect` to `4.0.0-rc.109`. Before writing or reviewing
Effect code:

1. Read `node_modules/effect/AGENTS.md` in full.
2. Verify every API against `node_modules/effect/src`, not memory or docs.
3. Repository patterns beat skill guidance. Skill guidance beats memory.
4. Run `bun run check` and `bun run test`. Both must pass.

## Commit policy

Commit directly to `main` — no feature branches for canonical work (mirrors
the `core` convention; single integration writer). Lane worktrees branch
per the lane spec and merge via the coordinator. Commits are conventional,
small, and pathspec-limited; never a blanket `git add -A`.

## Gates

Run from the repo root, smallest first:

1. `bun run check` — Effect version guard, Biome, `tsc --noEmit`, and
   dependency-matrix lint
2. `bun run test` — unit tests (workerd integration tests join the required
   gate when lane C's pool-workers harness lands)

CI must be green before merge; until a remote CI gate exists, the merging
session runs the full local suite and records it in the workspace register.

## Freeze rule

`packages/contracts/src/errors.ts`, `auth.ts`, `money.ts`, `endpoint.ts`,
and `packages/application/src/ports.ts` are phase-0 frozen. Changes are
coordinator-mediated, landed in the canonical, and announced in the
workspace task register — never from a lane worktree.

## Dependency matrix

Enforced by `bun run lint:deps` (000 §4): contracts/domain import nothing
internal; application imports contracts+domain; platform-cf and testing
implement application's ports; apps import everything except testing;
nothing imports apps; domain uses only Schema/Data effect modules.

## Runtime

Effect is pinned to an exact version (`4.0.0-rc.109` at bootstrap), and
`bun run check` fails if `effect` or any `@effect/*` package declares or
resolves to another version. Upgrades are deliberate, reviewed bumps — never
transitive drift. Never change an Effect version to resolve an API mismatch;
report the mismatch instead. All `cloudflare:workers` and Effect
platform-adapter imports stay in `platform-cf`. `effect/unstable/*` is beta;
confirm the export exists in `node_modules/effect/src` before using it. No
unstable Effect modules in money paths until v4 is stable.
