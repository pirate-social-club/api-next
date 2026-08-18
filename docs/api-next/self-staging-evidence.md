# Self staging incident and restart record

Status: staging infrastructure is provisioned and the HTTP Worker is deployed
with Self disabled. The real-document ceremony and ceremony matrix have not
begun. Updated 2026-08-18.

This is the durable, redacted record for the Self staging tranche. It preserves
the earlier incident and containment history, then records the verified
post-restart state. No secret value is recorded here.

## Current verified staging state

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
- The staging HTTP Worker is deployed with Self disabled. The current good
  version is `734a588d-406c-4f2e-82fa-2c30e64ddfd7`. Health returned 200,
  JWKS returned 200, the public-profile probe returned 404 (proving the DB
  path), and missing/invalid authentication returned 401.
- The first health probes used an explicit Cloudflare IPv4 resolution while DNS
  A propagation was incomplete. A and AAAA records subsequently published, and
  a normal direct health request returned 200.
- The first deployment version (`e4c...`) returned 500 because the JWT PEM
  entries contained trailing newlines. The Worker was redeployed with
  canonical trimming, and the two new-project staging entries were then
  normalized and value-safely re-verified.
- The jobs configuration has the staging Hyperdrive ID, but the jobs Worker
  has not been deployed.

No Self ceremony has begun. Self remains disabled until the staging smoke
checks are complete and the real-document gate is deliberately started.

## Published and observed code state

- The runtime code baseline at the incident was `6ab70b6`. It includes staging
  identity bootstrap `169fe46` and the Privy ES256 verification fix
  (`6ab70b6`). This incident record changes documentation only.
- GitHub Actions run `32072658803` is green.
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
  Worker, custom-domain route, or deployment occurred is retained below as
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

1. Keep Self disabled until the staging smoke checks and configuration audit
   are complete.
2. Run one fresh real-document Session A. Record only redacted session,
   receipt, assertion, subject binding, provenance, pinned `pirate-social`
   scope, and `credential.subject_unique` evidence.
3. Run the accepted-completion, identical-replay, bound-rejection, and
   unbound-garbage callback cases using fresh sessions as required. Inspect
   temporary leases versus durably consumed attempts.
4. Produce and audit the redacted staging evidence report before beginning the
   pure evaluator. The first evaluator vertical consumes this real staging
   evidence.

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
   staging only. **Pending; Self is still disabled.**
9. **Deferred: real-document Session A.** Run a fresh live Self ceremony with
   a supported physical document, then resend the byte-identical callback for
   the replay check. Capture session, receipt, assertion,
   subject-key/binding, provenance, pinned `pirate-social` scope, and
   `credential.subject_unique` evidence without recording private document
   data.
10. Use separate fresh sessions for the remaining cases: Session B for a
    cryptographically bound but policy-rejected proof during the approved
    staging-only mock window, and Session C for a structurally valid callback
    with correct session context but an unbound/invalid proof. Record consumed
    attempts for Session B and the temporary lease for Session C; malformed
    pre-admission input does not prove the lease invariant.
11. Produce a redacted staging evidence report containing deployed commit,
    Worker route, Hyperdrive ID/name (not credentials), migration ledger and
    checksum manifest, ceremony outcomes, database invariants, and rollback
    instructions.
12. Audit that report before beginning the pure evaluator slice. The first
    evaluator vertical should consume the staging ceremony evidence and decide
    the curated 18+ policy. ZKPassport follows the evaluator; its verifier VPS
    remains a separate later concern.

PoW remains outside this tranche. The schema supports atomic grant consumption
with a content write, but burn safety is not a product guarantee until the
protected-action use case performs both in one transaction.
