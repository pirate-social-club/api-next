# Self staging incident and restart record

Status: Cloudflare canonical-account cutover is pending. The developer/mock-
document deployment in this record exists in a misplaced account. The physical
real-document ceremony remains pending. Corrected 2026-08-22.

This is the durable, redacted record for the Self staging tranche. It preserves
the earlier incident and containment history, then records the verified
post-restart state. No secret value is recorded here.

## Cloudflare account correction — 2026-08-22

All Cloudflare deployment versions, probes, and Hyperdrive identifiers in this
record were produced in non-canonical account
`ff375d61cdc0c5dc946837f3e37725e0`. Commit `5251933` had incorrectly pinned
that account from the ambient Wrangler OAuth identity. Canonical account
`08a4c22cf52e2ecae883e36f80a33f4a` instead contains the older staging Workers
and Hyperdrive `api-next-staging` (`8cb7658a0f7143359c1becfec6a15c23`).

This document remains evidence of what happened in the misplaced account; it
is not proof of canonical staging state. No resource has been deleted, and no
canonical-account cutover has been performed during this correction.

## Current M3 mode override — 2026-08-19

The historical post-restart real-document deployment described below is not
the current staging mode. Api-next commit `a9bbd337` sets
`SELF_PASS_MOCK_PASSPORT=true` in staging only, and was deployed to
`pirate-http-worker-staging` as version
`7d680db5-90f1-4628-9bb5-3adbbe1665a7`. Development and production remain
`SELF_PASS_MOCK_PASSPORT=false`; production also remains
`SELF_PASS_ENABLED=false`. Health returned 200, unauthenticated quote creation
returned 401, and `begin` returned 404 after deployment.

This mode is authorized for developer-document testing only. It is not
physical-document evidence and does not close the M3 Self gate. The callback
capture seam remains retired; a future physical ceremony requires a separate
live-document deployment and capture-lane authorization. No production,
ledger, proof-history, or money state changed.

## Original verified staging state (historical)

- Infisical is the new project `fac45f92-9450-42fb-8c2f-f20d043fdfab` in
  organization `d9615445-c0d4-445a-ad58-1d55d365635a`; the relevant secrets
  are at the project root in the `staging` environment.
- Value-safe comparisons prove that staging and production Privy values and
  Pirate JWT values are separate. The stale derived staging Privy and upstream
  authentication tuple was repaired and re-verified without printing values.
- PlanetScale has a dedicated `api_next` schema owned by
  `api_next_migrator`. The runtime role is `api_next_app`; both roles have the
  exact search path `api_next, pg_catalog`. Unrelated-schema access is denied.
- All 12 checksum-pinned migrations are applied. The migration ledger matches
  the reviewed manifest hash
  `dff403966354712b3648ac8db2290a5770a6fc3e6de8c36f56f64c5fa0a56e6a`.
  The schema contains 36 tables, all owned by the migrator. Runtime CRUD
  passed and runtime DDL was denied.
- The temporary provisioner role `arhnkpu17vll` was deleted after
  provisioning.
- Staging uses the staging-only Hyperdrive
  `pirate-control-plane-staging`, ID `11c1ad1806004f3b87fa771833093132`,
  with caching disabled and limit 5. The public staging API hostname is
  `api-next-staging.pirate.sc`.
- The Self-disabled staging baseline was
  `734a588d-406c-4f2e-82fa-2c30e64ddfd7`. Self was then enabled in staging only.
  The passing mock ceremony ran on version
  `d0c2d426-e269-4d7e-9826-993fef98f041`; staging was then restored to
  real-document mode on version `8eaf64fa-6cc1-4d48-bb33-213c46cdf775`.
  Health returned 200, JWKS returned 200, the public-profile probe returned
  404 (demonstrating that the DB-backed route was reached), and missing/invalid
  authentication returned 401.
