# Self staging enablement handoff

Status: staging infrastructure is provisioned; Self remains disabled pending
the first real-document ceremony. Updated 2026-08-18.

This is the durable handoff for enabling the self-hosted Self Pass adapter in
staging. It records observed external state, not assumptions. Secret values
are intentionally omitted.

## Current staging gate

The interrupted staging attempt is recorded in
[self-staging-evidence.md](self-staging-evidence.md), which preserves the
credential exposure and containment history. The current verified state below
supersedes the pre-provisioning inventory. Self is disabled and the real
ceremony has not begun.

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

## Current verified staging state

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
- The HTTP Worker’s current good version is
  `734a588d-406c-4f2e-82fa-2c30e64ddfd7`, deployed with Self disabled.
  Health returned 200, JWKS returned 200, public-profile returned 404 (DB
  path), and missing/invalid authentication returned 401.
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

### Cloudflare and Hyperdrive

- Authenticated account: `hippiehecton`, account ID
  `ff375d61cdc0c5dc946837f3e37725e0`. The Wrangler configs now pin this ID;
  before this commit Wrangler silently selected an unrelated account.
- The only existing Hyperdrive configuration is
  `pirate-control-plane-production` (`7e457bc33b414671833ee4436548d9ee`),
  connected to production. Never reuse it for staging.
- The checked-in pre-provisioning staging Hyperdrive ID
  `8cb7658a0f7143359c1becfec6a15c23` does not exist and must be replaced in
  both Worker configs after a staging configuration is created.
- `pirate-http-worker-staging` does not exist, so it has no installed Worker
  secrets yet.
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
   staging only. **Pending; Self remains disabled.**
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
