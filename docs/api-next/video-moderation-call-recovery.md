# Video moderation call recovery

Video image moderation uses one durable claim for each operation, creation
revision, video revision and frame role. The claim also binds the submission,
community, derived-frame reference, frame digest and deterministic moderation
request identity.

`sending` means only that the database committed the claim before the provider
boundary. It does not prove that the provider received the request. A process
may stop immediately before dispatch, during transport, after the provider
accepts the request, or after a response arrives but before the successful
result commits. Those cases are intentionally indistinguishable. A replay
therefore treats `sending` as unresolved and does not call the provider again.
This is at-most-one automatic dispatch, not exactly-once provider execution.

`succeeded` means the normalized provider result is durable. Workflow replay
uses that result without another provider call. The aggregate safety evidence
and safety stage fact remain separate writes; if either fails, their replay is
derived from the persisted frame results.

An unresolved row has no automatic recovery path. It leaves the safety stage
fact absent and publication remains unreachable. Investigation must preserve
the row and correlate its request identity, timestamps and provider-side
evidence without issuing another request. Any later choice to import a proven
result, abandon the submission, or authorize a new creation revision requires
a separately reviewed operator procedure. The runtime must never change a
`sending` row to `succeeded` without the original normalized provider result,
and it must never clear or replace a claim merely because it is old.
