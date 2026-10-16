# Video destination source handoff

Source work against parent-adopted contract SHA256
`36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19`.
The exact 241-line candidate and accepted text/song contract
`0b9b8c4282957eb7c190c7d97a68be13607e73f64c1cc8d53c03108ff87b4bba`
remain unchanged. This document grants no migration, publication or runtime admission.

## API and producer changes

- Existing generated public post ID/slug operations retain their auth/errors and wrapped post-age response. `PublicVideoPostDetailResultV1` is an explicit video branch: real `LocalizedPost` and required `VideoPostProjectionV1`, `route:null`, no canonical/song activity metadata. Text/song retain the existing reader and metadata policy. Sitemaps exclude video.
- `VideoDetailStore` is nonfrozen application ownership. HTTP composition supplies `makeControlPlaneVideoDetailStore`; neither video selector calls `contentStore.getPost` or a second authorizer. `READ_VIDEO_DETAIL_SNAPSHOT_V1` uses indexed primary/alias selection and one statement for classification, tuple validation, references, enrichment, persona redaction and content. Its SQL helpers are STABLE and share that statement snapshot. Non-age refusal precedes age-only refusal; eligible malformed projection is unavailable with an internal cause.
- Both original-audio and song-reference production transactions require the authoritative fixed publication ID before Post insertion, then ensure the exact alias before downstream publication effects. Existing durable IDs are retained. Unbound IDs use the adopted UTF8/u32be/SHA256 derivation, before intent dispatch. The proposed database fences also refuse old/random producers and terminal publication without the matching projection/alias. Published reload reconciles durable Post/projection/alias identity without repairs or side effects.
- The existing alias registry gains only `video-receipt-exact-v1` provenance for new exact video bindings. The dedicated allocator never calls generic allocation, suffixes, reassigns another alias or treats a different alias as success. Existing `post-slug-v1` rows remain immutable and may be retained when already exact.
- The strict post path union includes `/post/:postId`. Resolver video paths use the owned codec and must match `post_id`. Shared SQL applies the current video guard to bounded ancestry and ordinary inline continuations. Existing depth/window/cursor contracts remain intact. Unsupported/missing/unsafe destinations redact; media/post/ancestor age refusal is 404 and target-only age remains the existing bare variant.
- Nullable soundtrack persona references explicitly represent current account/persona erasure. This is a nonfrozen generated model delta for independent review/client intake; no replacement identity or private account ID is emitted. Current inaccessible song references refuse the video detail/thread branch rather than exposing their title or identity. Existing poster/playback endpoint contracts and authorizers are unchanged.
- P1 successor: analysis binds to its own owned sealed capture revision/digest for both intents. Original publication binds that capture; song-reference publication binds the plan's accepted master, its distinct digest/key/version/ETag/size and the same capture source, frozen plan and committed song edge. The shared STABLE guard still evaluates authorization, projection and denial classification in the caller's one-statement snapshot. No media endpoint semantics changed.

## Unapplied SQL and controlled cutover

These are candidate SQL sources, **not numbered/accepted migrations**:

1. `db/postgres/candidates/notifications-video-destination.sql`: fixed identity, exact registry inserts, immutable ownership fences, snapshot authorization and inline navigation functions.
2. `db/postgres/candidates/notifications-video-alias-audit.sql`: indexed 50-source `(created_at,post_id)` keyset audit/materialization, durable immutable plan assignment and item evidence, retained blocked/unknown outcomes and immutable cutover receipt. A proposed unique video source→Post binding index supports that cursor/ownership invariant; actual duplicate bindings require preflight and block this candidate, never deduplication or history rewrites.
3. `db/postgres/candidates/notifications-video-cutover.sql`: only the three eligibility/read/insert-guard replacements, installed by the controlled exclusion transaction. It is never a standalone migration to run before intake.

`makeNotificationsVideoAdmissionStore` and the maintained
`scripts/notifications-video-control-plane.ts` provide explicit start/batch/status,
normal existing 50-fact recovery and cutover entry points. No Worker imports the
control-plane script. Its executable runner currently refuses every URL except
the assigned loopback54388 random `api_next_notifications_*` schema; this phase
does not hand out a production connection runner or resource.

An actual parent-reviewed plan is required before materialization/admission.
Inventory retains source/command receipt digests and exact before/after alias rows.
Each batch returns at most50 sources, with durable checkpoint and unresolved rows;
this does not promise a physical scanned-history bound. Invalid keys, namespace
collisions, invalid source provenance, a video's different existing alias and unknown outcomes remain visible
and block admission. No actual inventory or collision-free claim exists yet.
Resolution of unknown transaction outcome starts with exact persisted evidence;
it does not rotate identities, erase prior audit items or replay notification fan-out.

