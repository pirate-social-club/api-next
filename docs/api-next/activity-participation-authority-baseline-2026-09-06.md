# Participation authority baseline

This is a test-first checkpoint on `2c7691a70783aba65e280d9b5b489adf42b2a0fc`,
under the active participation record. It changes tests and their suite inventory
only. No production authority, migration 0128, persona surface, contract, client,
Solid persistence, deployment configuration or provider is changed.

## Implementation matrix

| Boundary | Current implementation | Required next change and proof |
| --- | --- | --- |
| Identity and resource authority | `active_owned_persona` checks persona ownership/status; `active_owned_community_persona` adds immutable exact-community binding; `active_community_effect` adds active membership. Neither identity helper alone proves active account or content/rating access. | One shared activity authority must combine active account, owned active exact-community persona, active community and accessible content/rating. Keep posting membership as a separate check. Prove suspended account, foreign/unbound/wrong-community persona and inaccessible/adult content denial. |
| Study v2 start/replay | `study-v2-repository.ts` invokes all three helpers before replay. Its session reader itself scopes account/community/session without that membership helper. | Replace start/replay membership checks through shared authority; separately trace every continuation/answer path and database trigger. Do not infer read/write equivalence. |
| Study qualification producer | `activity-qualification-repository.ts` start preparation/transaction and presentation selection require membership. `guard_study_session` also requires it on UPDATE. | Amend the guarded database authority before removing application guards. The desired completion-after-leaving test currently fails at the database trigger and rolls back completion. |
| Karaoke | `reserveSession` loads accepted song/alignment first, then membership-gates identity before replay. `guard_karaoke_session` also invokes membership on INSERT and UPDATE. | Reuse the shared activity authority and replace the trigger membership condition; retain immutable session/scoring authority, consent, content/rating checks, quota and provider readiness. Existing playable fixture demonstrates both new-session and replay refusal after leaving. |
| Dance private attempts | Production `makeProductionDanceAttemptServices` intentionally supplies null session/upload authorities; the store does not contain a matching membership check to remove. | Implement/review the existing authority ports within the admitted private/shadow scope. Do not enable grading or money. Shared persona preparation and Solid draft handoff remain coordinator-owned prerequisites. |
| Reward admission | PostgreSQL AFTER INSERT qualification triggers `project_megapot_pool_share_from_qualification` and `project_asset_bonus_claim_from_qualification` perform the actual monetary admission writes. They check exact Very palm proof provenance, same-subject claims, current subject-binding epoch, expiry and revalidation, then campaign-scoped subject consumption. TypeScript-only searches miss these writers. | Preserve these independent checks. Extend proof to verified nonmember, unverified practice, member without evidence, subject reuse across accounts, standings paths and no retrospective admission. Do not replace provider-subject evidence with a claim of proven human uniqueness. |
| Publication | Video publication keeps its current transaction membership fence; Study/Karaoke producers are not Post commands. | The activity authority change must not weaken publication. Retain the already merged video membership-loss/rejoin/revocation drills and add the Dance-to-Post composed case once the handoff exists. |

## Tests and evidence

The new `Activity participation authority implementation baseline` PostgreSQL
case characterizes the current gap rather than accepting it: exact-community
identity remains valid after leaving, while Study v2 start and presentation
selection refuse it. Foreign/unbound/wrong-community identity is still denied.
The fixture isolates authority before Study item selection; it is not a complete
Study v2 success fixture. It also proves these refused commands write no sessions,
presentation, Post, reward decision or pool share.

The extended `requires an explicitly bound persona at session start with no
fallback` case uses the existing real playable Karaoke fixture, starts/replays
successfully as a member, then demonstrates that leaving blocks the same replay
and a new session even though the persona remains bound. These characterization
expectations must change with implementation; they are not ratified product
behaviour.

The new `ratified participation keeps completion after membership loss and admits
money only from independent evidence` case is intentionally a desired-behaviour
regression, not a skipped or expected-failure wrapper. It starts valid Study
sessions with the real service and store, revokes membership before completion,
and expects completion to survive and monetary admission to follow independent
evidence. It currently fails on the first completion. Consequently its later
verified/unverified money and no-retroactive-admission assertions have not run.
The PostgreSQL server identifies `guard_study_session()` rejecting the
`UPDATE study_sessions SET status='completed'`: “Study session account, persona,
community, or timezone is ineligible”. The application returns
`ActivityQualificationStorageFailed` with reason `constraint`.

The existing `projects Study qualification into one Very-gated Megapot share per
account` and `credits every available asset-bonus leg once per verified account`
cases remain passing controls. They cover missing/stale evidence and ordinary
account/persona deduplication, but do not substitute for the new nonmember matrix.
Community-token emission admission was not proven by this bounded checkpoint;
its writer/enablement inventory remains necessary before expanding any reward
surface.

The first exploratory probe failed because it compared Effect Result/error
objects structurally; the next revision correctly used Result.isFailure and
field assertions. A later probe revealed its incomplete Karaoke song fixture
hit not-found before identity; it was removed and the case moved to the existing
playable fixture. A presentation error tag expectation was corrected to the
actual ActivityQualificationRejected. These fixture mistakes are distinct from
the retained real membership-loss regression.

## Ownership and next boundary

The API participation writer owns only this worktree. The Solid video writer
owns player, browser recovery and composer persistence. No persona preparation,
binding-source migration or Solid draft API change begins from this checkpoint.
The staging reset scripts and release manifest remain outside the lane. The
coordinator must record a concrete persona/draft handoff before those surfaces
are touched. Migration 0128 remains reserved but unwritten. No client version is
reserved or cut.

## Validation receipt

`bun run check` exited 0, including Effect diagnostics, type checks, contract
freshness and immutable client verification. The migration inventory remains
127. No generated artifact changed. The workspace script check exited 0 with no
findings; only the test-suite classification list was changed under scripts.

The focused three-file PostgreSQL run exited 1: ten cases passed and the desired
completion-after-membership-loss case failed with the constraint rejection
described above. This is a red implementation checkpoint and cannot be presented
for merge as green. The ordinary suite initially exited 1 because the newly
classified PG suite was not yet tracked; after exact-path staging, all 3214 unit
tests and 20 Node tests passed. Workerd completion is recorded separately below.

A final-name rerun under concurrent host load also exited 1: eight passed, the
same desired regression failed, and two previously passing Study controls hit
the unchanged 30-second per-case timeout. The first focused run's ten passes are
not substituted for this later result. Both full PG logs and the initial fixture
failures are retained in `activity-participation-authority-evidence-2026-09-06/`.
No timeout or production guard was relaxed.

The final ordinary invocation exited 130 after the coordinator authorized
interrupting the stalled HTTP Workerd pool on a host with exhausted RAM/swap.
Before interruption, 3214 unit tests, 20 Node tests and 80 tests in the first
Workerd pool passed. HTTP Workerd emitted no case result, and the Self, HNS
verifier and video-source pools did not run. This is not a full ordinary pass.
Only the owned Vitest process was interrupted after its command and worktree
were verified. Subsequent broad gates must run serially after resources recover.
The ordinary and check logs remain in `/tmp/participation-authority-ordinary-tracked.log`
and `/tmp/participation-authority-check.log` for coordinator capture; the concise
receipt here survives this session. No further rerun was attempted.
