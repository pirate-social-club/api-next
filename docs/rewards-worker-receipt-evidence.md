# Worker receipt evidence for the combined staging window

The `megapot_receipt_read` event is emitted by the jobs Worker's attested RPC
client after its own `eth_getTransactionReceipt` request. It records only public
transaction and block identities, a bounded result classification, observation
time, attestation, chain, Worker version, job attempt and client identity.
Provider URLs, response bodies, logs, credentials and signed bytes are omitted.
Logging failure leaves the coordinator outcome unchanged.

`not_found` means the provider returned null. `provisional` means the matching
transaction had no sealed block hash; its coordinator result remains null.
`receipt_candidate` means parsing succeeded, not that canonical inclusion or
finality is proven. `invalid_response` and `provider_failure` preserve the
adapter's existing rejection. Canonical block and confirmation checks remain
with the coordinator.

Sequences identify reads within one client and job attempt. They do not prove
the first read ever across Worker instances or retries. The per-transaction
counter holds at most 1024 transaction identities. On saturation, previously
tracked transactions continue counting and new transaction counters are null;
identities are never evicted and relabelled first.

Before the approved live purchase, open the jobs log capture and verify the
exact deployed source/version, active attestation, database control row and
bindings. Preserve every receipt event for the purchase transaction from the
attempt that submits it through final reconciliation. Correlate the signed and
submitted effect's database hash with requestedTransactionHash, Worker version,
attestation and attempt. Record the earliest matching provider event, including
a null or provisional response, without substituting an independent RPC probe.
Keep subsequent candidate and final canonical receipt evidence together.

Missing or interrupted logs do not satisfy #475. Neither these tests nor an
isolated purchase fixture close the live gate. A real purchase, captured from
its beginning, and its eventual canonical confirmation are still required.
