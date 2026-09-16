# Activity participation authority: atomic implementation plan

This plan follows the tests-only checkpoint c2c663decef67aaa5030b0580439c796b989371f. It does not change runtime authority. Spec 006 §3A and Spec 014 §10.2 are ratified; the remaining boundary is repository ownership and a coordinated schema change, not a new product decision.

## Atomic boundary

A repository-only removal of membership checks is incorrect. PostgreSQL guard_study_session and guard_karaoke_session require active_community_effect on insertion and updates, including completion. The baseline regression reaches that Study trigger after membership loss and fails before reward admission. Changing application queries alone would preserve the defect while weakening the visible entry checks.

Migration 0128 must therefore carry the shared activity-authority predicate and the corresponding activity-specific trigger changes in the same reviewed implementation as the repository callers. The explicit persona-preparation binding source also belongs in that forward migration once the ownership agreement is recorded. Do not edit historical migrations or globally weaken active_community_effect; posting, role and membership effects continue using their existing authority.

A non-pruning origin fetch on 2026-09-06 resolved origin/main to 914a923742fb1e6193aef7cbc71df4a2b19792c3. Its tracked migration inventory ends at 0127_video_delivery_ingest.sql; 0128 is absent. This is an observation, not permission to create the migration before the paired record agreement. Reverify immediately before writing. No rebase or migration was performed for this plan.

## Proposed paired ownership amendment

2026-09-06 ownership agreement: api-activity-participation-authority owns the shared application and repository activity authority, explicit API persona preparation, its handlers, reviewed contracts and client release, and the forward migration reserved as 0128 after fetched-origin verification. This includes persona-repository.ts, use-cases/personas.ts, persona-handlers.ts, activity presentation and binding writes, and activity-specific schema guards. It preserves role presentation and the pending-wallet community-creation exception. active_community_effect remains posting authority.

api-staging-persona-reset-runner retains exclusive ownership of reset scripts, frozen release and checksum pins, runtime privilege and maintenance service/Durable Object fences, rehearsal and the live window. Participation changes no reset artifact or release pin. Reset compatibility and any re-pin are separate reviewed prerequisites before deployment. The completed api-community-persona-boundary and solid-community-persona-boundary lanes have no active write claim. Solid video retains all draft, storage and coordinator files; this API handoff authorizes no Solid edits or draft implementation.

Record this agreement in both active API records before implementation. The reset record's latest maintenance and release-pin warnings remain effective. A later Solid participation handoff is still needed before its draft-preservation work, but is not needed to dispatch this API tranche.

## Shared authority shape

Use one database-owned activity identity predicate for active account, active owned persona, immutable exact-community binding and available community. Keep resource access separate: existing public, published song eligibility plus the shared viewer rating/age policy. Presentation selection has no song resource, so it uses identity authority only. Study, Karaoke and Dance must not each receive a copied permissive membership replacement.

Expose that authority through the application port and one platform repository implementation; transactional SQL writers and database guards use the same policy. Do not silently expand supported content visibility. Membership-only resources retain their independent access rule; a posting ban is not itself an activity ban. Preserve suspension, resource withdrawal, consent, quotas, frozen provider/scorer readiness and private-media boundaries.

Reload authority before a protected replay response or new effect. Preserve existing account advisory locks and immutable session/command identities; lock and recheck the relevant authority/resource rows inside the write transaction. Review the exact lock order against each repository before adding locks. Cleanup and retention reconciliation must remain possible without posting membership and must not be mistaken for a newly authorized activity effect.

## File and command inventory

