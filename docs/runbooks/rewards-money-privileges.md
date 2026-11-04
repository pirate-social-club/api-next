# Rewards money privilege boundary

Migration 0232 revokes DELETE and TRUNCATE on 59 reviewed money tables from
PUBLIC and non-owner table grantees. Table owners retain administration. Existing
SELECT, INSERT and UPDATE grants remain. Cascading revocation removes destructive
grants derived from a non-owner's grant option; other privileges do not cascade.

The inventory covers custody, reward credits and effects, funding and offer
evidence, Megapot accounting, sponsorship and referral ledgers, sponsored Wallet
sends and brake controls. Runtime SQL and migration function bodies contain no
DELETE on these tables. Legitimate deletes in unrelated projection, persona
staging, namespace-token and Telegram-retention repositories, and local Durable
Object storage, remain outside the denial contract.

Staging's schema-wide default table ACL remains unchanged because unrelated
repositories legitimately delete. Production's excess comes from existing grants;
changing a staging default alone would not repair either environment. New money
tables must explicitly remove destructive grants in their own reviewed migrations.
The release preflight refuses unknown or missing money tables, table-owner-
equivalent runtime authority, and effective DELETE/TRUNCATE. Effective checks
include inherited and PUBLIC rights. Catalogue drift requires review, not silent
allowlist growth.

Preserve UPDATE required for accounting transitions and row locks. PostgreSQL
SELECT FOR SHARE can require UPDATE or DELETE; removing DELETE without retaining
an existing UPDATE can break a legitimate read path. Real repository regression
suites remain part of source acceptance.

## Evidence and rollout

The actual forward migration is tested on PostgreSQL 17 with direct, inherited,
PUBLIC and delegated grant-option destructive privileges. Runtime destructive
permissions are removed while ordinary grants, owner administration and unrelated
retention deletes remain. A future money table inherits the unchanged default
DELETE and the inventory gate refuses it. Baselines omit ACLs and cannot prove
a privilege migration by themselves.

The read-only live audit on 2026-09-30 found DELETE on all 55 inspected production
tables and 53 of 56 staging tables. Neither runtime directly owned an inspected
table or held TRUNCATE. The widened preflight also covers objects omitted by that
preliminary name inventory and can refuse missing controls, routines or migrations.
A failed preflight does not mean any grant changed.

Writing and publishing this migration does not authorize live application.
Before rollout, review the exact accepted-main SHA, contiguous ordinal and
checksums, environment, runtime identity, table owners, explicit and inherited
ACLs, operator administration and paused control state. Obtain explicit approval
naming that exact release and environment; staging is also a live grant change.
Apply through the existing migration owner and transactional migration runner.
Do not regrant destructive rights on failure. Run the exact-source runtime release
preflight with the main ledger check and retain its sanitized receipt. A refusal
holds activation. Production signing, caps, legal and contract identity decisions
remain separate launch gates.
