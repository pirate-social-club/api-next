# api-next — Agent Rules

Clean-foundation rewrite of the Pirate API on Effect TS v4 + Cloudflare
Workers. The architecture, non-negotiables, and milestones live in the
workspace control plane: `../docs/specs/api-next/000-foundation.md` and
`001-execution-lanes.md`. Read both before working here.

## Commit policy

Commit directly to `main` — no feature branches for canonical work (mirrors
the `core` convention; single integration writer). Lane worktrees branch
per the lane spec and merge via the coordinator. Commits are conventional,
small, and pathspec-limited; never a blanket `git add -A`.

## Gates

Run from the repo root, smallest first:

1. `bun run check` — Biome, `tsc --noEmit`, dependency-matrix lint
2. `bun test` — unit tests (workerd integration tests join the required
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

Effect is pinned to an exact version (`4.0.0-rc.109` at bootstrap).
Upgrades are deliberate, reviewed bumps — never transitive drift. All
`cloudflare:workers` and Effect platform-adapter imports stay in
`platform-cf`. No `unstable/*` Effect modules in money paths until v4 is
stable.
