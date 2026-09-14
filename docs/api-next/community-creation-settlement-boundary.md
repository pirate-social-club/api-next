# Community creation: current activation and historical settlement

This note records the dependency and transaction map behind the separation of
current community creation activation from historical settlement, and the
boundary this lane implements. The initial extraction was based on `origin/main` `5f3be3c8`. The nationality
lane integrates the accepted extraction at `3e34a9c0` without duplicating its
SQL or bypassing its transaction boundary.

## What was separated

`packages/platform-cf/src/community-creation-repository.ts` mixed two
lifetimes:

| Symbol | Lifetime | Destination |
| --- | --- | --- |
| `CommunityCreationVerificationAdvanceOutcome` | Settlement result type | `community-creation-verification-settlement.ts` |
| `verificationStorageFailure` | Settlement failure mapping | same |
| `advanceCommunityCreationVerificationInTransaction` | Settles a completed identity proof session against an intent | same |
| `advanceCommunityCreationNamespaceVerificationInTransaction` | Settles grandfathered route-v1 namespace ownership against an intent | same |
| `makeControlPlaneCommunityCreationRepository` and its activation transaction | Current creation and activation | stays in `community-creation-repository.ts` |

Callers, each inside its own `ControlPlaneDb.withTransaction`:

- `verification-completion-repository.ts` on `settleCompleted` and on the
  exact-replay branch of `commit`, after the completion pre-lock and the
  terminal, idempotency-key and result-hash checks.
- `namespace-ownership-completion-repository.ts` only when
  `creation_contract_version === "route_v1"`, after the route-evidence insert
  and its row-count check.

Both public advance helpers execute only through the caller's
`ControlPlaneTransaction`; they open no transaction and own no commit.
The verification dispatcher also retains the nationality lane's generic
creation and join ceremony routing, with actor, action kind, current attempt,
generation, result-hash, terminal-completion, and expiry fences unchanged.

## Boundary

The advance helpers and their outcome type live in
`community-creation-verification-settlement.ts`. Current authoring, creator
nationality issuance and enforcement, and the activation transaction stay in
`community-creation-repository.ts`.

Shared SQL and document helpers live in `community-creation-internals.ts`.
That package-internal module owns row decoding, the locked intent projection,
revision insertion, human-requirement reservation and evidence lookup. The
nationality progress decoder and projection move with that shared owner.
The completion-storage failure constructor is shared because both creator
enforcement and completion use it. The module remains absent from the package
exports map; callers use the public repository or settlement entry points.

## Preserved behavior

No SQL text, statement label, lock order, revision check, idempotency key,
result-hash comparison, error mapping or persisted row shape changed. The
grandfathered route-v1 projection and human-identity paths are untouched, and
`makeControlPlaneCommunityCreationRepository` and its single activation
transaction remain intact. The extraction is a move plus import updates. An AST comparison against the
nationality lane's pre-integration source proves all 64 top-level declaration
bodies are unchanged, apart from export boundaries and formatting, with no
duplicate helper owners. Repository checks and PostgreSQL transaction tests
remain required to verify the new import graph and integrated schema.
