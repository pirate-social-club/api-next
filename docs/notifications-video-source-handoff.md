# Video destination source handoff

Source work against parent-adopted contract SHA256
`36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19`.
The exact 241-line candidate and accepted text/song contract
`0b9b8c4282957eb7c190c7d97a68be13607e73f64c1cc8d53c03108ff87b4bba`
remain unchanged. This document grants no migration, publication or runtime admission.

## Current intake and proof status — 2026-10-17 supersession

The [current Solid navigation intake](notifications-solid-navigation-handoff.md)
now incorporates this adopted extension: primary `/post/:postId` works without
an alias, historical `/posts/<encoded ID>` uses only its literal persisted exact
alias, generated video detail has `route:null`, and comments remain bounded inline
targets. Text/song contract/metadata rules are unchanged. This source availability
does not authorize the separate old-policy drain/cutover or paired serving admission.

Completed local-proof supersession, 2026-10-17: parent executed exact source98
`6271bb2a8629bb35d9146f3602edb222196d921f505250ceab200a2de70adb53`
after distinct preexecution acceptance. Retained receipts are workspace
`.archive/v1-functional-repair-successor-20261015/adopted-feature-dispatch-20261016/notifications-source98-scram-native-role6-and35/{intent,results,consumption}.json`.

| Completed local suite | Cases/assertions | Whole-file wall / rounded-up planning cost | Entry calls | Log SHA256 |
| --- | --- | --- | --- | --- |
| Hardening | 6/418 | 108.974427s / 108975ms | 6 | `a34e2283c8ee975fad2eb37b5dc8fdd1353480c9dc65e847d49b432e719c7eb9` |
| Native Notifications | 35/1348 | 229.024078s / 229025ms | 12 | `a3d831cd68b33acfd4676ec6955a5346be9c0b0206cacbba629d4869331b4c24` |

Both exited0 with their exact fresh fences and cleanup0clients/0schemas/0roles;
negative-password28P01 and positive actual LOGIN controls passed. Hardening
completed the four-role HTTP, first Jobs/forward delivery, inherited default,
private evidence denial, deletion/Telegram and immutable-history workflow.
This supersedes its earlier UNRUN/unmeasured/active-diagnosis status. Imported
fixture growth still requires fresh whole-file measurement even when entry-call
counts stay12/6; these observations are planning only, not six-shard CI acceptance.

Historical source92 full check passed; full test failed with6146pass/3skip/1fail/
37502 assertions at the five-shard bound, leaving storage/node/workerd unreached.
Its194323ms native35 observation and separate hardening5pass/1fail/52/42501 run
remain distinct historical receipts; no failure is relabelled by source98's pass.

Parent has also sealed/package-verified client0.121.0 at tar SHA256
`70c02f0a2fdc7913db52b82a627b1b0bf76e9c3d2eeb7a19770ac5f2f6d138f3`.
Final source/provenance binding, required full/PG gates, independent numbered
migration review, historical alias inventory/collision disposition, controlled
cutover, actual serving authority and consuming Solid acceptance remain held.
These dated facts supersede earlier present-tense UNRUN/provisional-client status
below. Required check/test/storage/node/workerd/general6/recovery/HNS/PG18,
final committed migration review and paired serving gates remain pending;
the prior phase failures, outcomes and exact receipts remain historical.
No runtime, schema, role, policy or cutover state changes in this documentation phase.

## API and producer changes

- Existing generated public post ID/slug operations retain their auth/errors and wrapped post-age response. `PublicVideoPostDetailResultV1` is an explicit video branch: real `LocalizedPost` and required `VideoPostProjectionV1`, `route:null`, no canonical/song activity metadata. Text/song retain the existing reader and metadata policy. Sitemaps exclude video.
- `VideoDetailStore` is nonfrozen application ownership. HTTP composition supplies `makeControlPlaneVideoDetailStore`; neither video selector calls `contentStore.getPost` or a second authorizer. `READ_VIDEO_DETAIL_SNAPSHOT_V1` uses indexed primary/alias selection and one statement for classification, tuple validation, references, enrichment, persona redaction and content. Its SQL helpers are STABLE and share that statement snapshot. Non-age refusal precedes age-only refusal; eligible malformed projection is unavailable with an internal cause.
- Both original-audio and song-reference production transactions require the authoritative fixed publication ID before Post insertion, then ensure the exact alias before downstream publication effects. Existing durable IDs are retained. Unbound IDs use the adopted UTF8/u32be/SHA256 derivation, before intent dispatch. The proposed database fences also refuse old/random producers and terminal publication without the matching projection/alias. Published reload reconciles durable Post/projection/alias identity without repairs or side effects.
- The existing alias registry gains only `video-receipt-exact-v1` provenance for new exact video bindings. The dedicated allocator never calls generic allocation, suffixes, reassigns another alias or treats a different alias as success. Existing `post-slug-v1` rows remain immutable and may be retained when already exact.
- The strict post path union includes `/post/:postId`. Resolver video paths use the owned codec and must match `post_id`. Shared SQL applies the current video guard to bounded ancestry and ordinary inline continuations. Existing depth/window/cursor contracts remain intact. Unsupported/missing/unsafe destinations redact; media/post/ancestor age refusal is 404 and target-only age remains the existing bare variant.
- Nullable soundtrack persona references explicitly represent current account/persona erasure. This is a nonfrozen generated model delta for independent review/client intake; no replacement identity or private account ID is emitted. Current inaccessible song references refuse the video detail/thread branch rather than exposing their title or identity. Existing poster/playback endpoint contracts and authorizers are unchanged.
- P1 successor: analysis binds to its own owned sealed capture revision/digest for both intents. Original publication binds that capture; song-reference publication binds the plan's accepted master, its distinct digest/key/version/ETag/size and the same capture source, frozen plan and committed song edge. The shared STABLE guard still evaluates authorization, projection and denial classification in the caller's one-statement snapshot. No media endpoint semantics changed.

