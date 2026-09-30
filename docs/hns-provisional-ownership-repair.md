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
exists, then retain the existing DNSSEC, DANE, full-resource and freshness
checks. A changed current resource remains a refusal even when the preceding
safe observation passed. Queue identity and proof identity are replayable;
publication continuation and activation remain distinct operations.

Invalid context finalizes its lease with `readiness_context_invalid`.
Storage outages record `readiness_context_unavailable` and retry, without
printing private connection details. Failure to finalize must propagate rather
than claim successful recording.

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

Apply migration 0234 through the repository migration runner and grant the
provisioner's runtime role EXECUTE on
`enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)`
before starting the repaired provisioner. The example role file declares
this grant; changing that file does not apply any runtime privilege. No table
write grant or browser credential is added.

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
