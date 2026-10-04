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
