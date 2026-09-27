# Staging mainnet observer configuration

`observer-configuration.json` is the staging configuration for Handshake
mainnet. It uses the existing read-only mainnet observer service while keeping
the staging database, Hyperdrive binding, provider reference, snapshot store,
and Worker separate from production. The former regtest configuration is kept
as `observer-configuration-regtest.json` for the private regtest fixture.

Encode the parsed mainnet JSON with `JSON.stringify` and validate those bytes
with `decodeHnsControlObserverConfigurationBytes`. Pretty-printed source bytes
are not the stored document. The canonical compact document is 879 bytes and
has SHA-256
`e324b6a48768aefcc7bef53cb271133ab45709fe40be2c45117b3dfac3fcc4ae`.

Before deployment, independently qualify the staging provider database and
Hyperdrive, reconcile its migration ledger, and register these exact bytes in
`hns_control_observer_configurations` through a bounded staging operator
transaction. An existing reference and version must match both bytes and
digest; refuse drift rather than overwrite immutable configuration. Read back
the committed bytes over a fresh connection. Do not register this staging row
in production.

The Worker has no public route, workers.dev endpoint, or preview URL. Its VPC
binding uses the existing read-only mainnet observer service. The chain
genesis and driver reference must agree with live mainnet observations before
the first Bob update. This configuration has a 30-day evidence lease for TXT
ownership evidence; the full delegated import has its own readiness and
renewal checks.

This configuration alone does not establish end-to-end behavior. The staging
provisioner also needs its mainnet reader and the public staging nameservers,
signed zone, gateway certificate, and browser acceptance checks.