Alias materialization never changes notification policy. The predecessor's
text/song guard stays in force until explicit cutover. Drain outstanding facts,
including previously acknowledged missed facts, with existing normal recovery.
The short cutover transaction sets bounded deadlines, acquires outbox EXCLUSIVE
NOWAIT first, then alias-namespace exclusion NOWAIT, checks the completed clean
materialization run and producer fences, and refuses if any private-ack marker
remains outstanding. Marker=true already requires an immutable terminal receipt
under the predecessor guard; no history-wide anti-join is added inside exclusion.
Then it atomically installs the three guards and records the exact plan/source and
paired Solid evidence hashes. No draining or alias repairs occur under exclusion.
Explicit committed-receipt reconciliation skips reinstall; unknown commit errors
propagate. Old terminal suppressions, read state, facts and receipt/href bytes
are never reset or backfilled. Newly inserted facts after commit are the new cohort.

Parent must independently review actual PostgreSQL lock/DDL behavior, namespace
coverage fencing, deployed producer custody and roles before executing this plan.
Publication and materialization use the same submission→Post→alias ownership
order; NOWAIT cutover aborts rather than waiting with unrelated locks.
Existing single-alias uniqueness is preserved. An actual different existing video
alias needs the separately reviewed structural successor in the adopted contract;
a cross-post slug collision is a hard block. Neither condition has been inspected
on any live database.
Serving installation of the video resolver/detail extension also waits for
reviewed consuming Solid reader/inline navigation intake; source and disposable
proof can precede that intake. No such serving installation occurred here.

## Focused proof and remaining PostgreSQL work

Local unit evidence covers fixed derivation vectors, both intent dispatches,
owner approval/render completion, simulated rollback/concurrent invocation/lost
acknowledgement, actual persisted-reload adapter reconciliation, exact allocator
refusal, one-statement detail boundary, redaction/age precedence, path/metadata
validation and atomic cutover ordering/refusal/unknown-outcome reconciliation.
These mocks do not establish database isolation, ACLs or production delivery.
Exact commands, failures and final results are in the task-local handback.

Seven video/ACL real-PG cases are registered through the existing
`notifications-repository.pg.test.ts` maintained partition. Its completion
sentinel now requires all20 cases; the cases cannot silently be omitted.
They retain original-audio coverage and add real song-reference reservation,
analysis/policy/moderation, render seal/acceptance and publication with different
capture/master digests, repeated collision rollback, actual committed publication
with lost acknowledgement and durable reload/replay, both detail selectors,
ordinary/owner-approved comments and inline replies, resolver, old-cohort
suppression, cutover, new delivery/recovery/list/unread/read and referenced-song
visibility/age redaction while still unread. The render output/probe/PCM ports are
deterministic; this is not codec/provider proof. The existing historical-song
fixture seeds the reference; video and notification assertions use live guards
and real stores. The separate LOGIN/default-ACL fixture exercises actual evidence
forgery denials and explicit controlled operator workflows; its exact privilege
boundary is in `notifications-runtime-privileges.md`.
The disposable fixture overlays the unapplied candidates only
when their functions are absent; an integrated regenerated baseline supersedes
that temporary overlay.

Parent executed the exact predecessor71 manifest `c99a059163d2fd12823024f6c6c642980293bb9af5a157e468b502e4eff512f2`:
20 cases, **15pass/5fail/404 assertions**, exit1,82.57s, sentinel absent.
The full retained log SHA256 is `49ef2298665bd48d76616f39800d46e9618701a8928f5343dd199fd528b843dd`.
Both collision cases and all13 prior inbox cases passed; four video paths and the
LOGIN workflow failed before the irreversible-age step. Three failures were an
escaped ControlPlaneDb service used after its layer released the session; both
owner-approved paths lacked the moderator account's active first persona.
These are distinct executed failures, not all consequences of the later floor
downgrade defect. Neither a completed ACL workflow nor a complete video path
was established by that run.

