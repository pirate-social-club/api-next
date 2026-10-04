# Isolated Rewards E2E tooling

This tooling belongs to the isolated Base Sepolia acceptance stack. Its standing
spending authority is recorded in the task's owner-authorization.json. It does
not operate shared staging or mainnet.

The spending ledger reserves before submission and persists outside the
resettable database. Failed or uncertain sends retain their reservations.
Returned balances do not replenish the cumulative authorization automatically.

The separate HTTP entrypoint is tests/rewards-e2e/entry.ts. Its compiled
identity pin checks the database role and isolated API origin before application
initialization. Simulated claim verification is limited to development and
reward-claim intents, binds each subject to its actor, and is labelled in the
provider presentation and response header. Normal staging, production and jobs
artifact graphs must exclude the stub.

Run `bun run verify:rewards-e2e-build` to check graph exclusion, package the test
artifact through Wrangler without uploading it, and verify the copied
artifact's refusals in workerd. This uses a synthetic local role pin. It is a
build check, not a funded E2E run or a deployed-resource identity check.

The controlled contract source is infra/megapot/repeatable-e2e-fixture. It
supports predetermined wins and losses and an operator settlement after a
purchase. The runner must enforce drawing-advance.mjs before invoking that
settlement: a confirmed jobs purchase, the pinned jobs Worker's first receipt
read, and an independently canonical receipt are mandatory. A losing drawing
still returns a nonzero settled draw reference, matching the production sweep
reader; its ticket has tier zero.

The finish line is consecutive full win and loss runs on identical pinned API
and Solid releases. Both activity kinds must earn shares, the ticket must be
purchased and read before settlement, and claims, payouts, onward sends or
refunds must finish with nothing owed. Claim pending is a failure. The command
orchestration and hosted-resource setup remain under implementation; these
component checks do not close acceptance.

The hosted bootstrap applies at most twenty migrations per transaction and checks
the exact committed ledger before every batch. This bounds PostgreSQL lock use.
A failed batch leaves the bootstrap receipt unfinished; ordinary bootstrap
refuses a second attempt. Inspect the exact target, ledger and receipt before
recovery. Previously committed batches remain committed.

`configure-runtime.ts` requires independently pinned admin and runtime
credentials and a completed bootstrap receipt. It verifies the actual runtime
SQL identity, refuses elevated roles, applies application grants with the
maintained Rewards denials, and then checks the entire runtime money permission
inventory and exact source ledger. Credential values belong only in the
isolated Infisical folder and temporary runtime workflows.

`worker-plan.mjs` replaces the current configurations' writable bindings with
the isolated resources and leaves rewards off. It refuses unknown storage and
remote Durable Object targets. `prepare-worker-build.mjs` requires the tracked
plans to match, embeds the runtime role pin, and checks that jobs exclude
simulated verification. The deployment environment is `rewards-e2e`.

`seed-fixtures.ts` reads only the preserved isolated database. It imports the
three fixture identities, the published song, its policy and media evidence,
and the Study corpus into an empty, checksum-verified target. It excludes old
sessions, attempts, qualifications and money. The transaction temporarily
suspends an explicit list of account provisioners and media insertion guards
that require a newly issued upload or next revision. Foreign keys, snapshot
checks, mutation guards and rewards guards remain active. Deferred checks are
flushed before every suspended guard is restored and the transaction commits.
A populated target refuses automatic reset.

`prepare-solid-artifact.mjs` verifies all 324 files against independently
reviewed Solid release 8baa1948 before copying its build. The isolated site
proxies only the isolated API and disables HNS ingress. It requires no shared
frontend build or source mutation. These preparations do not establish live
Rewards acceptance.
