# Community creation: current activation and historical settlement

This note records the dependency and transaction map behind the separation of
current community creation activation from historical settlement, and the
boundary this lane implements. The base is `origin/main` `5f3be3c8`.

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

Both advance helpers execute only through the caller's
`ControlPlaneTransaction`; they open no transaction and own no commit.

## Boundary

The two advance helpers, their outcome type and their failure mapping live in
`community-creation-verification-settlement.ts`. The shared SQL and document
helpers they use (`Row`, `asString`, `asTimestamp`, `asPositiveInteger`,
`oneRow`, `validId`, `documentFromRow`, `loadLockedIntent`, `insertRevision`,
`reserveNextCreationRequirement`, `loadCommitEvidence`, `exactCanonicalJson`,
`failure`, `SHA256_HEX`, `TERMINAL_STATUSES`, `VERY_WEB_EVIDENCE_KIND`,
`HUMAN_MEMBERSHIP_REQUIREMENTS`, `HUMAN_MEMBERSHIP_CLAIM_IDS`) remain owned by
the creation repository and are package-internal exports imported by the
settlement module. That keeps one owner of the shared SQL while the settlement
lifetime is its own reviewable module; splitting the helpers into a third
module can follow if the package's dependency direction needs it.

## Preserved behavior

No SQL text, statement label, lock order, revision check, idempotency key,
result-hash comparison, error mapping or persisted row shape changed. The
grandfathered route-v1 projection and human-identity paths are untouched, and
`makeControlPlaneCommunityCreationRepository` and its single activation
transaction remain intact. The extraction is a move plus import updates; tests
and hosted PostgreSQL checks carry the behavioral evidence.
