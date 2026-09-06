# Shared activity authority: first atomic implementation tranche

This tranche follows the independent money-admission checkpoint 85ee3b2d and the paired ownership agreement b049a42f. It changes the shared database and repository authority for Study and Karaoke. It does not add the explicit persona-preparation endpoint, a client cut, Solid draft behavior or Dance production authority.

## Migration and policy

Immediately before writing 0128_activity_participation_authority.sql, a non-pruning fetch resolved origin/main to 1211e2e924ec55a8f7817db71e8e9328af891ecf. The migration inventory still ended at 0127_video_delivery_ingest.sql. Only the newly reserved migration is written; no historical migration is edited. The schema baseline, checksums and reset SQL were regenerated through the repository generator. The reset SQL is byte-identical because no resettable table or seed changed. No frozen reset-runner release artifact or maintenance guard is edited.

active_activity_persona checks an active account, an available community and an active owned persona with its immutable exact-community binding. It shares row locks on account, community and persona in that order, so a write transaction retains those status fences until commit. Read callers hold them for their read transaction. The HTTP and Karaoke Durable Object compositions select the writable Hyperdrive layer. Statement readonly metadata does not turn its transactions read-only; only the separately selected read-only resolver layer sets default_transaction_read_only. These locking activity predicates are not suitable for that resolver layer. The three repositories share the identity lock order, but SQL expression evaluation does not establish a global identity-versus-resource lock order. Persona retirement locks its persona before presentation changes; no inspected status writer subsequently locks an activity session. This review is not a concurrent deadlock proof. can_account_access_activity_song separately checks the public published song and the existing viewer-specific rating/age policy, retaining a shared lock on the post. Unknown/unaccepted ratings deny. Existing sources support public songs only; this migration does not broaden visibility to members-only content.

The migration replaces the membership condition in guard_study_session and guard_karaoke_session with that identity authority and applies the same resource check. Timezone, frozen source, immutable fields and exact completion evidence stay intact. Study v2 has a separate table, so it gains its own activity-authority insert/update trigger. The original Study trigger never protected Study v2.

The never-joined acceptance test exposed another membership dependency: persona_activity_presentations had a foreign key to community_memberships. It rolled back a successful completion while inserting the default presentation even after the session guards were fixed. The migration removes only that foreign key. The existing exact community/account/persona foreign key to persona_community_bindings stays in place. The role-presentation membership foreign key and require_active_role_persona stay intact.

The binding-source check now admits activity_participation. This supports the next explicit preparation transaction without fabricating a membership source. No production path writes that new source in this checkpoint. Persona create/bind/select behavior needs its own cohesive repository review because the current first-persona and active/wallet transitions must retain their ratified semantics; this tranche does not introduce a partial preparation action or HTTP response.

## Repository boundaries

Study's existing qualification producer now uses the shared authority at entry and retained-session reads, which also protects replay and completion. Presentation changes check current authority before returning an idempotent replay. A protected replay that loses authority returns the existing typed not-found/persona-ineligible disposition instead of a storage invariant error.

Study v2 checks shared authority/resource access at start and session reads, spoken context/reservation/completion, and answer submission. Completed spoken-command replay must still resolve the retained session under current authority before returning its snapshot. Karaoke checks source access and activity authority at reserve/replay, retained attempt reads and finalization. Its finalization check resolves the persisted session against all input identity fields before using the retained attempt replay or committing a result. Recording reconciliation and central cleanup code are unchanged.

These repositories call the same database predicates rather than copying different membership exceptions. active_community_effect remains unchanged for posting and other explicitly membership-scoped effects. Monetary projection functions, campaign subject consumption, policy evidence, offer budgets and payout logic are unchanged. Missing reward evidence continues to produce an ineligible reward outcome while activity completion commits.

## Acceptance coverage

The real Study service now starts, replays and completes for an unverified account that has never had a membership row. Its private qualification and real song leaderboard entry survive; membership, follow, Post, pool-share and reward-credit counts remain zero. Its reward decision says verification_missing. Replaying the start key after the song becomes adult-rated denies protected content. The prior membership-loss completion regression also passes, preserving its verified-nonmember and unverified-nonmember money expectations.

The shared-authority fixture proves foreign, unbound and wrong-community persona denial, account unavailability, community hiding, suspended persona denial, adult rating and nonpublic resource denial, and current authority on presentation replay. The minimal Study v2 source fixture now reaches insufficient-exercises instead of a membership refusal; it is not a composed Study v2 completion proof.

The playable Karaoke fixture reserves and replays after membership loss and permits another private session. Its completion test uses the existing aggregate and diagnostics builders with a zero-recognition result; it proves terminal persistence/replay without claiming a qualifying score or live provider acceptance. An adult-rating change then refuses reserve replay. Existing invalid-persona cases remain.

Independent Megapot and asset-bonus admission matrices remain covered, including current evidence, stale/revoked evidence, no retrospective award and recovery of one provider subject onto a second account. The prior monetary evidence document describes their exact scope.

## Validation history

Both baseline generation runs exited 0. The second was necessary after the never-joined test exposed the activity-presentation membership foreign key. The normalized migration/baseline catalog test passed. Initial TypeScript checking exited 0.

The first focused unit run exited 1: twelve passed and two Karaoke timezone fixtures lacked the newly required resource_eligible field. Updating the test transport's authority row restored the intended timezone assertions; the focused unit rerun exited 0. It includes the migration reader and Karaoke timezone/recovery/retry suites.

The first four-file PostgreSQL run exited 1 with eleven passing and three failing cases. Two fixtures had no accepted song rating, and Study v2's isolated fixture lacked the now-required community and persona binding. The second run exited 1 with twelve passing and three failures: the minimal Study source now correctly returned insufficient-exercises; the second Karaoke reservation reused a unique artifact id; and the never-joined test exposed the real activity-presentation membership foreign key described above.

The third run exited 1 with fourteen passing and one failing case: the newly added Karaoke completion fixture used a completion timestamp before its session creation. The subsequent focused pair passed the migration/baseline catalog but failed the Karaoke fixture's hand-shaped diagnostics. A null diagnostics attempt also failed the database's object-shape constraint. Those fixture failures are retained; the final fixture uses buildKaraokeScoringDiagnostics rather than constructing its evidence by hand.

The final focused Karaoke case exited 0 with one passing case and nineteen assertions. It also verifies that an adult-rating change hides a retained attempt and refuses finalization replay. The full bun run check exited 1 after Effect diagnostics and Biome passed: TypeScript caught two arguments to the catalog test's toContain assertion. The inventory now has a separate 0128 assertion. The corrected catalog case exited 0. A continuation beginning with both TypeScript projects and running every remaining check stage through verify:api-client exited 0. The original full command did not pass; it is not relabelled as a full pass. No full PostgreSQL or Workerd gate ran. The earlier expected-red source remains preserved at its original checkpoint; its current test expectation is now satisfied by the implementation, not suppressed.

## Remaining boundary

The API lane still needs explicit persona preparation and the reviewed endpoint/contract/client release, plus the separately reviewed Dance authority composition. The active Solid writer owns all draft/storage/coordinator files. Reset compatibility and any release-pin amendment remain separate deployment work. This branch is not pushed, deployed or enabled by this checkpoint.
