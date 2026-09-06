# Provider rehearsal evidence

This is not the final recovery copy. Branch persona-reset-rehearsal-20260906
(0ny029b910ob) restores the unfenced rehearsal backup xvvo8r6tcaa5 from staging
main syu03e00w3ux. Its only purpose is restore fidelity and phased-runner/failure
rehearsal on the provider. No Worker should be routed to it. The final live
reset still requires a new verified capture inside the continuous producer
fence.

Retention is bounded: retain through the current rehearsal, then delete with
a provider receipt. The coordinator must review or delete it by
2026-09-07T04:00:00Z; extending that deadline needs a recorded reason and new
date. It is billed at PS_5_AWS_ARM and must not remain as an accidental second
staging environment. This is a recorded deadline, not an automated expiry.

## Restore fidelity, 2026-09-06

Provider role-list metadata was empty. That did not imply lost PostgreSQL
roles. An initial isolated default-credential command returned a CLI shape the
observer did not accept, so no SQL connection followed. The documented raw
reset-default endpoint then issued a credential bound to this isolated branch.
These two credential operations affected only the rehearsal branch; values
were kept in process memory, not printed or persisted. No source credential
was rotated. The default role could read the restored catalog but did not own
api_next, so it was not used to change grants or ownership.

The original runtime and operator passwords subsequently authenticated through
the provider-confirmed restored hostname with this branch's username suffix.
SQL session identities matched the original roles. Thus the restored SQL roles
and credentials survived even though provider role-list metadata was empty.
The reset must continue as the operator, not substitute the default role.

Operator inventory at 04:20:15 UTC confirmed all 109 ledger checksums against
the pinned manifest. All 1,204 relations, 362 routines and 660 types were
effectively owned; schema USAGE/CREATE and ownership were available. There
were 5,933 ACL entries and no explicit column ACLs. The two defaults remained
operator-owned and runtime-granted, without grant option, with digest
f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d,
matching the recorded staging observation.

Installed extension names, versions and namespaces matched staging:
btree_gist 1.8 in public, hypopg 1.4.2 in pscale_extensions and plpgsql 1.0 in
pg_catalog. None needed reinstalling in this observed restore. This is measured
behavior for this branch, not a promise about future provider restores.
Settings were max_locks_per_transaction=64, max_connections=25 and
max_prepared_transactions=0, matching the low-capacity local rehearsal.

The exact pinned 0110 evidence-function prefix was installed inside a bounded
transaction solely for the evidence read, then rolled back. The result was
unbound=2, single-community=3, multi-community=1 and digest
85a756a5f36bcbdec2ce55b9cb108baa82a035e9fdec1761d82819e4861f7817,
exactly matching recorded staging evidence. The ledger was verified against
0109 again after rollback. No binding table or migration was applied.

## Outstanding proof

These observations pass the requested initial ledger/persona/default-ACL/
extension/role checks. They do not prove a complete data-bearing restore
comparison, a successful phased reset or recovery after committed removal.
The provider-safe rehearsal entrypoint and independent review remain before
destructive execution. Do not bypass the local-test URL guard or substitute
invented fence/recovery callbacks. Keep the approved manifest and existing
0119 release pin until an explicit revised release triple is recorded and
verified; the later 386be35a API carries a different migration endpoint.
