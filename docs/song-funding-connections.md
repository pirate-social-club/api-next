# Song funding connections

HTTP contribution commands and private contribution reads use the
`SONG_FUNDING_COMMANDS` Hyperdrive binding. The whole command transaction stays
on this connection, including policy and pot creation, nonce reservation,
contribution creation, refusal receipts and recovery enqueueing. Dance,
authentication and other repositories continue to use `CONTROL_PLANE`.

Jobs context production, incoming-principal observation and contribution
recovery use `SONG_FUNDING_JOBS`. This connection retains the existing 3 second
connect, 2 second statement and 1 second close limits. Other scheduled work
continues to use its existing general connection.

Neither connection falls back to `CONTROL_PLANE`. A selected funding lane with
a missing or identical binding refuses composition. With both lanes off, HTTP
can serve unrelated requests without a funding binding. A configured funding
connection remains available for immutable receipt replay when admission is
off. Enabling both lanes remains invalid. Safe production admission still
requires its own production switch; RPC, attestation, environment, database
pause and live run-lease checks remain in their owning boundaries.

Migration 319 fixes the context reader's persona alias collision with its local
profile record and restores the trusted paths lost by two migration 284
replacements. It adds no runtime grant or role and changes no policy, captured term or runtime flag.
The context-reader body change is limited to the persona alias. Its owner and
ACL, and the locked admission function's body, owner and ACL, are preserved.
The existing deferred asset-bonus accounting trigger also needs owner read
authority when PostgreSQL 17 runs it at COMMIT. Migration 319 preserves that
invariant's accounting checks, owner and private ACL and makes it a trusted-path
definer. It checks the exact two trusted relation identities before reading NEW,
so a trigger attached before migration cannot supply attacker-defined coercion.
It also revokes PUBLIC execution to prevent new untrusted attachments.
Neither funding login receives direct execution or raw accounting-table access.
Previously applied migration files and their hashes remain unchanged.

## Permission and resource preparation

This source does not provision live resources or select credentials. Existing
Wrangler environments have no dedicated funding bindings; an enabled candidate
therefore refuses deployment until resource preparation is independently
reviewed and completed. Do not insert placeholder IDs or point either binding
at the Dance principal to make preparation pass.

The complete direct-call contract is in
`scripts/song-funding-permission-contract.ts`. HTTP has the 19 signatures from
the `http_commands` and shared-song `account` purposes. Jobs has the 11
signatures from `incoming_observer`, `funding_recovery_jobs` and `context_worker`,
plus `require_reward_run_authority_v1()`. The five purpose binders alone omit
that supporting Jobs capability. Both identities need schema USAGE, without
CREATE or grant option. They receive no direct table or column access, role
membership, owner equivalence, grant option or extra direct function grants.
The identities and Hyperdrive resources must be distinct, on the same database
and branch as the corresponding general connection. Funding connections must
have query caching disabled for current permission and funding reads.

The coordinator must inventory suitable approved identities, provision any
missing resources within their authority, and review exact binding IDs,
database origins, principals, grants and deployment configuration. No resource
ID or managed secret path is selected here. Funding activation, run leases,
unpausing, keys and transfers remain outside this source change.

## Deployment admission

The provenance deployment wrapper admits funding bindings before upload,
rechecks them immediately before upload, and reads them back afterward. It
reads the effective candidate, every traffic-bearing version and the actual
Hyperdrive origins. Each checked SQL connection must match its binding's host,
port, database and current/session principal. An unrelated passing database URL
cannot qualify a binding. For managed PlanetScale PostgreSQL, the external
role-and-branch username must match exactly; SQL must expose its documented
base role, and both connections must name the same branch. A changed candidate
or traffic allocation refuses admission. An older version without the new binding still has to pass its
unchanged Dance contract and must have been present before deployment. The new
version must match the admitted candidate's general/funding binding IDs and
effective lane, environment, production switch and attestation posture.

The deployment environment supplies `CONTROL_PLANE_POSTGRES_RUNTIME_URL` and
the corresponding `SONG_FUNDING_COMMANDS_POSTGRES_URL` or
`SONG_FUNDING_JOBS_POSTGRES_URL` through approved credential handling. These
URLs are operator verification inputs, never Worker variables or receipt
contents. Receipts contain nonsecret resource and principal identities only.

The source tests prove actual restricted LOGIN behavior against an isolated
PostgreSQL fixture, including 318 refusal, the 319 repair, complete initial
policy/pot/contribution/nonce transaction rollback, receipt replay, context
production, incoming principal, recovery, pause/lease checks and all four
unchanged Dance contracts in the same snapshot. Composed HTTP and Jobs tests
prove connection routing, selected-lane projections, bounded Jobs settings and
missing-binding refusal. Deterministic provider fixtures do not qualify real
wallet sponsorship, phone publication, financial policy or live deployments.
