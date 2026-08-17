# Self staging incident and restart record

Status: blocked by credential rotation; not completed. Updated 2026-08-18.

This is the durable, redacted record for the interrupted Self staging tranche.
It is authoritative for the incident state and restart gates. Production was
not authorized for changes and remains out of scope.

## Published and observed state

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
- No migration, Hyperdrive configuration, Worker, custom-domain route, or
  deployment occurred. The pre-existing `api_next_app` was untouched;
  `bookings`, `public`, and production were unchanged.

## Credential impact and containment boundary

An equality-only secure audit proved that staging and production
`/services/api` contain identical `PRIVY_APP_SECRET` and
`PIRATE_APP_JWT_PRIVATE_KEY`. The web repository-level Privy app ID has no
production override. Consequently, rotating either shared Privy/JWT
credential affects production and is outside the authorization for this
tranche. Do not attempt a staging-only workaround.

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

## Mandatory restart gates

Resume is blocked until all gates below are explicitly authorized and
recorded:

1. Coordinate an authorized rotation of the shared Privy app secret and JWT
   signing key pair across every consumer and source store.
2. Invalidate or assess existing sessions as applicable to that rotation.
3. Re-run the complete inventory using value-safe commands and equality-only
   checks. Confirm no production resource, secret, or route is in scope.
4. Recreate the staging-only roles and `api_next` schema with least privilege;
   prove role grants, search paths, zero unrelated-schema access, and the
   migration-ledger starting state.
5. Use only reviewed secret-loading procedures. Never use `infisical secrets`
   table output for inventory.

Until these gates pass, Self remains disabled and the original tranche is
paused. The real-document Session A is deferred.

## Remaining original tranche steps

After the restart gates, continue the original sequence exactly:

1. Reconfirm this file against current external state; do not trust IDs if
   resources have changed.
2. Decide the staging API hostname/route without displacing the existing
   `staging.pirate.sc` service.
3. Establish the dedicated PlanetScale `api_next` schema, migrator role,
   runtime role, explicit search paths, grants, and default privileges. Prove
   the runtime role cannot migrate or access unrelated schemas.
4. Create `/services/api-next` in Infisical and install the reviewed staging
   values. Keep values out of logs and repository files.
5. Run the migration dry-run, then apply migrations with the dedicated
   migrator connection. Record every applied migration and the exact
   `checksums.json` hash set. Verify the ledger by read-back.
6. Create a staging-only Hyperdrive configuration against the least-privilege
   runtime role. Replace the nonexistent staging ID in both Worker configs in
   a distinct commit and run both Wrangler dry-runs.
7. Deploy the HTTP Worker with `SELF_PASS_ENABLED=false`. Verify health,
   authentication, and database connectivity before introducing Self.
8. Install the reviewed Self/Privy/JWT secrets, enable `self.pass` in staging
   only, deploy, and confirm production remains disabled and unchanged.
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
