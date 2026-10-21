# Move public staging off the wallet host

The target staging gateway is94.103.168.209. The public manifest decoder,
deployment preflight and challenge-only delegation guard must agree with the
new address. The existing live manifest and deployment pin remain unchanged
until the complete paired release is ready. These source changes alone do not
move staging or authorize substituting a manifest in stored activation records.

Preserve the four staging DNSSEC signing keys and on-chain DS sets. Reuse the
existing public PowerDNS on .209 as signer. The provisioner performs distinct
primary and secondary writes; never point both roles at the same API, because
secondary provisioning can demote the signer. The existing private secondary
on .209 is a possible secondary target, subject to retained-zone and TSIG
acceptance. No additional public listener is needed for this topology.

Merge the8s28 TLS and proxy route into the existing .209 Caddy. The standalone
caddy-public-8s28.json describes that route boundary; do not start a second TLS
service on .209. Preserve the certificate/key and its TLSA association, strip
untrusted gateway and forwarder request headers, and retain the exact HTTPS/SNI
boundary expected by the loopback gateway. Its certificate covers8s28 and
*.8s28; do not infer coverage for the other staging roots.

Coordinate API and Solid preflights, runtime manifests, ingress references and
supported activation provenance with the new gateway release. Do not edit
activation rows to bypass a421 response. Update the8s28 glue and affected zone
records only after the new signer and gateway are ready. Accept DNSSEC/DANE,
claimed200 and unclaimed421 through the actual serving path before retiring
.167's staging services, the .209-to-.167 API tunnel and its exact authorized key.
Retain rollback and the encrypted staging recovery point throughout the move.

This source phase retains the live staging deployment guard and Bob challenge
delegation at81.15.150.167. The209 manifest and Caddy example are relocation
candidates, not active references. Do not update the API pin, paired Solid
bindings or saved activation rows until the supported successor/address
transition has been rehearsed and the new signer and gateway are qualified.
The owned DoH rollout on the production primary is independent of that cutover.

## Supported activation successor

Use the provisioner's `adopt-zone` command with the explicit
`staging_gateway_relocated` delta. Its `adopt` step also requires
`--relocation <absolute path> --expect-relocation-sha256 <hex>`, binding the
exact reviewed JSON file. Run dry-run, then rehearse, then commit from a fresh
observation under exclusive authority-writer custody. Rehearsal rolls back the
entire inventory, DNS, health, app and sale successor transaction.

The review version is `hns-reviewed-staging-gateway-relocation-v1`. It names
the root, previous DNS and health generations, previous and new gateway IPv4
addresses, complete previous and next chain records, and a
`hns-reviewed-gateway-rotation-v1` object. The latter binds the predecessor
gateway, canonical successor manifest, profile digests, unchanged certificate
SPKI, observation time and shadow readiness attestation. Build this evidence
from actual readback after qualifying the gateway; a template is not readiness.

Only staging can use this operation. It moves the apex, app and wildcard A,
the existing mapped wildcard AAAA, and 8s28's ns1 A to94.103.168.209. Every
other canonical zone record and TTL remains identical, apart from increasing
the SOA serial. Complete chain records must match the predecessor snapshot;
only8s28's ns1 GLUE4 may move, preserving NS, DS and unrelated records.
The observer runs again inside the database fence before promotion. The new
snapshot, gateway and zone become a single successor; saved historical
activation references are never edited. Recurring renewal binds to that
adopted full zone and continues to reject changes that were not adopted.
