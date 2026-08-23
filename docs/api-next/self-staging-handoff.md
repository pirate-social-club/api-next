# Self staging enablement handoff

Status: Cloudflare canonical-account cutover completed on 2026-08-23. The
developer/mock-document deployment and probes recorded below remain historical
misplaced-account evidence. The first canonical real-document ceremony is
pending.

This is the durable handoff for enabling the self-hosted Self Pass adapter in
staging. It records observed external state, not assumptions. Secret values
are intentionally omitted.

## Cloudflare account correction — 2026-08-22

The Cloudflare evidence below was collected from non-canonical account
`ff375d61cdc0c5dc946837f3e37725e0` after commit `5251933` incorrectly made an
ambient Wrangler OAuth identity authoritative. It did not establish the state
of canonical account `08a4c22cf52e2ecae883e36f80a33f4a`.

Metadata-only re-inventory proved that the canonical account already contains
the staging HTTP and jobs Workers and staging Hyperdrive `api-next-staging`
(`8cb7658a0f7143359c1becfec6a15c23`). The later deployments and Hyperdrive
`11c1ad1806004f3b87fa771833093132` are in the misplaced account. Repository
pins were corrected in `abe19d6`. The canonical HTTP and jobs Workers were
synchronized and deployed from published commit `306db31` on 2026-08-23 with
Hyperdrive `8cb7658a0f7143359c1becfec6a15c23`. The name-only Cloudflare audit
reports zero violations, health and JWKS probes pass, and the live JWK matches
the Infisical private key. The three misplaced staging Workers, their nine
installed secrets, and misplaced staging Hyperdrive were retired on
2026-08-23. The `pirate.sc` zone moved to the canonical account later that day,
and the API and Solid custom domains are attached to their canonical Workers.
The managed, secret-free `api-next-staging-zone-bridge` remains temporarily
only for resolvers caching the former 86,400-second delegation. Treat later
pre-correction versions and probes in this document as historical
misplaced-account evidence unless explicitly labeled canonical.

## Current staging gate

The interrupted staging attempt is recorded in
[self-staging-evidence.md](self-staging-evidence.md), which preserves the
credential exposure and containment history. The historical verified state below
supersedes the pre-provisioning inventory; the current mode is recorded above.
The real ceremony has not begun.

### Current M3 mode override

For the misplaced-account M3 state, api-next commit `a9bbd337` sets
`SELF_PASS_MOCK_PASSPORT=true` in staging only and was deployed as Worker
version `7d680db5-90f1-4628-9bb5-3adbbe1665a7`. Development and production use
`SELF_PASS_MOCK_PASSPORT=false`; production remains
`SELF_PASS_ENABLED=false`. This permits developer-document testing but does
not count as physical-document evidence. The callback capture seam remains
retired, and a live-document ceremony requires a separately authorized
redeploy.

## Published code state

- `origin/main` is `aba34d07c19c60bb7cb57b73f599328027da5964` before this
  handoff/configuration commit.
- GitHub Actions run `32068990866` passed both the main check job and the
  required PostgreSQL 17 job.
- The Self engineering gate is closed: the adapter, registry boundary,
  reservation fencing, callback budgets, transport credential stripping,
  workerd coverage, and adversarial conformance tests are complete.
- At the pre-provisioning inventory, Self was disabled in every checked-in
  environment and no migration or deploy had been performed. The current
  staging deployment is recorded in the verified-state section below.
- The migration checksum manifest SHA-256 is
  `dff403966354712b3648ac8db2290a5770a6fc3e6de8c36f56f64c5fa0a56e6a`.

## Original verified staging state (historical)

### Infisical and authentication

- The active project is `fac45f92-9450-42fb-8c2f-f20d043fdfab` in
  organization `d9615445-c0d4-445a-ad58-1d55d365635a`; staging secrets are at
  the project root in the `staging` environment.
- Staging and production Privy values and Pirate JWT values are separate by
  equality-only comparison. The stale derived staging Privy and upstream
  authentication tuple was repaired and re-verified without exposing values.
- The initial deployment failed because two JWT PEM entries had trailing
  newlines. The Worker was redeployed with canonical trimming; the two new
  project staging entries were normalized and value-safely re-verified.

### Database and migrations

- The dedicated `api_next` schema is owned by `api_next_migrator`; runtime is
  `api_next_app`. Both roles use the exact search path
  `api_next, pg_catalog`, unrelated-schema access is denied, runtime CRUD
  passes, and runtime DDL is denied.
