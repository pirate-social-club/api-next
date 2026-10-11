# Provisional import ownership before readiness

The wallet-independent community import provisions DNS before proving control.
It deliberately leaves `ownership_result_sha256` absent. Lifecycle observation
can reach `checking_authority` without the older publication-continuation path
having completed the namespace ceremony. Readiness then rejects the operation.
Activation and member-name enablement also consume the retained namespace
ownership evidence, so filling a hash column alone cannot repair the journey.

The repair preserves the existing namespace completion writer and verifier.
Before readiness, the provisioner takes a fresh bracketed safe-chain read.
It must match the current lifecycle's complete encoded resource and contain
the exact persisted TXT challenge, with TXT chunks concatenated within each
record. Current-view agreement alone will not admit this preparation.

An atomic writer retains that safe observation and enqueues the existing
community publication continuation. The writer fences the operation's
generation, revision, root, namespace session, plan, current community authority
and live readiness-job lease. A stale read or lost lease cannot enqueue work.
The proof is retained independently from provisional admission; admission is
never relabeled as satisfied ownership.

The HTTP Worker's existing bounded continuation obtains a real namespace
ownership result through the verifier and existing completion repository. That
path already persists the ceremony result and route ownership evidence used by
activation and Names. Its existing observation writer then binds the verified
result to the import and advances the session to `observing`. No alternative
provider signature, invented result hash, or serving shortcut is introduced.

Readiness waits with a recorded ownership-pending code until that result
exists, then retains the existing DNSSEC, DANE, full-resource and freshness
checks. A changed current resource remains a refusal even when the preceding
safe observation passed. Queue identity and proof identity are replayable;
publication continuation and activation remain distinct operations.

Invalid context finalizes its lease with `readiness_context_invalid`.
Storage outages record a sanitized unavailable code and retry. Missing EXECUTE
privilege records `readiness_ownership_permission_denied` and retries the same
job under the existing backoff. A later grant can recover that job without
resetting it; permission denial does not admit proof or advance readiness.
Private connection details are not printed. Failure to finalize must propagate
rather than claim successful recording.

Regression coverage exercises provisional admission, plan exposure,
current and safe lifecycle observations, safe TXT preparation, namespace
completion, readiness and the retained authority needed by Names. Negative
cases cover missing and mismatched TXT, current-only reads, wrong root or
resource, stale observations, generation/revision changes, lost leases and
replay. PostgreSQL coverage is required for the atomic proof and queue fence.

This is a local implementation design. A migration ordinal must be checked
again before integration. Publication, merge, runtime grants, migration apply
and staging or production deployment remain separate owner gates. Staging API
upload requires coordination with the rewards release window. The existing
fp1c session and all transaction/click fences remain intact.

## Reviewed release requirements

Apply migration 0234 through the repository migration runner. Its guarded
block installs EXECUTE on enqueue_hns_safe_ownership_completion_v1 for the
existing hns_root_import_executor_login_v1 provisioner role, matching 0225.
If that role is absent, the migration emits a warning. Production uses a
separate executor; the reviewer reported a staging catalog observation on
2026-09-30 with lifecycle grants to shared Worker/runtime login
pscale_api_gy9lze83nr29 and no executor role. The provisioner's connected login
was not directly observed, so it still must be established during preflight.
Being an API login does not disqualify the login actually used by the
provisioner. Do not put an environment-specific staging role name in the
migration or assume the production grant applies to staging.

As the function owner/migrator, explicitly grant the function to the observed
provisioner login during the approved release, then read its effective
privilege before starting the repaired service. Reobserve the deployed login
at execution time; do not rely on the historical staging catalog observation.
With psql's provisioner_login variable set from that observation, the release
statement and readback are:

```sql
GRANT EXECUTE ON FUNCTION enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)
  TO :"provisioner_login";
SELECT has_function_privilege(:'provisioner_login',
  'enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)',
  'EXECUTE') AS provisioner_can_prepare_ownership;
```

Require the readback to be true in the target schema. This source example is
not an applied runtime grant. Privilege regressions cover production's
separate executor and staging's shared login, including refusal before the
explicit staging grant and no direct proof-table mutation privileges. The
approved release order is migration, grant, effective privilege readback, then
provisioner deployment. A real PostgreSQL regression also denies preparation,
records the named retry on the existing lifecycle job, applies the grant and
reclaims that same job to retain safe proof and queue namespace completion.

Preparation runs its database read and enqueue on separate short-lived
connections, closing the first before chain RPC. Unexpected SQL faults
propagate as operational failures; only malformed input parsing and casting
become invalid_proof. Revision conflicts and evidence that becomes stale
between observation and SQL acceptance are distinct retry outcomes. The
preparation outcome allowlist is pending, revision_conflict, stale_proof and
lease_conflict; refused and unexpected outcomes fail visibly. Permission
errors separately retry with the named code above. An expired lease still held
at the same fence can reschedule its existing job. A reclaimed lease cannot
finalize stale work. No replacement import or fabricated ownership is created.
Both authorization kinds have mocked preparation coverage; the complete real
PostgreSQL ceremony covers community_provisional, not signature admission.

Before release, observe the actual staging HTTP Worker and verifier releases,
ownership capabilities, scheduled publication continuation and database role.
The repair uses their existing continuation rather than changing their runtime
source. A Worker upload is needed only if those deployed capabilities are
missing; coordinate any upload with the rewards release window. The local
source's staging capability does not establish production's deployed capability.

Re-read fp1c's existing session, lifecycle job, publication deadline and safe
resource immediately before execution. If the old job has exhausted its lease
budget or a publication continuation is already failed, stop and prepare a
separately reviewed recovery for that exact job. This implementation does not
reset terminal jobs, change a deadline or create a replacement import.

After release, require retained safe ownership proof, a satisfied namespace
ceremony, route ownership evidence and fresh readiness on the existing session.
Then resume its fenced finish, correctness validation and capped Handshake
browser acceptance. The chain UPDATE and every existing execution fence remain
unchanged. Production needs the same repair and a capability preflight before
another no-signature import.
