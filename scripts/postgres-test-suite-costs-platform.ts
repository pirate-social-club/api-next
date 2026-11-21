// Content, media, identity, community and rewards persistence measurements.
// Provenance and public aggregate: postgres-test-suite-costs.ts.
export const postgresPlatformSuiteCostEstimates = {
  // Two callbacks took7.63s in the isolated PostgreSQL17.11 focused run.
  // Rounded shard-planning estimate only; no test deadline is changed.
  "packages/platform-cf/src/media-moderation-immutable-action.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 10000,
  },
  // Twelve source callbacks expand to17cases on one complete295-migration
  // isolated schema. Local PostgreSQL17 whole-file observation3.64s; this
  // rounded estimate affects shard planning only, never a test deadline.
  "packages/platform-cf/src/shared-song-megapot-participation.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 5000,
  },
  // Three callbacks, one complete293->294 isolated upgrade. Local PostgreSQL17
  // whole-file bound is19.14s (paired run); round up for planning only.
  "packages/platform-cf/src/song-contribution-refusals.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 20000,
  },
  "packages/platform-cf/src/account-age-verification.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 31835,
  },
  "packages/platform-cf/src/avatars.pg.test.ts": { sourceCallCount: 9, milliseconds: 31663 },
  "packages/platform-cf/src/comment-thread-repository.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 6018,
  },
  "packages/platform-cf/src/community-creation-nationality-completion.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 9558,
  },
  "packages/platform-cf/src/community-creation-nationality-flow.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 18921,
  },
  "packages/platform-cf/src/community-creation-repository.pg.test.ts": {
    sourceCallCount: 9,
    milliseconds: 16625,
  },
  "packages/platform-cf/src/community-join-intent-fulfillment.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 14250,
  },
  "packages/platform-cf/src/community-membership-follow-invariant.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2807,
  },
  "packages/platform-cf/src/community-moderation-foundation.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 11588,
  },
  "packages/platform-cf/src/community-owner-reservation.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 9842,
  },
  "packages/platform-cf/src/community-purchase-funding-producer-repository.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 10353,
  },
  "packages/platform-cf/src/community-purchase-funding-repository.pg.test.ts": {
    sourceCallCount: 23,
    milliseconds: 80708,
  },
  "packages/platform-cf/src/community-repository.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 16072,
  },
  "packages/platform-cf/src/community-route-migration.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 1069,
  },
  "packages/platform-cf/src/community-route-repository.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 31964,
  },
  "packages/platform-cf/src/content-rating-reconciliation.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 9411,
  },
  "packages/platform-cf/src/content-repository.pg.test.ts": {
    sourceCallCount: 13,
    milliseconds: 76420,
  },
  "packages/platform-cf/src/dance-attempt-persistence.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 34295,
  },
  "packages/platform-cf/src/dance-reference-persistence.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 25826,
  },
  "packages/platform-cf/src/data-registration-repository.pg.test.ts": {
    sourceCallCount: 19,
    milliseconds: 77189,
  },
  "packages/platform-cf/src/feed-repository.pg.test.ts": { sourceCallCount: 6, milliseconds: 7533 },
  "packages/platform-cf/src/gates-v2-community-nationality.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 40678,
  },
  "packages/platform-cf/src/gates-v2-community.pg.test.ts": {
    sourceCallCount: 14,
    milliseconds: 51700,
  },
  "packages/platform-cf/src/handle-nationality-authoring.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 16165,
  },
  "packages/platform-cf/src/handle-nationality-checkout.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 33471,
  },
  "packages/platform-cf/src/handle-sales-repository.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 23325,
  },
  "packages/platform-cf/src/identity-account-owner.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 3966,
  },
  "packages/platform-cf/src/identity.pg.test.ts": { sourceCallCount: 3, milliseconds: 7024 },
  "packages/platform-cf/src/media-persistence-migrations.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 14200,
  },
  "packages/platform-cf/src/media-persistence.pg.test.ts": {
    sourceCallCount: 64,
    milliseconds: 165897,
  },
  "packages/platform-cf/src/media-song-stems.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 11126,
  },
  "packages/platform-cf/src/nationality-ceremony-store.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 120000,
  },
  "packages/platform-cf/src/optional-route-v2-migration.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3096,
  },
  "packages/platform-cf/src/persona-community-binding-migration.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 4399,
  },
  "packages/platform-cf/src/persona-repository.pg.test.ts": {
    sourceCallCount: 9,
    milliseconds: 20883,
  },
  "packages/platform-cf/src/platform-pirate-handle-repository.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 7481,
  },
  "packages/platform-cf/src/postgres-foundation.pg.test.ts": {
    sourceCallCount: 15,
    milliseconds: 28515,
  },
  "packages/platform-cf/src/postgres-migrations-runner.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 10077,
  },
  "packages/platform-cf/src/postgres.pg.test.ts": { sourceCallCount: 4, milliseconds: 20219 },
  "packages/platform-cf/src/public-community-threads-repository.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 7010,
  },
  "packages/platform-cf/src/public-post-slug-repository.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 11338,
  },
  "packages/platform-cf/src/public-profile.pg.test.ts": { sourceCallCount: 3, milliseconds: 7926 },
  "packages/platform-cf/src/reward-attestation-pinning.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5997,
  },
  "packages/platform-cf/src/reward-binding-deploy.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 8713,
  },
  "packages/platform-cf/src/reward-claim-verification-intent.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3228,
  },
  "packages/platform-cf/src/reward-gas-topup.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 4165,
  },
  "packages/platform-cf/src/reward-http-admission.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 5363,
  },
  "packages/platform-cf/src/reward-money-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3084,
  },
  "packages/platform-cf/src/reward-operations-control.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 82,
  },
  "packages/platform-cf/src/reward-run-lease.pg.test.ts": {
    sourceCallCount: 15,
    milliseconds: 4038,
  },
  "packages/platform-cf/src/reward-unsigned-purchase-recovery.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 4084,
  },
  "packages/platform-cf/src/reward-winner-send.pg.test.ts": {
    sourceCallCount: 21,
    milliseconds: 7016,
  },
  "packages/platform-cf/src/rewards-composed-settlement.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 12397,
  },
  "packages/platform-cf/src/rewards-qualification.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 6974,
  },
  "packages/platform-cf/src/rewards-song-offers.pg.test.ts": {
    sourceCallCount: 29,
    milliseconds: 53019,
  },
  "packages/platform-cf/src/route-revalidation-completion-repository.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 12870,
  },
  "packages/platform-cf/src/sidebar-profile-reads.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 7077,
  },
  "packages/platform-cf/src/song-library-baseline.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3075,
  },
  "packages/platform-cf/src/song-library-repository.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 560,
  },
  "packages/platform-cf/src/song-owner-policy-head-lock-grant.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 1623,
  },
  "packages/platform-cf/src/song-owner-video-policy.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 6178,
  },
  "packages/platform-cf/src/song-video-interval-repository.pg.test.ts": {
    sourceCallCount: 15,
    milliseconds: 5111,
  },
  "packages/platform-cf/src/song-video-pcm-admission-repository.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 4491,
  },
  "packages/platform-cf/src/song-video-pcm-reference-repository.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 3737,
  },
  "packages/platform-cf/src/song-video-render-repository.pg.test.ts": {
    sourceCallCount: 24,
    milliseconds: 6297,
  },
  "packages/platform-cf/src/spaces-community-route-attachment-repository.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 14675,
  },
  "packages/platform-cf/src/spaces-handle-claims.pg.test.ts": {
    sourceCallCount: 25,
    milliseconds: 68139,
  },
  "packages/platform-cf/src/spaces-operator-assignment-repository.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 10223,
  },
  "packages/platform-cf/src/spaces-owner-proof-repository.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 32480,
  },
  "packages/platform-cf/src/spaces-sale-namespace.pg.test.ts": {
    sourceCallCount: 18,
    milliseconds: 41833,
  },
  "packages/platform-cf/src/serving-function-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 6080,
  },
  "packages/platform-cf/src/telegram-linking-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5492,
  },
  "packages/platform-cf/src/telegram-linking-repository.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 24721,
  },
  "packages/platform-cf/src/telegram-store.pg.test.ts": { sourceCallCount: 9, milliseconds: 10593 },
  "packages/platform-cf/src/text-submission-repository.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 37548,
  },
  "packages/platform-cf/src/verification-completion-repository.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 25531,
  },
  "packages/platform-cf/src/verification-start-repository.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 31605,
  },
  "packages/platform-cf/src/video-accepted-analysis-cleanup.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 7454,
  },
  "packages/platform-cf/src/video-outcome-repository.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 11376,
  },
  "packages/platform-cf/src/video-publication-reasons-migration.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 2486,
  },
  "packages/platform-cf/src/video-publication-repository.pg.test.ts": {
    sourceCallCount: 25,
    milliseconds: 45053,
  },
  "packages/platform-cf/src/video-reconciliation-operator.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 7314,
  },
  "packages/platform-cf/src/video-reservation-cleanup.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5763,
  },
  "packages/platform-cf/src/video-safety-evidence.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 7158,
  },
  "packages/platform-cf/src/video-source-grants.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 5324,
  },
  "packages/platform-cf/src/video-stream-ingest-repository.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 19064,
  },
  "packages/platform-cf/src/video-thumbnail-repository.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 8373,
  },
  "packages/platform-cf/src/video-transform-attempt-repository.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 9132,
  },
  "packages/platform-cf/src/video-workflow-composed.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 112769,
  },
  "packages/platform-cf/src/video-workflow-migration.pg.test.ts": {
    sourceCallCount: 7,
    milliseconds: 1791,
  },
  "packages/platform-cf/src/wallet-sponsored-send.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 5521,
  },
} as const;