- All 12 migrations are present in the ledger and match manifest hash
  `dff403966354712b3648ac8db2290a5770a6fc3e6de8c36f56f64c5fa0a56e6a`.
  There are 36 tables, all migrator-owned.
- The temporary provisioner role `arhnkpu17vll` was deleted after setup.

### Cloudflare and probes

- Staging uses Hyperdrive `pirate-control-plane-staging`, ID
  `11c1ad1806004f3b87fa771833093132`, with caching disabled and limit 5.
- The staging API hostname is `api-next-staging.pirate.sc`; it does not
  replace the existing `staging.pirate.sc` service.
- The Self-disabled baseline was `734a588d-406c-4f2e-82fa-2c30e64ddfd7`.
  The earlier live-document staging version was
  `5704627a-be9d-499c-933a-ec76e685babf`; the current M3 developer-mode
  version is recorded in the override above.
  Health returned 200, JWKS returned 200, public-profile returned 404 (DB
  path), and missing/invalid authentication returned 401.
- After enablement, health returned 200, unauthenticated Self session start
  returned 401, and an unbound garbage `self.pass` callback failed closed with
  400.
- Initial probes used explicit Cloudflare IPv4 resolution while DNS A
  propagation was incomplete. A and AAAA records subsequently published, and a
  normal direct health request returned 200. The jobs configuration is updated
  with the staging Hyperdrive ID, but jobs has not been deployed.

## Historical pre-provisioning inventory

The following findings describe the state before the current provisioning and
are retained to explain the resource choices. They are not current values.

### PlanetScale

- Organization: `1-prewar119`.
- Staging database: `pirate-staging`, PostgreSQL, branch `main`
  (`syu03e00w3ux`, `us-east`). Do not confuse it with the abandoned Neon
  projects.
- The database is not empty. It contains an older `bookings` schema with 12
  tables and 12 tables in `public`. There is no api-next migration ledger.
- The Infisical runtime and migrator URLs both reach this exact PlanetScale
  database. Their database roles are `control_plane_api_rw` and
  `control_plane_migrator`.
- Both roles currently use `search_path = "$user", public`. The migrator owns
  and can create in `bookings`, but cannot use/create in `public`; the runtime
  role can use `bookings` but cannot create there. Applying api-next migrations
  with these URLs as-is is unsafe and may fail or target the wrong schema.
- PlanetScale lists a role named `api_next_app`, but it was not visible as a
  database role through the current migrator connection. Its credential and
  grants therefore remain unproven.
- Automatic backups exist. That does not authorize deleting the old schemas.

Recommended disposition: create a dedicated `api_next` schema and explicit
migrator/runtime role grants and search paths. Keep the old `bookings` and
`public` residue until a separately reviewed destructive cleanup. If a full
wipe is preferred, inventory and name the exact schemas/tables and preserve a
verified backup before deletion.

### Infisical

- The prior staging inventory was in project
  `5acea78e-7813-4d8a-b29c-9b862a0b1c71`.
- Current database URLs live under `/services/api` and
  `/services/control-plane`; there is no `/services/api-next` folder and no
  `.infisical.json` in this repository.
- `/services/api` contains database, JWT, and Privy secret names, but the
  observed inventory did not contain `PRIVY_APP_ID`.
- No secret values were printed or copied during this inventory.

Recommended disposition: create a dedicated `/services/api-next` staging path
and deliberately source the runtime database URL, migrator URL, JWT keys,
`PRIVY_APP_ID`, and `PRIVY_APP_SECRET`. Do not make api-next implicitly depend
on old service folder names.

Superseded by `secrets-contract.md`, which records the current api-next
Infisical project, the classification of its seventeen root entries, and the
target path layout. `PRIVY_APP_ID` is classified there as public configuration
rather than a secret, and the database URLs are confined to an operator path
that is never synchronized to a Worker.

### Cloudflare and Hyperdrive

- This inventory used non-canonical account
  `ff375d61cdc0c5dc946837f3e37725e0`; it cannot justify canonical resource
  selection. The account correction above supersedes its conclusions.
- The only existing Hyperdrive configuration is
  `pirate-control-plane-production` (`7e457bc33b414671833ee4436548d9ee`),
  connected to production. Never reuse it for staging.
- The checked-in pre-provisioning staging Hyperdrive ID
  `8cb7658a0f7143359c1becfec6a15c23` appeared absent only because the wrong
  account was queried. It exists in the canonical account.
- `pirate-http-worker-staging` appeared absent only in the queried account at
  that time. It already existed in the canonical account.