- The first health probes used an explicit Cloudflare IPv4 resolution while DNS
  A propagation was incomplete. A and AAAA records subsequently published, and
  a normal direct health request returned 200.
- The first deployment version (`e4c...`) returned 500 because the JWT PEM
  entries contained trailing newlines. The Worker was redeployed with
  canonical trimming, and the two new-project staging entries were then
  normalized and value-safely re-verified.
- The jobs configuration has the staging Hyperdrive ID, but the jobs Worker
  has not been deployed.

No physical real-document ceremony has completed. After Self enablement,
health returned 200, an unauthenticated Self session start returned 401, and
unknown or malformed callback targets remained redacted 404/400 responses.

## Staging mock ceremony evidence

The approved staging-only mock window described in this historical section was
enabled by deployment configuration, never in production. Mock launches used
`staging_https`, Celo Sepolia chain `11142220`, and fresh sessions after every
configuration change. The later real-document deployment and the current M3
developer-mode override are recorded above; production was not mutated.

The initial mock ceremony attempts exposed two integration defects before the
passing run:

- The generic callback response did not speak Self's provider protocol. The
  provider now owns the exact acknowledgment: handled outcomes return HTTP 200
  with `{result, status, id}`. Malformed callbacks, unknown providers/sessions,
  storage failures, and provider infrastructure failures retain their closed
  generic error behavior.
- The launch compiler required `document.valid` but did not request Self's
  `expiry_date` disclosure. The verifier therefore produced no usable expiry
  and the fail-closed claim normalizer correctly rejected `document.valid`.
  The compiler now requests expiry exactly when that requirement is present.

Published commits are `f337a63` (provider callback acknowledgments) and
`0b1d5b8` (document-expiry disclosure). GitHub Actions run `32107951218`
passed at `0b1d5b8`. Local validation passed 606 unit tests and all 32 workerd
tests, with zero failures.

The accepted session identifier is recorded only by SHA-256 digest:
`f0f69006158235c3809979825a38b11178158f948ecab198d3f31daf679b19e1`.
Its read-back proved:

- terminal status `completed`, one completion event, one evidence receipt, and
  one consumed accepted attempt;
- provider/issuer `self.pass`, method `document`, protocol `self-pass-v1`,
  environment `staging`, dynamic configuration pinned to SDK
  `1.2.0-beta.1`, and proof-session provenance;
- issuer/RP scope `pirate-social`, with no action scope;
- receipt kind `self.pass.attestation.1`, metadata limited to passport
  credential type and source attestation type, and valid SHA-256 evidence hash;
- assertions `age.minimum = 18`, `credential.subject_unique = true`, and
  `document.valid = true`, all at `document_zk` assurance and co-bound to the
  same subject;
- one valid SHA-256 subject key, initial binding epoch 1, and matching active
  binding; and
- zero `human.unique` assertions.

The live rejection matrix also passed:

- Bound claim rejection digest
  `e62c4725129a0caa6841dab9e56eaa2e7f0b0e124a9c6dd10af3dc3dd03ab237`:
  one durable `consumed` attempt, pending session, zero completion events, and
  zero receipts.
- Structurally valid, correctly session-bound, cryptographically invalid proof
  digest
  `8b232047e1249a0a0e7fe75ed89a78114efbc0ee3afa2ae2623c4b7a6aaeeb29`:
  Self-shaped HTTP 200 acknowledgment with `result=false/status=pending`, one
  temporary `leased` attempt, zero completion events, and zero receipts.
- Terminal same-idempotency replay through the shared completion path returned
  HTTP 200 with `completed=true`, `replayed=true`, and the same session ID,
  without provider work or another ledger write.

The accepted raw provider callback was deliberately neither logged nor stored,
so a byte-identical public callback replay could not be performed after the
fact. The terminal replay above proves the common idempotent completion path,
but it is not represented as a byte-identical provider-callback replay. A
future physical-document ceremony must arrange a value-safe one-shot capture
or controlled provider retry before submission if that exact transport case is
still required.