The fixture successor keeps audit/drain/cutover actions inside their provided
layer lifetime, with no adapter/error/unknown-outcome changes. It activates the
new moderator account's actual first persona through the maintained wallet,
profile and handle protocol; the additional publication persona is retained.
Reversible privacy/read/replay checks finish before the final song-floor raise.
A new real unread publication is present before that raise; the test then checks
the dependent video/comment cascades, content-free age detail, list/count/read
and resolver/thread denial, retained unread/first-read timestamps and immutable
fact/receipt/inbox state. Nothing lowers floors or publishes after the raise.
The suite remains20 cases. **The repaired PG successor is UNRUN.**
Focused deterministic lifetime regression uses the actual adapter with an
injected socket-free protocol client, including reproduction of the old escaped
service failure; it does not execute SQL or establish PostgreSQL acceptance.

After migration review, the parent can run, sequentially, using only its supplied
fixture environment and task-local sentinel:

```sh
CONTROL_PLANE_POSTGRES_TEST_REQUIRED=1 CONTROL_PLANE_POSTGRES_NOTIFICATIONS_TEST_SENTINEL="$PWD/.wrangler/adopted-source-agent/video-notifications-pg-complete" bun test packages/platform-cf/src/notifications-repository.pg.test.ts
```

Then verify exact sentinel bytes `notifications-postgres-complete\n` and retain
the real assertion/process result. No generation or database command ran here.
Before final source/migration acceptance, extend and run the finite contract
matrix with these actual transactions and no guard bypass:

- Execute all20 registered cases again on fresh synthetic fixtures after reviewed source intake; the predecessor15pass/5fail is retained, with no completion sentinel or proof borrowed. Fixed SQL/JS UTF8 vectors and original cases remain; separate simultaneous publication commits and independent durable historical-ID/recovery races still need real-PG coverage/proof. No repaired-successor PG result exists in this source phase.
- Both selectors paused after statement snapshot establishment while another connection commits hold, membership, tuple/revision or viewer/author erasure changes. Require one wholly permitted snapshot or redacted refusal, including combined age/non-age changes and both age floors. Validate current referenced-song privacy and nullable persona redaction.
- Nested video target beyond20 at each level through8, hidden/removed/adult ancestors, membership revoke, exact target/focus data, hidden cursor anchors, public/member/private/lifecycle cases and inaccessible media. Existing text/song cases remain required controls.
- Inventory >100 actual published sources, invalid keys, alternate same-post alias, cross-post/type namespace collision, concurrent materialization/publication, unknown audit commit and retained blocked rows. Compare all receipt/fact/terminal hashes, not just generated URLs.
- Outbox lock refusal, publisher blocked at exclusion, preselected recovery across commit, zero-marker validation, alias namespace race and unknown cutover COMMIT. No long drain/repair under locks; EXPLAIN actual inbox/unread/recovery/inventory with substantial inaccessible/read history.
- Restricted HTTP/Jobs/deletion and control-plane roles with forward default ACLs. Read roles need the new media/revision/reference/enrichment/persona relations and stable functions; publication roles need exact alias insert/identity functions, not audit writes. Audit/cutover tables and mutators remain control-plane-only. Mutating identity/alias functions revoke PUBLIC execution; parent supplies reviewed explicit grants. Verify negative DML, account erasure, first-read and replay under those real roles.

## Paired Solid and integration boundary

The separate Solid writer must consume a newly published generated client, retain
the real `/post/:postId` and literal `/posts/:slug` readers, and implement the
accepted `/comments/:id` resolving entry plus targeted inline expansion on video.
Use the supplied bounded ancestor/sibling windows, exact target detection and
ordinary continuation; authorized reading must survive unrelated vote failures.
Do not turn video into canonical/SEO/song-activity content or infer IDs from slugs.
Fence loader/SSR/hydration/query keys by selector, target and current session;
sign-out/persona/authorization change cancels work and clears private data/focus.
No GET delivery/read mutation, fragment-only acceptance or speculative fallback.
Paired SSR/hydration/e2e and actual session→inbox→reachable video target proof are
still required before fresh links or video admission.

Parent retains latest-base intake from actual main6cf3018 (Activity0269/forward0270),
Notifications ordinal reconciliation, independent final migration/code review,
restricted-role PG proof, baseline/catalog/full gates, a new immutable client
publication and all runtime custody. This branch's Notifications0269/checksums,
accepted001..268, baseline, frozen5, released client/lock/version and prior
evidence remain unchanged. No ordinal, gap or client version is reserved here.
The direct-publisher fixture in the existing broader video PG suite now uses the
fixed golden identity for its unchanged source keys. That suite still requires
the parent-integrated migration/baseline before execution.
No source or live whole-v1 acceptance is claimed.
