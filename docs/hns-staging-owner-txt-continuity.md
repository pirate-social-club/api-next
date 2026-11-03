# Staging parent TXT continuity

Same-root owner recovery can replace the parent-chain verification TXT while
leaving delegation and the served DNS zone unchanged. The full canonical parent
resource hash changes. Ordinary inventory renewal deliberately refuses that
change. A distinct `staging_owner_txt_refreshed` adoption records the reviewed
successor without relaxing ordinary renewal or using gateway relocation.

This path requires an activated staging import and a genuine creator-owned
parent-chain TXT recovery descended directly from the route's recorded
database-time expiry transition. It refuses other recovery authority kinds and
authoritative-DNS challenges. The one-hour owner challenge remains bounded by
its actual deadline. Retain exclusive chain, zone and namespace writer custody
through recovery and adoption. A family/limit expiry operation needs a fresh
candidate read proving its exact selection before execution.

With live predecessor DNS and health, normal recovery refreshes the existing
active app and sale dependencies before adoption. The historical live-DNS
operation requires at least three hours of old serving validity when starting
its owner challenge; its sealed receipts and expired execution windows remain
historical evidence.

When both ownership and DNS validity have expired, staging recovery may retain
the fresh verified ownership while deferring host refresh. Deferral requires
both active app and sale revisions to reference the exact ownership evidence
from the database-expiry transition and the same current expired DNS generation.
It does not advance their pointers or restore serving. Mixed current and
predecessor references, suspended capabilities and unrelated predecessors do
not qualify. A fresh reviewed operation must obtain the complete current-chain,
DNSSEC and DANE observation and perform the authority adoption below before
claiming that hosts are available. The old live-DNS operation is not replayed.

Retain the validated complete parent records before the wallet UPDATE and after
its current-chain confirmation. Inspect the unsigned transaction under the
existing wallet workflow, preserving delegation and every unrelated record.
The only resource change admitted here replaces exactly one whole TXT record
matching the expired control identity with one matching the newly verified
recovery challenge. TXT chunks are joined to identify each control value; all
other record bytes, order and chunk boundaries must remain identical. Duplicate
old or new identities, appending a challenge and unrelated changes are refused.

After genuine owner recovery, read the current app and sale activation identities
and generations, the DNS and health generations, and the canonical route's exact
evidence and consumed recovery attempt. App and sale must either both reference
that recovered ownership or both retain the exact expired predecessor described
above. Bind the actual identities and generations in one review file:

```json
{
  "version": "hns-reviewed-staging-owner-txt-v1",
  "root_label": "example",
  "community_id": "community-example",
  "route_binding_id": "route-example",
  "binding_generation": 3,
  "evidence_ref": "recovered-evidence",
  "recovery_attempt_id": "verified-recovery-attempt",
  "dns_zone_activation_id": "dns-example",
  "previous_generation": 25,
  "previous_health_generation": 1,
  "app_host_activation_id": "app-example",
  "app_generation": 2,
  "sale_namespace_activation_id": "sale-example",
  "sale_generation": 2,
  "previous_chain_records": [],
  "chain_records": []
}
```

The arrays above are placeholders, not usable evidence. Their complete validated
records must hash to the locked predecessor and freshly observed parent resource
respectively. The command derives both authorized TXT identities from the actual
expiry/recovery lineage in PostgreSQL; the review cannot supply a substitute.
The current evidence must remain unexpired after full live reobservation. The
same review is independently revalidated inside shared successor promotion.

Use the existing provisioner `--adopt-zone observe` command and staging managed
configuration to obtain the full current-chain, DNSSEC and DANE observation.
Its unchanged-zone diagnostic may say ordinary adoption has no delta; the
explicit TXT review selects this separate branch. The entire served zone and
SOA serial, DNSSEC keyset, gateway and certificate must remain unchanged.

```sh
bun run hns:provision-authority-root --adopt-zone adopt \
  --observation /absolute/observation.json --expect-result-sha256 <sha256> \
  --expect-delta staging_owner_txt_refreshed --mode dry-run \
  --owner-txt /absolute/owner-txt-review.json --expect-owner-txt-sha256 <sha256>
```

Run a reviewed dry run, then a rehearsal and inspect its rollback before commit.
The file digests bind the exact reviewed bytes. Relocation and TXT reviews are
mutually exclusive. Rehearsal executes the real atomic successor writers and
rolls them back. Commit advances inventory, DNS, app, health and sale together;
unknown commit outcome requires generation readback before any retry. Verify
all serving selectors, the unchanged zone, new chain reference and ordinary
renewal afterward. Wallet broadcast reconciliation, fresh operational readiness
and exact source review remain prerequisites; this command does not start a
challenge, sign a transaction or broadcast one.

After recovery and adoption, the coordinated guarded staging Jobs release
enables challenge-free active-lease renewal with the existing staging verifier
service and its `hns-owner-staging-mainnet-v1` configuration pin. The legacy
challenge writer remains disabled. A one-hour lead admits up to twelve scheduled
polls across eligible roots at the existing five-minute cadence; the existing
three-attempt-per-binding-generation bound remains. Check the eligible-root inventory and provider
pin before activation, then verify a real renewal and its alert/readback path.
Do not deploy this enabled Jobs configuration while manual recovery or adoption
is incomplete. Production configuration remains unchanged.

## Recovery deployment package

The intermediate staging deploy pin deliberately retains the accepted c8cd1fb6
gateway and 614a197b ingress composition from a191aa7c. This permits the paired
expiry HTTP recovery source to deploy through the unchanged guard while the
retained authority still binds that gateway. The future v4 cookie gateway
manifest remains preserved separately; it is not the recovery deployment pin.
Production references and runtime source remain unchanged by this pin selection.

The integration coordinator must bind fresh gateway readback and exclusive
canonical Solid source custody to the accepted be40 source and its retained
matching build before the normal guard runs. This document grants no checkout,
deployment or host operation. After genuine owner recovery and unchanged-gateway
TXT adoption, prepare and review the separate paired cookie package and restore
its new staging pin through the normal source path. Never claim that an old
gateway readiness observation proves the future native cookie package is live.
Every staging Jobs release carrying enabled active-lease renewal remains held
until manual recovery and adoption are complete.
