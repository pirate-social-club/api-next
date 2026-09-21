# Video moderation call recovery

Video image moderation uses one durable claim for each operation, creation
revision, video revision and frame role. The claim also binds the submission,
community, derived-frame reference, frame digest and deterministic moderation
request identity.

This mechanism covers per-frame image moderation only. Caption moderation is
outside this claim boundary.

`sending` means only that the database committed the claim before the provider
boundary. It does not prove that the provider received the request. A process
may stop immediately before dispatch, during transport, after the provider
accepts the request, or after a response arrives but before the successful
result commits. Those cases are intentionally indistinguishable. A replay
therefore treats `sending` as unresolved and does not call the provider again.
This is at-most-one automatic dispatch, not exactly-once provider execution.
Transport timeouts and generic provider 5xx responses are included in this
ambiguous class because either can occur after provider execution. The current
adapter does not classify either outcome as proven non-execution that is safe
to redispatch.

`succeeded` means the normalized provider result is durable. Workflow replay
uses that result without another provider call. The aggregate safety evidence
and safety stage fact remain separate writes; if either fails, their replay is
derived from the persisted frame results.

Replay inspects the retained frame claim before it requires provider
configuration or reads the derived frame. A retained `sending` claim therefore
cannot be hidden by a later frame-storage failure, and a retained `succeeded`
result remains usable while its source frame is temporarily unavailable. For a
new frame call, the runtime validates the frame bytes before it attempts the
atomic claim. It rechecks the claim during acquisition so a concurrent winner
still prevents a second dispatch.

Claim acquisition and aggregate-evidence persistence serialize through the
same submission authority row. Before aggregate unavailable evidence commits,
the persistence boundary rechecks every frame whose bytes could not be read or
validated. A concurrent `sending` claim keeps the submission unresolved, and a
concurrent `succeeded` claim must be replayed; neither state may be overwritten
by aggregate unavailable evidence. Conversely, once aggregate evidence is
durable, a late frame claim is rejected. These checks close the race between an
initial claim inspection and a later frame-read failure without creating a
claim before the frame bytes have passed validation.

The database independently requires a `succeeded` claim to contain a complete,
well-shaped provider result. SQL `NULL`, JSON `null`, and malformed results do
not satisfy that invariant, including through direct inserts or updates.

An unresolved row has no automatic recovery path. The workflow records the
submission as `processing_failed` with
`provider_submission_unconfirmed`, leaves the safety stage fact absent and
keeps publication unreachable. The author may use the ordinary, idempotent
cancel endpoint to abandon that exact creation revision. Abandonment is a
terminal author disposition: it retains the immutable source and the
`sending` provider claim for reconciliation, clears no provider identity and
does not authorize a retry or a replacement revision.

Investigation must preserve the row and correlate its request identity,
timestamps and provider-side evidence without issuing another request. There
is currently no maintained path to import a provider result after an
unresolved dispatch or to resume that submission. Such a path, or any new
creation revision using the retained source, requires a separately reviewed
operator procedure. The runtime must never change a `sending` row to
`succeeded` without the original normalized provider result, and it must never
clear or replace a claim merely because it is old.
