# Staging gateway fingerprint successor

This command changes only the Solid ingress fingerprint in the existing public
staging gateway manifest. It preserves the executable bundle, source, listeners,
credentials, DNS zone bytes, inventory, chain evidence, DNSSEC keys and TLS
certificate identity. It supports exactly the two current roots, 8s28 and a18n,
and refuses another root bound to the predecessor gateway.

Prepare the exact successor gateway directory and qualify its startup/readiness
before attesting the reviewed rotation. The attestation is the maintained
`hns-reviewed-gateway-rotation-v1` document; it must name the exact manifest bytes.
It is fresh gateway evidence only. DNS evidence remains inherited from each
root's recorded health observation, with its original provenance and expiry.
Expired or changed underlying authority requires the corresponding fresh proof.

Use clean, published, independently reviewed API source and the existing managed
staging operator login. The input JSON contains `previousManifest`, `nextManifest`
(exact canonical JSON strings), `readiness`, `executeBy` (within fifteen minutes)
and an absolute new `outputPath`. No credentials belong in input or output files.

Run `bun scripts/hns-staging-gateway-successor.mjs prepare /absolute/input.json`.
This reads current state only and writes a frozen plan with its digest. Review
both roots' generations, retained evidence, fixed health TTLs and the exact
gateway manifest. Preflight is read-only:

```sh
bun scripts/hns-staging-gateway-successor.mjs preflight /absolute/plan.json SHA256
bun scripts/hns-staging-gateway-successor.mjs rehearse /absolute/plan.json SHA256
bun scripts/hns-staging-gateway-successor.mjs commit /absolute/plan.json SHA256
```

Rehearsal executes both roots in one serializable transaction and rolls back.
Commit uses that same transaction boundary. DNS, app and sale selectors are
locked and compared with the reviewed predecessor. DNS zone revision advances
as persistence metadata; its bytes are unchanged. Each root has distinct
operation IDs. Actual successor health deadlines are checked inside the
transaction and cannot exceed the earlier predecessor/inventory deadline.

The database command does not switch the host gateway or deploy Solid. Coordinate
the host manifest, both Solid reference variables and API staging pin in the
same bounded release. Preserve the predecessor gateway directory. A recovery
after committed selectors uses a newly reviewed advancing successor, never an
update or rewind of historical activation rows. An uncertain commit requires
reading current generations before any further action; this command never
retries it. Keep the normal guarded Solid/API release and app/claimed/unclaimed
serving checks. No production or financial activation is supported.
