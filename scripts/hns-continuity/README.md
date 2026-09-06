# Existing-root continuity ceremony

This operator command repeats the retained-root inventory promotion. It acquires
fresh authenticated HSD responses and two TSIG AXFRs, verifies child and parent
DNSSEC against the chain DS records, and binds the served certificate to TLSA.
It retains the exact DNS and HSD wire responses and the public certificate for
independent replay. The operator's reviewed candidate is promoted through the
existing DNS, app-host, health, and sale-namespace persistence functions in one
serializable transaction.

The command is intentionally limited to the existing topology: mainnet, two
IPv4 authority endpoints under the `pirate` parent, the `pirate-axfr` TSIG key,
and the existing HSD and PowerDNS containers. Endpoints and generations come
from the current root's inventory and database rows. A changed topology requires
reviewing this entry point. This does not implement automatic inventory renewal
or the import scheduler's retry recovery.

## Prepare and observe

Use a clean checkout of the reviewed source commit, with the repository's frozen
Bun dependencies installed. Create a Python virtual environment outside the
checkout and install the hash-locked DNSSEC dependencies. Put that environment's
`bin` directory on `PATH` for every ceremony command.

```sh
rtk proxy python3 -m venv /tmp/hns-continuity-python
rtk proxy /tmp/hns-continuity-python/bin/pip install --require-hashes -r scripts/hns-continuity/requirements.txt
```

The operator needs authenticated Infisical access to
`/services/api-next/operator` in `prod`, and known-host-verified SSH access to
the primary authority host. SSH must support noninteractive access and the
existing `sudo -n docker exec` operations. Credentials remain in process memory;
they are excluded from evidence and child environments. The observer closes
its own SSH forwards and clears the in-memory decoded TSIG key.

Choose a new absolute evidence-directory path for each observation. The
directory must not exist. Supply the retained root and primary SSH destination
from the deployment record; neither is a runtime default.

```sh
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-continuity.ts observe --root ROOT --ssh-host OPERATOR@PRIMARY --directory /absolute/ceremony-directory
```

`observe` uses a read-only database transaction and makes no production writes.
It emits a candidate SHA-256 and the proposed generations. Review the retained
candidate, source commit, inventory validity, DNS/app identities, and current
sale-namespace dependency before confirming the digest. Every observation must
fit within one hour of the database snapshot. The inventory lasts seven days,
and the certificate must cover that full interval.

## Rehearse and promote

Use the same source checkout, evidence directory, and reviewed digest. Replay
verifies the retained DNS signatures and certificate again and recomputes all
candidate artifacts before opening the promotion transaction.

```sh
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-continuity.ts dry-run --directory /absolute/ceremony-directory --confirm-sha256 REVIEWED_SHA256
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-continuity.ts rehearse --directory /absolute/ceremony-directory --confirm-sha256 REVIEWED_SHA256
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-continuity.ts commit --directory /absolute/ceremony-directory --confirm-sha256 REVIEWED_SHA256
```

`dry-run` is read-only. `rehearse` executes the complete transaction and rolls it
back. `commit` checks live DNS/app/health and sale-namespace generations, inserts
the immutable inventory, advances all serving dependencies, verifies selectors,
and commits. It writes a receipt into the evidence directory. No command retries
an ambiguous commit. If commit or receipt persistence fails, read back the
retained generations and candidate operation identifiers before any further
action. A candidate whose generation fence has moved must not be reused.

After promotion, independently read back the database and check the app host,
an issued username, and an unissued username. Record the earlier inventory or
health expiry in the operator checkpoint. The maintained command does not
install a timer or reminder. The next checkpoint is September 10 at 05:00 UTC,
ahead of the existing September 12 expiry.

## Verification

The archived observation fixture exercises deterministic reconstruction and
refusal cases. Python tests replay actual signed DNS responses and the retained
public certificate, including tampering failures. The PostgreSQL test uses the
full baseline and real persistence functions to prove dry-run, rollback after
a late sale-revision failure, atomic serving continuity, and stale-fence refusal.
It is registered in the required PostgreSQL 17 matrix. CI installs the locked
Python dependencies and runs the DNSSEC replay test.

These checks do not establish authenticated new-root onboarding, new handle
claims, backup restoration, clean-device DANE browsing, or automatic renewal.
Those remain separate acceptance work.

## Reviewed gateway-reference rotation

The September 10 checkpoint uses ordinary `observe` with no rotation input.
Do not put a first rotation on that checkpoint's deadline. Rotation begins only
after that checkpoint and the reviewed source lane have completed.

For a later rotation, pass `--gateway-rotation /absolute/rotation.json` to
`observe`. This is a separate reviewed operator attestation with these exact
members: `version` equal to `hns-reviewed-gateway-rotation-v1`,
`previous_gateway_reference`, `gateway_reference`, `profile_sha256`,
`handle_profile_sha256`, `manifest_json`, `observed_at` and `readiness` equal to
`operator_attested_shadow_ready`. The manifest is the exact canonical JSON
string of the combined gateway deployment, without a trailing newline. Its
SHA-256 must derive the supplied gateway reference, both supplied profile
digests must match it, and its certificate SPKI must equal the retained pin.
The attestation time must fit the fresh observation window and remain current
at promotion. The candidate retains this attestation and the predecessor's
health generation; its confirmed digest covers both.

Before attesting readiness, the operator must validate the complete manifest
with the target gateway runtime, prove bundle and source provenance, start the
shadow bundle with its actual credentials, and retain the startup event and
readiness probe. Compare both startup profile digests and gateway reference to
the reviewed manifest. The rotation validator checks identity binding; it does
not replace the runtime's full manifest validation or independently authenticate
an operator's readiness claim. Shadow readiness is not end-to-end serving
acceptance because the existing root still pins its predecessor. Keep the
shadow evidence alongside the candidate for review.

The ordinary authority observation still proves chain, DNSSEC, certificate and
current app serving. The shared successor transaction admits the changed gateway
only with the reviewed manifest binding, rechecks predecessor reference and
health generation, then advances DNS, app, health and sale together. `dry-run`
checks the same rotation fences; `rehearse` executes then rolls back. Removing
or changing the rotation file after candidate review changes the recomputed
digest and is refused. No DNS, TLSA or certificate key changes are included.

The production cutover requires one coordinated runtime and evidence ceremony.
Retain prior manifests, references and Worker versions before it starts. A
restoring promotion uses a new observation and a new rotation attestation whose
target is the prior exact manifest; it advances all generations again. Never
replay the earlier candidate or rewind database selectors. A failed or ambiguous
commit requires database read-back before deciding which runtime set matches the
retained reference. Continuous probes and an explicit sustained-failure threshold
belong to the deployment receipt, not to this source command.

The primary SSH prerequisite includes passwordless `sudo docker exec`, which is
root-equivalent operator access. No secret belongs in rotation input or receipts.