### Staging rollback

- The reviewed post-window real-document deployment was
  `8eaf64fa-6cc1-4d48-bb33-213c46cdf775`. If a later staging deployment
  regresses, use Wrangler's explicit version rollback to that ID, then verify
  `/health` returns 200. The current developer-mode staging binding should
  keep `SELF_PASS_MOCK_PASSPORT=true`; a physical ceremony requires a fresh,
  separately authorized live-document deployment instead.
- Do not reuse a session minted under the other mode; create a fresh session
  after any mode-changing redeploy.
- These instructions target `pirate-http-worker-staging` only. Production
  remains outside this rollback and was not changed by the ceremony.

## Published and observed code state

- The runtime code baseline at the incident was `6ab70b6`. It includes staging
  identity bootstrap `169fe46` and the Privy ES256 verification fix
  (`6ab70b6`). The current ceremony-tested code is `0b1d5b8`.
- GitHub Actions runs `32072658803` and `32107951218` are green.
- A mandatory stop condition fired when the Infisical CLI displayed secret
  values without `--show-values`. Six displayed credentials are treated as
  compromised. The command transcript is the exposure; no value is reproduced
  in this document, repository, or handoff.
- Newly created staging roles were deleted: `gu82o6klxlqi` (runtime),
  `ligllds7lfbk` (migrator), and `mjm5w2rt6zig` (provisioner).
- The empty `api_next` schema was dropped after proving zero tables and no
  migration ledger. Six `/services/api-next` entries were deleted, as was
  the secure temporary directory.
- The incident-era statement that no migration, Hyperdrive configuration,
  Worker, custom-domain route, or deployment occurred is retained here for
  historical context. The current state above supersedes it for staging.

## Historical incident and containment

## Credential impact and redaction boundary

The earlier equality-only audit proved that the old staging and production
`/services/api` entries contained identical `PRIVY_APP_SECRET` and
`PIRATE_APP_JWT_PRIVATE_KEY`. That finding explains the original stop; it is
not evidence that the new staging project is still sharing those values. The
new project’s staging/production Privy and Pirate JWT values are now proven
separate by equality-only checks.

The following are redaction rules for all future evidence:

- Never print, paste, commit, or transmit secret values, even partially.
- Redact private keys, JWTs, tokens, passwords, DSNs, URLs with embedded
  credentials, and CLI output that may contain values. Secret names, paths,
  resource IDs, counts, and equality-only results may be recorded.
- Use value-safe inventory and equality-only comparisons; do not use
  `infisical secrets` table output for inventory, with or without a display
  flag.
- Keep temporary evidence outside the repository, remove it after use, and
  treat any accidentally displayed value as compromised without copying it.

## Current gates

1. Keep Self enabled only in staging; production must remain disabled.
2. Run one fresh physical real-document Session A. Record only redacted session,
   receipt, assertion, subject binding, provenance, pinned `pirate-social`
   scope, and `credential.subject_unique` evidence.
3. The staging mock accepted-completion, terminal replay, bound-rejection, and
   unbound-invalid-proof cases are complete. Byte-identical public callback
   replay remains explicitly unproven.
4. Audit this redacted staging mock evidence before beginning the pure
   evaluator. It may be used as a development fixture; it must not be labeled
   physical-document production evidence.

The original restart checklist and its stop conditions remain retained below
as historical evidence. They do not authorize repeating already-completed
provisioning steps.

## Original tranche sequence and current disposition

The sequence below is retained to preserve the interrupted-tranche record. The
completed items are annotated by the current verified state; pending ceremony
work remains the active checklist.

For historical reference, the original sequence was:

1. Reconfirm this file against current external state; do not trust IDs if
   resources have changed. **Complete for the state recorded above.**
2. Decide the staging API hostname/route without displacing the existing
   `staging.pirate.sc` service. **Complete:** `api-next-staging.pirate.sc`.
