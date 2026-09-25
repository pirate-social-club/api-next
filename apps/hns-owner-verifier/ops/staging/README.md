# Staging regtest observer configuration

The configuration is for the isolated CI-host regtest node, not mainnet or
production. Encode the parsed JSON with JSON.stringify and validate those bytes
using decodeHnsControlObserverConfigurationBytes. Pretty-printed source bytes
are not the stored document. The canonical compact document is 873 bytes with
SHA-256 e838222720d4f69477d58a3f76f772b8bbdee608c0592a62c1dff6068becf9e8.

Before deployment, independently qualify the staging provider database and
Hyperdrive, reconcile its migration ledger, and register the exact configuration
through a bounded operator transaction. An existing reference/version must
match both bytes and digest; refuse drift rather than overwrite immutable
configuration. Read back the committed bytes over a fresh connection. Never
use a production credential, database, observer or configuration as a fallback.

The Worker has no public route, workers.dev endpoint or preview URL. Its VPC
binding names only the dedicated staging observer service. The chain genesis
and driver reference must also agree with live regtest observations. The
one-hour evidence lease and tip-freshness checks require a fresh fixture chain;
they do not authorize background mining or represent mainnet block durations.

This configuration supports the maintained verifier. New community provisional
imports do not acquire an additional off-chain name-signature requirement.
Actual UPDATE publication, current/safe resource evidence, authoritative DNS,
certificate validation, activation and browser acceptance remain separate
maintained-path requirements. Configuration tests and a dry-run bundle prove
neither database registration nor deployed end-to-end behavior.
