# Independent money admission before activity authority changes

The tests-only work following 2d7c4c9e found no membership-dependent admission gap in the implemented Megapot and asset-bonus paths. It does not prove that nonmembers can already complete an activity: guard_study_session and guard_karaoke_session still reject that, as the earlier expected-red test records. No production trigger, authority predicate, migration, contract or client changed.

## Runtime inventory

PostgreSQL project_megapot_pool_share_from_qualification and project_asset_bonus_claim_from_qualification are the only AFTER INSERT monetary projectors on activity_qualifications. Both evaluate current Very evidence and its binding/epoch/revalidation/expiry independently of membership, then enforce reward_subject_consumptions by campaign and provider subject. A later account recovery does not erase an earlier campaign consumption. Missing, stale or revoked evidence creates an ineligible decision without awarding a share or credit and without rejecting qualification insertion. Revoked evidence currently uses verification_stale; this is an existing private reward classification, not a new wire change.

The Megapot cutoff store reads megapot_pool_shares, not qualification rankings or streak tables. It locks the drawing/leg and shares, compares the candidate's beneficiaries and version/cutoff/terms, and freezes only that set. validate_megapot_beneficiary_snapshot requires exact equality between the retained shares and private leaves for non-fallback snapshots. The empty fallback branch requires a separately retained eligible, unexpired fallback_cutoff decision plus resource discovery, current activity availability and budget controls. No runtime producer of fallback_cutoff eligibility decisions was found; absent evidence closes the fallback instead of inventing a beneficiary. This pre-existing producer limitation is not loosened by participation.

Megapot allocation creates credits from the retained snapshot and allocation batch, with source kind megapot_allocation or external_fallback. The other ledger writer is the asset-bonus qualification projector. The ledger source-kind check admits only those three kinds; source-pair constraints link credits to their source. Existing validly reserved benefits retain their lifecycle under Spec 015 §8.1, so this amendment does not retroactively cancel a share when proof changes after admission.

Community-token emission is not implemented in this API runtime. The current schema has none of Spec 015's community_token_program_versions, community_token_emissions or emission-daily-total tables, and searches across production packages, migrations and the canonical generated schema found no token-program emission writer. The closed reward-ledger source kinds provide a second check on that finding. Community tokens must acquire the independently verified admission path when that feature is built; this checkpoint does not implement or enable it. Token contract/provider execution outside this API was not audited.

## Focused PostgreSQL matrix

The two new tests live in activity-qualification-repository.pg.test.ts, named independent megapot admission ignores membership and refuses absent or revoked proof, and independent asset admission ignores membership and refuses absent or revoked proof.

Their fixture starts a real Study session through the service, then inserts a valid answer and completes its frozen item evidence through ordinary SQL while membership still exists. It removes membership before inserting the exact qualification. Every production trigger remains enabled throughout that boundary. This deliberately isolates reward admission from the known completion guard defect; it is not an application-level nonmember completion proof. The pre-existing song publication fixture uses its existing replication-role setup before these tests exercise authority or money, and is unchanged.

| Case, exercised for both reward kinds | Observed result |
| --- | --- |
| Verified nonmember | Eligible; one beneficiary share or credited claim |
| Unverified member | verification_missing; qualification/completion retained, no award |
| Unverified nonmember | verification_missing; qualification/completion retained, no award |
| Latest revalidation stale | verification_stale; no award |
| Latest revalidation revoked | verification_stale; no award |
| Duplicate provider fingerprint on another account | Unique constraint rejects new subject identity; no second active binding |
| Same provider subject legitimately recovered to another account | Fresh completed receipt at epoch two is accepted, but reward yields subject_already_consumed; no second award |
| Verification after rejected qualification | Retained ineligible decision and zero award remain unchanged |
| Qualified participant with an ineligible decision manually inserted as a pool beneficiary | guard_megapot_pool_share rejects with P0001; still no share |

The last case tests the monetary boundary rather than a UI leaderboard. Production leaderboard reads remain read-only streak/presentation queries; these tests do not claim to prove new nonmember leaderboard rendering. Existing service tests for one share across two personas and funded asset-bonus admission/capacity also ran, including their expired-evidence control. The recovery fixture extends the existing proof helper with an optional real epoch-two recovery; its default initial-binding behavior is unchanged.

## Validation and limits

The first new-matrix run exited 0: two passing tests, 46 assertions, 6.07 seconds. The first recovery extension run exited 1 because the fixture reused a provider evidence hash, violating evidence_receipts_provider_evidence_uidx. It did not reveal a runtime admission defect. A fresh receipt with the same recovered subject fixed the fixture. That failed run is retained.

The final focused run exited 0: four passing tests, 82 assertions, 8.10 seconds. It selected the two new tests plus projects Study qualification into one Very-gated Megapot share per account and credits every available asset-bonus leg once per verified account. The earlier desired-behavior completion test was filtered, not made passing. The local PostgreSQL 17 fixture at port 55441 used its reusable isolated test schema; no reset-runner or external database was used.

bun run check exited 0, with the existing 41 warnings and one informational diagnostic. No check failure was suppressed.

The cutoff and allocation findings above are source review, not fresh composed cutoff/provider execution. Existing cutoff tests are inventoried in rewards-song-offers.pg.test.ts, including the no-entry close and verified external sponsor cases; they were not rerun here. No full PostgreSQL suite, ordinary suite, Workerd suite or provider call ran for this checkpoint. Full integration gates remain owed. The next authority tranche can preserve the existing monetary projectors and must turn the earlier activity-completion regression green atomically with the shared authority/migration change.

Logs are retained in activity-participation-money-evidence-2026-09-06. Repository copies normalize trailing whitespace only; raw originals remain under /tmp for the coordinator's complete capture. No staging archive index or control-plane record was edited by this writer.