3. Establish the dedicated PlanetScale `api_next` schema, migrator role,
   runtime role, explicit search paths, grants, and default privileges. Prove
   the runtime role cannot migrate or access unrelated schemas. **Complete.**
4. Create the new-project staging secret set and install the reviewed values.
   Keep values out of logs and repository files. **Complete and value-safely
   re-verified.**
5. Run the migration dry-run, then apply migrations with the dedicated
   migrator connection, and verify the ledger by read-back. **Complete:** 12
   migrations match the manifest hash above.
6. Create a staging-only Hyperdrive configuration against the least-privilege
   runtime role and update both Worker configs. **Complete:** the HTTP Worker
   is deployed; jobs configuration is updated but jobs is not deployed.
7. Deploy the HTTP Worker with `SELF_PASS_ENABLED=false`. Verify health,
   authentication, and database connectivity before introducing Self.
   **Complete for the recorded probes.**
8. Install the reviewed Self/Privy/JWT secrets and enable `self.pass` in
   staging only. **Complete; post-enable fail-closed probes passed.**
9. **Mock complete; physical document deferred.** Run a fresh live Self
   ceremony with a supported physical document, then arrange a value-safe
   byte-identical callback replay. Capture session, receipt, assertion,
   subject-key/binding, provenance, pinned `pirate-social` scope, and
   `credential.subject_unique` evidence without recording private document
   data.
10. **Complete in the mock window.** Separate fresh sessions proved a
    cryptographically bound but policy-rejected proof and a structurally valid,
    correctly session-bound, cryptographically invalid proof. Read-back proved
    the durable consumed attempt for the former and temporary lease for the
    latter; malformed pre-admission input was not used as lease evidence.
11. **Complete for the mock ceremony.** This redacted staging evidence report
    contains the deployed commit, Worker route, Hyperdrive ID/name (not
    credentials), migration ledger and checksum manifest, ceremony outcomes,
    database invariants, and rollback instructions.
12. Audit that report before beginning the pure evaluator slice. The first
    evaluator vertical should consume the staging ceremony evidence and decide
    the curated 18+ policy. ZKPassport follows the evaluator; its verifier VPS
    remains a separate later concern.

PoW remains outside this tranche. The schema supports atomic grant consumption
with a content write, but burn safety is not a product guarantee until the
protected-action use case performs both in one transaction.

## Gates-v2 staging re-verification — 2026-08-19

The current staging target is the dedicated `api_next` schema in the authorized
`pirate-staging` instance, reached only through the staging runtime/migrator
credentials. The ledger contains all 22 repository migrations through
`0022_m3_community_purchase_immutability.sql`, with checksum verification
passing. The runtime grant preflight passes after narrowing M3 append-only,
policy, operator, and snapshot permissions; no M3 funding rows existed before
traffic.

The staging-only fixture `staging-gates-v2-age18` is active and gated. The
committed seed procedure installed `curated-age-v1` and its current-policy
pointer. The pinned policy hash is
`6c2c4bfa0b842cc8afea19d0df3f576fa5d1779162b235d922be6cb3f39f11a0`. The
decision-record count was zero before any join attempt.

The first HTTP deployment used Self-disabled configuration at version
`1a5d966e-4e4a-4f6a-a7f2-afff9fdd5061`. After baseline checks, Self was enabled
only in staging at version `b3a7be94-b56c-4996-891a-a4cd737694d1` on
`api-next-staging.pirate.sc`. `/health` returned 200; the gated community
preview returned 200; unauthenticated join eligibility and verification-session
start returned 401; malformed `self.pass` callback input returned 400. No
physical-document ceremony or real ZKPassport proof has been run in this
tranche.

The current staging Infisical set has no funding RPC. The Worker therefore has
the explicit invalid HTTPS sentinel `https://rpc.invalid/`, which preserves a
fail-closed money path without selecting an unknown provider. Replace it with
an authorized real staging RPC before testing purchases or launching.
