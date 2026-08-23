# api-next — Agent Rules

Clean-foundation rewrite of the Pirate API on Effect TS v4 + Cloudflare
Workers. The architecture, non-negotiables, and milestones live in the
workspace control plane: `../docs/specs/api-next/000-foundation.md` and
`001-execution-lanes.md`. Read both before working here.

## Clean-break ownership

api-next and the standalone SolidJS application are the only runtime systems.
No code, configuration, contract, test fixture, or deployment topology may
depend on the legacy API. Do not add a fallback, shim, dual-write, old/new
token interoperability path, legacy JWKS trust, browser bearer exposure, or
React/workspace linkage. Proposals requiring legacy interop are rejected.
Browser authentication is an api-next-owned HttpOnly host-only cookie; any
machine bearer contract is independent and must never be used as a browser
exchange response.

Standalone Solid reaches the Worker through its same-origin `/api` proxy. The
host-only session and CSRF cookies are issued and returned through that proxy;
do not add a cross-site cookie shortcut or a direct browser-to-Worker auth path.

Historical profile backfill scripts and fixtures are offline, api-next-owned
control-plane migration tooling only. They are never imported by the Worker,
must not read from or call a legacy API, and cannot be used as an auth fallback.

## Effect v4

This repository pins `effect` to `4.0.0-rc.109`. Before writing or reviewing
Effect code:

1. Read `node_modules/effect/AGENTS.md` in full.
2. Verify every API against `node_modules/effect/src`, not memory or docs.
3. Repository patterns beat skill guidance. Skill guidance beats memory.
4. Run `bun run check` and `bun run test`. Both must pass.

## Commit policy

`main` is advanced only by a squash merge of a GitHub pull request. No agent,
coordinator, or human commits directly to `main`. Lane worktrees branch per the
lane spec; the coordinator opens the pull request rather than merging locally.
Commits are conventional, small, and pathspec-limited; never a blanket
`git add -A`.

Required checks are `check`, `postgres17`, and `secret-boundary`. Zero human
approvals are required. Merge eligibility for a green pull request is decided by
trusted automation, not by the check result alone: passing tests establish that
a change is safe to merge, not that it is wanted.

The secret boundary guard refuses any pull request that modifies
`.github/workflows/secret-boundary.yml`, `scripts/secret-boundary-check.ts`, or
`scripts/secret-boundary-check.test.ts`. Changing the guard is a break-glass
operation: an administrator relaxes the `main` ruleset, lands the change, and
restores the ruleset. It has no ordinary automatic path.

This supersedes the previous direct-to-`main` convention, and diverges
deliberately from both the `core` single-integration-writer model and the
Radicle-primary promotion model in `ops/radicle-ci/operations.md`. See that
document's api-next transition record.

## Writer isolation

- Every non-coordinator agent or Codex session must be launched with filesystem
  write scope restricted to its assigned linked worktree. The canonical
  checkout must be read-only to that session.
- Only the integration coordinator may receive canonical write scope. A
  session's launch directory does not establish or expand its ownership.
- The only active workspace root is
  `/media/t42/codedrive/Code/pirate-workspace`. The similarly named
  `/home/t42/Documents/pirate-workspace` tree is historical reference material,
  never a task root or write target.

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
