# Staging persona reset runner

This is an implementation checkpoint, not an executable reset runbook.
Only the offline release planner and evidence-consistency validator are
available. Neither opens a database connection or accepts an execution option.
The August rebuild script remains
unchanged and must not be used for this release.

Run `bun scripts/staging-persona-reset-plan.ts --dry-run` from a source checkout
containing the approved Git commit. A named remote ref is not required. A
shallow checkout missing that object fails closed; CI's check job fetches full
history. The planner reads immutable Git objects instead of the current
checkout's migration directory, which already includes an unapproved 0120.
It validates the complete manifest, baseline bytes and every migration before
returning an immutable 0001–0119 plan. It does not run Git fetch itself.

The pinned source is ba0fd44529d834f491879126cdb8c67c4ec9fcdc. Its manifest
SHA-256 is b68453cb883b59d30358a43f2b1a5d44dc2a8bc52a266dedca646f712161ecc9
and baseline SHA-256 is
8d680727f9869a1b9fe24a76674f29306e527df90b5506ebdc574dec88250102.
Changing any pin is a release decision, never a CLI override or automatic
response to a newer main. The ledger validator accepts only the reviewed
0109 prefix; that evidence alone does not identify or authorize a database.

The next implementation must add independently verified target, recovery and
writer-fence evidence before any destructive capability is exposed. The
authoritative task record requires the exact staging Hyperdrive/provider
mapping, a fresh data-bearing capture and isolated restore rehearsal, and the
complete four-Worker writer closure. Receipt claims alone must not substitute
for live target and effective-denial checks. Never log credentials or identity
rows. Check inherited/PUBLIC access, SECURITY DEFINER entry points, existing
transactions and cross-schema dependencies; fail before destruction if any
remains unexplained.

Once those gates exist, reuse the repository migration runner with the full
verified plan once, not the August prefix loop. The migration application
already wraps the whole list in one transaction. Runtime fencing must survive
any replay rollback. Separate tests must prove rebuilt catalog/baseline parity,
zero identity-dependent rows and zero persona-binding evidence, while an
isolated recovery rehearsal restores the captured old data. Restoring a fresh
empty database is not recovery proof. Restore only reviewed runtime privileges
after all verification; do not reuse overlapping old grants as authority for
new objects or enable schedulers/providers.

The version-one evidence-consistency module rejects excess fields, production
targets, wrong release pins, incomplete writer lists, duplicate/runtime-admin
role identities, active sessions/transactions, unresolved dependencies and
stale observations. It binds a single fence generation to the capture, a
distinct retained recovery branch and an isolated rehearsal of that exact
capture/restore point. Ledger, catalog, data, grants, extensions and nonzero
identity-row counts must agree with a fresh source observation. The five-minute
window applies to the final fence observation, not the duration of recovery
capture and rehearsal while the same fence remains continuously held.

These serialized values are untrusted claims even when internally consistent.
The validator returns execution_authorized=false and live_recheck_required=true.
It does not verify provider IDs, connection fingerprints, denial booleans or
snapshot digests against real systems. A collector must independently resolve
the approved provider/Hyperdrive/role tuple, enumerate the actual producer and
dependency closure, check denial through runtime credentials, and compute the
source/capture/restoration fingerprints. It must validate the actual full 0109
ledger through the planner's ledger check. Do not accept user-supplied JSON or
this consistency result as authority to destroy data.

The future live boundary must obtain its clock independently of the receipt,
bind observations to the canonical target tuple and exact capture/restore point,
and attest the dependency scan version, complete closure and unknown-object
counts. The four Worker names do not by themselves enumerate their queues,
schedulers, callbacks or other producers. Same-generation strings do not prove
continuous fencing. Immediately before any destructive statement, repeat the
trusted target, ledger, dependency and effective-denial observations while the
fence remains held; a five-minute receipt is not permission to skip that check.
The owner disposition string is descriptive here, not an authorization token.

The disposable-staging disposition permits the original multi-community
conflict to remain in pre-reset evidence. The collector must record those
aggregate counts and their versioned digest without guessing a binding or
requiring pre-reset zero conflicts. Only post-replay verification requires
empty identity state and zero binding violations.

No destructive adapter, live evidence collector, runtime fence, grant-restoring
path or Postgres reset test is implemented in this checkpoint. Independent
review and the required Postgres 17 and secret-boundary gates remain mandatory
before the parent release coordinator may use a completed runner.
