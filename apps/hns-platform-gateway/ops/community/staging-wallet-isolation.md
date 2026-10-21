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