## Unapplied SQL and controlled cutover

Parent preserved the reviewed73 source at `5db135d3e53ab074eacf11c581e8a3805addd8aa`,
then merged main `6cf3018177d05c05b8e8aeaa25e81ec11e5c8799` without committing.
Four conflicts were mechanically resolved; parent reports0 unmerged paths.
Current merge-order sources below retain their exact prior SQL bytes and still
require independent final migration review; this writer does not stage/apply them:

- Former provisional Notifications0269 is `db/postgres/migrations/0271_notifications_inbox.sql`.
- Former destination candidate is now0272; former alias-audit candidate is0273.
- The cutover remains a separate operator-only candidate, outside baseline migration application.

1. `db/postgres/migrations/0272_notifications_video_destination.sql`: fixed identity, exact registry inserts, immutable ownership fences, snapshot authorization and inline navigation functions.
2. `db/postgres/migrations/0273_notifications_video_alias_audit.sql`: indexed 50-source `(created_at,post_id)` keyset audit/materialization, durable immutable plan assignment and item evidence, retained blocked/unknown outcomes and immutable cutover receipt. A proposed unique video source→Post binding index supports that cursor/ownership invariant; actual duplicate bindings require preflight and block this candidate, never deduplication or history rewrites.
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

The prior seven video/ACL real-PG cases are retained through the existing
`notifications-repository.pg.test.ts` maintained partition. Its completion
sentinel now requires all35 cases:20 prior +10 snapshot +4 inventory/admission
+1 deep-target. The prior LOGIN case also gains real video read/recovery/erasure
checks under its separate runtime role. No prior case/assertion was removed.
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
Ordinary behavior cases retain the generated baseline, with the existing
0271–0273 compatibility overlay only when its objects are absent. That
privilege-stripped baseline does not establish effective ACL parity.
The ACL case alone now explicitly selects `full_migrations`: the new dedicated
schema must have no relations, functions, types or migration ledger before and
after its existing role/membership/hostile-default callback. The schema-scoped
connection must select only that schema and the same creating role. The maintained
checksum loader and runner apply the complete contiguous0001–0273 set with an
exact empty starting ledger; the resulting ordered checksums and ledger/private
table owners must match. There is no baseline first, one-shot0273 replay over
objects, fabricated ledger, fixture-added revoke or cutover during initialization.
Existing operator grants and controlled cutover remain later, separate actions.
This initialization completed in the exact source98 native35 run above.

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
Parent then ran the exact73-path successor: **20pass/0fail/560 assertions**,
exit0, exact `notifications-postgres-complete\n` sentinel, log SHA256
`be5e9beef1b5b133010e3f250f0027d190338fe7d6a93fd611da3f36134c5547`.
Independent review accepted those bytes for pre-integration source review only.
That result does not cover the merged source or the new matrix below.
Parent subsequently ran the exact79-path matrix manifest
`268520862657b803594dd3d0239cc36b9b7f5cc87007847291de936b0517a104`:
**20pass/15fail/574 assertions**, exit1,132.03s, no completion sentinel.
Full log SHA256 `487e64eb52bd45ece042ed3a63c16696f39a6952bc8bd2fdad25d0578c8db10b`
is retained independently. All15 new cases failed with23505 on
`persona_community_bindings_persona_id_key`: their shared helper tried to bind
the already inbox-bound first personas to the video community. No intended
snapshot/inventory/admission/deep behavior was reached or proved by those cases.
The existing20 cases passed, including the extended LOGIN read/replay/erasure
case; that is not first-time Jobs delivery under the runtime role.

