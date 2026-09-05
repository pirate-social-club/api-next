# Video delivery implementation boundary

This is an incomplete delivery-lane checkpoint based on main 3a3b3637.
The delivery writer owns the separate feat/video-delivery-completion worktree;
execution and Solid worktrees were inspected only where needed, never edited.

The first repair preserves a published video as pending when the left join
finds no Stream ingest row. Missing columns, inconsistent bound identity and
unsupported intents still fail closed. Digest binding no longer proves ready
playback: current schema has no durable encoding or configured-access fact.
The mapper cannot emit ready until that authority is implemented. Feed and
guarded Post tests exercise absent, not-started and bound states, retaining
the privacy-negative and age-gating fixtures.

This repair does not add an enrichment consumer, access endpoint, thumbnail
serving route or provider call. It must not be reported as the completed lane
or as playback acceptance. It changes no SQL, migration, generated contract
or client artifact. Current client provenance remains 0.61.0.

Execution reserved 0120_video_workflow_execution.sql. Its shared source-grant,
stage-timings and membership-loss interfaces are not yet frozen in its current
record. Delivery must consume those interfaces instead of introducing another
gateway, ledger or membership-only client cut. No later migration number is
reserved by this checkpoint. Recheck all branch inventories before allocating
one and regenerate baseline/checksums only against the agreed merge order.

Playback access policy remains a decision before affected implementation.
The proposal presented to the workspace owner is a five-minute token with
renewal after four minutes and no download entitlement. Every issuance and
renewal must check current eligibility. This proposal is not ratification.
The configured customer host must be validated; no account-specific host or
signing key is assumed or provisioned. Provider configuration and actual
enforcement remain staging evidence, not facts inferred from documentation.

Cloudflare documents requireSignedURLs as the control that removes bare-ID
access, and signed tokens replace the ID in player/manifest paths. These are
design references only:
https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/

Completion still requires the durable enrichment/recovery consumer, separate
encoding/error facts, eligibility-checked access and poster routes, the
combined immutable client release, PostgreSQL and required CI gates, final
review, preservation and lane retirement. Live Stream and combined browser
proof remain in video-original-audio-staging-proof.