| Boundary | Owned implementation surfaces | Required change and preserved fence |
| --- | --- | --- |
| Shared policy | New application authority port and platform repository helper; forward migration and generated database artifacts | One identity/resource policy, no posting helper change; regenerate only after reservation agreement |
| Existing Study qualification producer | packages/platform-cf/src/activity-qualification-repository.ts | prepareStudySessionStart, createStudySession, submitStudyAnswer and replay/read paths; remove posting membership only, retain qualification reducer and independent reward projection |
| Study v2 | packages/platform-cf/src/study-v2-repository.ts | startSession, readSession/getSession, loadSpokenAnswerContext, reserveSpokenAnswer, completeSpokenAnswer and submitAnswer; protect cached replay and provider context as well as entry |
| Study database | guard_study_session, Study v2 session constraints/guard review | Preserve timezone, immutable authority, exact completion evidence; the existing Study guard does not protect study_sessions_v2 |
| Karaoke | packages/platform-cf/src/karaoke-repository.ts, karaoke-attempt-do.ts, karaoke-finalization-recovery.ts | sessionSource/reserveSession, getAttempt, finalizeAttempt, reconnect/provider authority; preserve frozen source, scorer, private recording and recovery semantics |
| Karaoke database | guard_karaoke_session and existing runtime/playback/attempt guards | Replace membership condition only through shared authority; preserve clock, immutable configuration and matching terminal attempt |
| Persona preparation/presentation | packages/application/src/use-cases/personas.ts, packages/platform-cf/src/persona-repository.ts, apps/http-worker/src/persona-handlers.ts; activity-qualification-repository.ts presentation commands | Explicit bind/select/create; serialize one-time binding and retain existing explicit presentation; no membership, follow, role, wallet or verification side effects |
| Persona database | persona_community_bindings source check, presentation/binding constraints | Add activity_participation source through 0128; do not globally change require_active_role_persona, which also serves role presentation and a community-creation exception |
| Dance private assessment | packages/application/src/use-cases/dance/attempt-services.ts, packages/platform-cf/src/dance-attempt-authoring-repository.ts, apps/http-worker/src/dance-attempt-production-composition.ts | Implement the reviewed session authority port and protect private replay/consent/upload/submit; production authority is currently null, so do not claim Dance is enabled by removing a guard |
| Public Dance video | Existing separate Spec 013 publication path and composed tests | No authority relaxation: denied Post preserves private result; successful later publication rechecks membership inside its transaction, including revocation race |
| API contract | Existing contract definition, persona handler routing/composition and generated client surfaces discovered at contract freeze | Freeze preparation response and enumeration-safe errors, waive/release in the participation lane; no intermediate contract or generated changes in this planning checkpoint |

The Karaoke Durable Object reference above concerns its activity session authority only. Any shared service/DO maintenance admission guard remains owned by reset and requires a separate agreement if the eventual implementation touches it.

## Independent money admission

Money admission is already enforced below the TypeScript activity repositories. PostgreSQL project_megapot_pool_share_from_qualification and project_asset_bonus_claim_from_qualification run after qualification insertion. They require current matching Very personhood and subject-unique proof evidence, completed proof session and accepted revalidation, expiry, the active subject binding and campaign subject consumption, alongside pool/offer financial fences. Neither function currently requires community membership. Missing evidence records an ineligible decision and returns without an award; the ordinary activity transaction must still complete.

Preserve those functions and guard_activity_qualification's exact reducer evidence. Add the independent admission matrix before any activity relaxation: verified nonmember, unverified participant, member without a valid proof, stale/revoked evidence, duplicate provider subject across accounts and no retrospective entitlement. Nonmonetary standings must not constitute admission. Trace community-token credit writers and the Megapot cutoff consumer before claiming the money inventory complete; the current baseline proves neither of those full paths. Do not infer absence of SQL writers from a TypeScript-only search.

## Implementation sequence and acceptance

After the paired record agreement and a fresh ordinal check, implement shared authority, explicit preparation and 0128 as one schema-compatible tranche. Preserve the tests-only source and its expected red as historical evidence. Add direct PostgreSQL guard tests and application/repository tests before replacing the current membership checks. Do not deploy a partially compatible runtime/schema combination.

Then cover all activity continuation and replay paths, followed by the reviewed Dance authority composition. Freeze the preparation endpoint/error contract and cut the participation client under its recorded sequencing. Solid adoption and draft work remain separate. Coordinate heavy gates with the coordinator; the baseline's interrupted ordinary run is not a green gate.

| Acceptance case | Required evidence |
| --- | --- |
| No membership and no proof | Explicit preparation, supported activity start/replay/complete, private result and zero membership/follow/Post writes |
| Membership loss during activity | Study and Karaoke completion remain committed; trigger-level tests prove direct SQL is consistent with repository policy |
| Invalid identity/resource | Foreign, unbound, wrong-community, suspended and retired persona; unavailable account/community/song; age/visibility denial, including replay and provider-context paths |
| Reward separation | Full independent matrix above; qualification/progress commit despite no money; exact financial/subject fences retained |
| Preparation races | One immutable community binding winner; no wallet/role/follow/join side effects; existing explicit presentation retained |
| Dance separation | Private attempt authority and readiness remain distinct; publication denial retains result; authorized publication rechecks membership during transaction |
| Runtime recovery | Reconnect, spoken-command replay, terminal Karaoke recovery and cleanup retain their respective authority and durability fences |

This plan is based on read-only code/spec/task inventory. No new test suite, schema, runtime, persona, contract, client, reset or Solid change was made for it. The existing expected-red and resource-stalled evidence remains exactly as recorded in activity-participation-authority-baseline-2026-09-06.md.
