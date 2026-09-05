# Staging persona reset runner

This is an implementation checkpoint, not an executable reset runbook.
Only the offline release planner is available. It neither opens a database
connection nor accepts an execution option. The August rebuild script remains
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

No destructive adapter, recovery receipt format, runtime fence, grant-restoring
path or Postgres reset test is implemented in this checkpoint. Independent
review and the required Postgres 17 and secret-boundary gates remain mandatory
before the parent release coordinator may use a completed runner.