The current fixture repair reuses an active video-community persona or creates
an additional persona through the maintained wallet/profile activation protocol.
It checks the original first-persona/binding rows remain unchanged and verifies
the active account/community selection used by real comment submission. A
socket-free protocol regression covers creation, reuse, suspended-persona
exclusion and activation failure; it is not PG/ACL proof.
Parent later passed all35 cases on the exact80-path historical repair. After
parent baseline/reset/foundation-catalog generation, exact83 manifest
`361704fcdb06d503a1cc82041f13f9128001f540ad313bfd321b6bc1a2b6cc30`
actually returned **34pass/1fail/1259 assertions**, exit1,202.34s, no sentinel.
The independent terminal diagnostic binds log SHA256
`2707bdc9e2af3683497ab27103525e80e585f1287910cf940f6dd8c1bd4161f3`.
The ACL case failed its first private-table `has_table_privilege=false` assertion:
the generated baseline omits0273's one-shot ACL revocation, and the old
existing-function check skipped that migration. Remaining denial/operator
assertions were not reached in that run; no live ACL defect is inferred.
The later source98 ACL-initialization successor completed all35/1348 with its
fresh exact fence; that pass does not relabel the83-path failure.
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

- Parent source98 completed all35 on fresh schemas. The prior20/560,20pass/15fail/574, historical15/5, historical80-path35-pass and generated83-path34pass/1fail results remain separately bound receipts. No completion marker is borrowed. Registration, case bodies, timeouts and the35-success-only fence remain unchanged. ACL proof uses full migrations; ordinary cases retain the generated baseline. Future source/fixture changes and required full CI still need fresh parent execution.
- `notifications-video-snapshot.pg-cases.ts`:10 cases gate primary/alias/resolver inside the actual statement after snapshot establishment, observed via separate backend lock waits. A competing connection commits current hold/member/lifecycle/age changes before release. Old complete projection/branch and fresh refusal/redaction are required; age/non-age precedence, referenced-song floor, target-only age and ancestor age are separate. Immutable publication tuple tampering must be refused/rolled back; no fake committed revision is introduced.
- `notifications-video-deep.pg-cases.ts`: source requires369 real comment/reply publications,41 siblings at each depth0..8. Each new synthetic sibling group receives one explicit tied comment-row timestamp, with unchanged receipt/fact/delivery snapshots asserted; normal guards stay enabled. Before hiding any root, ordinary page1 must contain20 visible roots excluding the selected21st root, page2 must start there, and all9 positioned20-item windows must report eligible earlier rows. Only then are earlier roots hidden and the indicator rechecked. Root and depth4 hidden-anchor continuations cross current readers; public primary/alias detail, current member/ancestor refusal, bare age placeholder and immutable history are also required. This unchanged case also passed in source98's complete35 run; imported fixture growth requires fresh measurement and proof.
- `notifications-video-admission-matrix.pg-cases.ts`:105 real published sources,50/50/5 inventory checkpoints, actual audit COMMIT/lost-ACK restart, collision publication rollback, overlapping native publication/materialization transactions, fixed upper boundary and next-run arrival inclusion. Retains actual synthetic105 EXPLAIN data; LIMIT is a returned-row bound, never a scanned-history guarantee.
- Same module demonstrates local cutover COMMIT/lost-ACK exact reconciliation without reinstall/receipt mutation, outbox/alias NOWAIT rollback, and publisher observed waiting on real outbox exclusion then committing in the new cohort. Its preselected old fact is already terminal: this is replay without backfill, not a suspended pending-recovery selection race. The separate source98 hardening case now proves first-time Jobs and forward delivery under disposable LOGINs; actual serving authority and cutover admission remain separate holds.
- Current producers guarantee terminal exact aliases and atomic notification receipts. Historical missing/invalid/alternate/colliding published aliases and pending pre0271 facts require reviewed pre-extension fixture inputs; current producers cannot create those states. No such video/notification history is forged, no alias removed and no new guard bypass introduced. The reference-age race reuses the reviewed song-reference helper's historical background-song bootstrap; it proves the guarded video/read boundary, not the song's own publication pipeline. Actual historical inventory remains parent-held; unresolved collisions block admission.
- Final serving-role ownership/inheritance/superuser admission, retained historical-ID/bootstrap matrix, deeper held/deleted-parent variants and larger inbox/unread/recovery/namespace scale plans remain independent parent proof obligations. Synthetic test roles and deterministic media ports establish no live-role, codec or consumer acceptance.

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

Parent retains all Git/index/commit custody over the uncommitted6cf3018 merge,
0271–0273 ordering/final migration review, DB/ACL execution, baseline/reset/catalog,
full gates and a new immutable client release. Parent provisionally regenerated
merged0.120 artifacts and then the83-path baseline/reset/foundation catalog;
no immutable client release is claimed. This writer leaves accepted001..270,0271–0273 SQL/checksums,
accepted241-line contract, frozen5, baseline, generated/version/lock/artifacts and
prior receipts byte-exact to the new admission beforeimage. No integration or
runtime acceptance follows the parent’s pre-integration source review.
The direct-publisher fixture in the existing broader video PG suite now uses the
fixed golden identity for its unchanged source keys. That suite still requires
the parent-integrated migration/baseline before execution.
No source or live whole-v1 acceptance is claimed.
