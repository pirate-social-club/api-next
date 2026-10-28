# Staging parent TXT continuity

Same-root owner recovery can replace the parent-chain verification TXT while
leaving delegation and the served DNS zone unchanged. The full canonical parent
resource hash changes. Ordinary inventory renewal deliberately refuses that
change. A distinct `staging_owner_txt_refreshed` adoption records the reviewed
successor without relaxing ordinary renewal or using gateway relocation.

This path requires an activated staging import, a current active creator-owned
route, and a verified parent-chain TXT recovery descended directly from that
route's recorded database-time expiry transition. It refuses other recovery
authority kinds and authoritative-DNS challenges. It does not recover a pair
whose DNS inventory and ownership proof have both expired. Before starting the
one-hour owner challenge, establish at least three hours of remaining validity
in the old DNS inventory and health. Retain exclusive chain, zone and namespace
writer custody through recovery and adoption. A family/limit expiry operation
needs a fresh candidate read proving its exact selection before execution.

Retain the validated complete parent records before the wallet UPDATE and after
its current-chain confirmation. Inspect the unsigned transaction under the
existing wallet workflow, preserving delegation and every unrelated record.
The only resource change admitted here replaces exactly one whole TXT record
matching the expired control identity with one matching the newly verified
recovery challenge. TXT chunks are joined to identify each control value; all
other record bytes, order and chunk boundaries must remain identical. Duplicate
old or new identities, appending a challenge and unrelated changes are refused.

After normal owner recovery has refreshed its app and sale dependencies, read
their current activation identities and generations, the DNS generation and
health generation, and the canonical route's exact evidence and consumed
recovery attempt. Bind them in one review file:

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