- `staging.pirate.sc` already resolves and serves another application. Its
  `/health` is not api-next. Do not claim or overwrite that hostname without
  an explicit routing decision.
- api-next currently has only `CORS_ORIGIN`; it has no separate public API
  origin variable. The Self callback URL therefore needs an explicit staging
  hostname/route decision before enablement.

## Exact continuation sequence

1. Reconfirm this file against current external state. **Complete for the
   state recorded above.**
2. Decide the staging API hostname/route without displacing the existing
   `staging.pirate.sc` service. **Complete:** `api-next-staging.pirate.sc`.
3. Establish the dedicated PlanetScale `api_next` schema, migrator role,
   runtime role, explicit search paths, grants, and default privileges. Prove
   the runtime role cannot migrate or access unrelated schemas. **Complete.**
4. Create the new-project staging values and install them with reviewed,
   value-safe procedures. **Complete.**
5. Run the migration dry-run, apply the migrations, and verify the ledger.
   **Complete:** 12 migrations match the manifest hash above.
6. Create a staging-only Hyperdrive configuration against the least-privilege
   runtime role and update both Worker configs. **Complete for configuration;**
   the jobs Worker is not deployed.
7. Deploy the HTTP Worker with `SELF_PASS_ENABLED=false` and verify health,
   authentication, and database connectivity. **Complete for the recorded
   probes.**
8. Install the reviewed Self/Privy/JWT secrets and enable `self.pass` in
   staging only. **Complete; post-enable fail-closed probes passed.**
9. Run one fresh Self ceremony with a supported physical document. Capture
   session, receipt, assertion, subject-key/binding, provenance, pinned
   `pirate-social` scope, and `credential.subject_unique` evidence without
   recording private document data.
10. Exercise accepted completion, identical replay, rejected bound proof, and
    one unbound garbage callback. Record the attempt-table lease and consumed
    rows to prove unbound garbage does not durably burn the session budget.
11. Produce a redacted staging evidence report containing deployed commit,
    Worker route, Hyperdrive ID/name (not credentials), migration ledger and
    checksum manifest, ceremony outcomes, database invariants, and rollback
    instructions.
12. Audit that report before beginning the pure evaluator slice. The first
    evaluator vertical should consume the staging ceremony evidence and decide
    the curated 18+ policy. ZKPassport follows the evaluator; its verifier VPS
    remains a separate later concern.

## Stop conditions

- Any connection resolves to Neon or to `pirate_prod`.
- Any command would reuse the production Hyperdrive configuration.
- The target schema, role, hostname, or secret source is ambiguous.
- Migration checksums differ from the reviewed manifest.
- Self is enabled outside staging, or production configuration changes.
- A staging deploy would overwrite an existing Worker route or hostname.

PoW remains outside this tranche. The schema supports atomic grant consumption
with a content write, but burn safety is not a product guarantee until the
protected-action use case performs both in one transaction.

## Gates-v2 staging re-verification — 2026-08-19

This section records the current gates-v2 staging state and supersedes older
verified-state bullets above where they conflict.

- The dedicated PlanetScale `api_next` schema is at
  `0022_m3_community_purchase_immutability.sql` with 22 checksum-verified
  migrations. M3 funding tables were empty before application traffic.
- Runtime grant preflight passes: M3 append-only rows cannot be updated or
  deleted, policy/operator tables are read-only, and purchase lifecycle writes
  plus enforce decision inserts remain available.
- `staging-gates-v2-age18` is an active gated staging-only fixture. The pinned
  `curated-age-v1` policy is seeded and pointed by `community_policy_current`;
  its policy hash is recorded in the control-plane task register. Decision
  records were zero before any join attempt.
- The first deployment was Self-disabled at version
  `1a5d966e-4e4a-4f6a-a7f2-afff9fdd5061`. After health, preview, and
  unauthenticated-boundary checks passed, Self was enabled only in staging at
  version `b3a7be94-b56c-4996-891a-a4cd737694d1`.
  `SELF_PASS_MOCK_PASSPORT` was false for that historical live-document pin;
  the current M3 staging override sets it true for developer-document
  testing.
- Post-enable probes: `/health` returned 200, unauthenticated verification
  start returned 401, and malformed `self.pass` callback input returned 400.
- Infisical staging has no funding RPC. The Worker currently uses the explicit
  fail-closed staging sentinel `https://rpc.invalid/`; replace it with an
  authorized real staging RPC before money-flow verification or launch.

Pending: one fresh physical-document Self ceremony, redacted accepted/replay/
rejected/unbound-callback evidence, and real ZKPassport proof verification.
