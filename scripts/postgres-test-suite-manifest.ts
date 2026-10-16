export const reusablePostgresTestSuites = [
  "apps/jobs-worker/src/megapot-rewards-funding.pg.test.ts",
  "packages/platform-cf/src/telegram-linking-repository.pg.test.ts",
  "packages/platform-cf/src/content-rating-reconciliation.pg.test.ts",
  "packages/platform-cf/src/telegram-store.pg.test.ts",
  "packages/platform-cf/src/activity-qualification-repository.pg.test.ts",
  "packages/platform-cf/src/community-creation-repository.pg.test.ts",
  "packages/platform-cf/src/community-owner-reservation.pg.test.ts",
  "packages/platform-cf/src/community-purchase-funding-producer-repository.pg.test.ts",
  "packages/platform-cf/src/community-repository.pg.test.ts",
  "packages/platform-cf/src/community-route-repository.pg.test.ts",
  "packages/platform-cf/src/dance-reference-persistence.pg.test.ts",
  "packages/platform-cf/src/feed-repository.pg.test.ts",
  "packages/platform-cf/src/hns-control-observer-repository.pg.test.ts",
  "packages/platform-cf/src/hns-route-revalidation-scheduler.pg.test.ts",
  "packages/platform-cf/src/identity.pg.test.ts",
  "packages/platform-cf/src/media-persistence.pg.test.ts",
  "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts",
  "packages/platform-cf/src/platform-pirate-handle-repository.pg.test.ts",
  "packages/platform-cf/src/public-post-slug-repository.pg.test.ts",
  "packages/platform-cf/src/public-profile.pg.test.ts",
  "packages/platform-cf/src/rewards-qualification.pg.test.ts",
  "packages/platform-cf/src/rewards-song-offers.pg.test.ts",
  "packages/platform-cf/src/song-owner-video-policy.pg.test.ts",
  "packages/platform-cf/src/route-revalidation-completion-repository.pg.test.ts",
  "packages/platform-cf/src/video-outcome-repository.pg.test.ts",
  "packages/platform-cf/src/video-publication-repository.pg.test.ts",
  "packages/platform-cf/src/video-reservation-cleanup.pg.test.ts",
  "packages/platform-cf/src/video-stream-ingest-repository.pg.test.ts",
  "packages/platform-cf/src/video-thumbnail-repository.pg.test.ts",
  "scripts/community-purchase-funding-plans.pg.test.ts",
  "scripts/song-video-composed-flow.pg.test.ts",
  "scripts/very-staging-community-fixture.pg.test.ts",
] as const;

export const freshSchemaPostgresTestSuites = [
  "tests/postgres/notifications-hardening.pg.test.ts",
  "packages/platform-cf/src/karaoke-instrumental-policy.pg.test.ts",
  "packages/platform-cf/src/reward-unsigned-purchase-recovery.pg.test.ts",
  "packages/platform-cf/src/sidebar-profile-reads.pg.test.ts",
  "apps/http-worker/src/hns-provisional-safe-ownership.pg.test.ts",
  "packages/platform-cf/src/reward-money-privileges.pg.test.ts",
  "packages/platform-cf/src/reward-binding-deploy.pg.test.ts",
  "packages/platform-cf/src/reward-http-admission.pg.test.ts",
  "packages/platform-cf/src/reward-operations-control.pg.test.ts",
  "scripts/megapot-golden-adopted-pool.pg.test.ts",
  "scripts/staging-hns-cutover-probe-reseed.pg.test.ts",
  "apps/http-worker/src/rewards-golden-retry.pg.test.ts",
  "packages/platform-cf/src/reward-claim-verification-intent.pg.test.ts",
  "packages/platform-cf/src/reward-attestation-pinning.pg.test.ts",
  "packages/platform-cf/src/reward-gas-topup.pg.test.ts",
  "packages/platform-cf/src/reward-winner-send.pg.test.ts",
  "packages/platform-cf/src/wallet-sponsored-send.pg.test.ts",
  "packages/platform-cf/src/rewards-composed-settlement.pg.test.ts",
  "packages/platform-cf/src/avatars.pg.test.ts",
  "packages/platform-cf/src/activity-participation-authority.pg.test.ts",
  "packages/platform-cf/src/activity-participation-composed-acceptance.pg.test.ts",
  "packages/platform-cf/src/activity-participation-preparation.pg.test.ts",
  "packages/platform-cf/src/account-age-verification.pg.test.ts",
  "packages/platform-cf/src/comment-thread-repository.pg.test.ts",
  "packages/platform-cf/src/notifications-repository.pg.test.ts",
  "apps/http-worker/src/hns-community-publication.pg.test.ts",
  "apps/http-worker/src/hns-community-activation.pg.test.ts",
  "apps/http-worker/src/hns-owner-recovery-production.pg.test.ts",
  "apps/jobs-worker/src/hns-active-lease-renewal-production.pg.test.ts",
  "apps/http-worker/src/hns-community-activation-production-worker.pg.test.ts",
  "apps/http-worker/src/hns-community-joint-ceremony.pg.test.ts",
  "apps/http-worker/src/hns-lifecycle-observation-scheduling.pg.test.ts",
  "apps/http-worker/src/hns-community-separated-clocks.pg.test.ts",
  "apps/http-worker/src/hns-community-mixed-version.pg.test.ts",
  "apps/http-worker/src/hns-txt-attachment.pg.test.ts",
  "packages/platform-cf/src/hns-import-separated-clocks-migration.pg.test.ts",
  "apps/http-worker/src/public-community-threads-composition.pg.test.ts",
  "apps/http-worker/src/video-song-reference-required.pg.test.ts",
  "scripts/hns-monitor/snapshot.pg.test.ts",
  "scripts/hns-continuity/promotion.pg.test.ts",
  "packages/platform-cf/src/community-purchase-funding-repository.pg.test.ts",
  "packages/platform-cf/src/content-repository.pg.test.ts",
  "packages/platform-cf/src/dance-attempt-persistence.pg.test.ts",
  "packages/platform-cf/src/data-registration-repository.pg.test.ts",
  "packages/platform-cf/src/gates-v2-community.pg.test.ts",
  "packages/platform-cf/src/community-join-intent-fulfillment.pg.test.ts",
  "packages/platform-cf/src/community-creation-nationality-completion.pg.test.ts",
  "packages/platform-cf/src/community-creation-nationality-flow.pg.test.ts",
  "packages/platform-cf/src/gates-v2-community-nationality.pg.test.ts",
  "packages/platform-cf/src/nationality-ceremony-store.pg.test.ts",
  "packages/platform-cf/src/handle-sales-repository.pg.test.ts",
  "packages/platform-cf/src/handle-nationality-authoring.pg.test.ts",
  "packages/platform-cf/src/handle-nationality-checkout.pg.test.ts",
  "packages/platform-cf/src/spaces-sale-namespace.pg.test.ts",
  "packages/platform-cf/src/spaces-handle-claims.pg.test.ts",
  "packages/platform-cf/src/spaces-owner-proof-repository.pg.test.ts",
  "packages/platform-cf/src/spaces-community-route-attachment-repository.pg.test.ts",
  "packages/platform-cf/src/spaces-operator-assignment-repository.pg.test.ts",
  "packages/platform-cf/src/hns-host-persistence-repository.pg.test.ts",
  "packages/platform-cf/src/hns-community-root-import-repository.pg.test.ts",
  "packages/platform-cf/src/hns-root-import-repository.pg.test.ts",
  "packages/platform-cf/src/hns-root-import-lifecycle.pg.test.ts",
  "packages/platform-cf/src/hns-root-import-lifecycle-migration.pg.test.ts",
  "packages/platform-cf/src/hns-root-import-lifecycle-privileges.pg.test.ts",
  "packages/platform-cf/src/hns-production-import-privileges.pg.test.ts",
  // Both create their own schema and run every migration, so they classify
  // with the fresh-schema suites rather than the baseline-reusing ones.
  "packages/platform-cf/src/hns-root-import-lifecycle-transition.pg.test.ts",
  "packages/platform-cf/src/hns-root-import-lifecycle-execution.pg.test.ts",
  "packages/platform-cf/src/hns-lifecycle-readiness-patch.pg.test.ts",
  "packages/platform-cf/src/hns-readiness-zone-mutation-admission.pg.test.ts",
  "packages/platform-cf/src/hns-retention-review.pg.test.ts",
  "packages/platform-cf/src/hns-execution-ownership.pg.test.ts",
  "packages/platform-cf/src/hns-retention-reviewer.pg.test.ts",
  "packages/platform-cf/src/hns-lifecycle-projection.pg.test.ts",
  "packages/platform-cf/src/hns-observation-fence.pg.test.ts",
  "packages/platform-cf/src/hns-readiness-ownership.pg.test.ts",
  "packages/platform-cf/src/hns-single-owner-readiness-cutover.pg.test.ts",
  "packages/platform-cf/src/hns-reconciliation-routing.pg.test.ts",
  "packages/platform-cf/src/hns-incident-recovery.pg.test.ts",
  // Creates its own schema and additionally needs a reachable regtest node;
  // it skips itself when either is absent.
  "packages/platform-cf/src/hns-lifecycle-composed-path.pg.test.ts",
  "packages/platform-cf/src/hns-incident-evidence.pg.test.ts",
  // Drives the provisioner's own entrypoint as a subprocess against a fresh
  // database and a regtest node; it skips itself when either is absent.
  "packages/platform-cf/src/hns-service-loop-entrypoint.pg.test.ts",
  "packages/platform-cf/src/karaoke-finalization-recovery.pg.test.ts",
  "packages/platform-cf/src/karaoke-playback-authority.pg.test.ts",
  "packages/platform-cf/src/learner-audio-deletion-repository.pg.test.ts",
  "packages/platform-cf/src/localization-foundation.pg.test.ts",
  "packages/platform-cf/src/optional-route-v2-migration.pg.test.ts",
  "packages/platform-cf/src/persona-repository.pg.test.ts",
  "packages/platform-cf/src/public-community-threads-repository.pg.test.ts",
  "packages/platform-cf/src/media-song-stems.pg.test.ts",
  "packages/platform-cf/src/song-library-baseline.pg.test.ts",
  "packages/platform-cf/src/song-video-interval-repository.pg.test.ts",
  "packages/platform-cf/src/song-video-pcm-admission-repository.pg.test.ts",
  "packages/platform-cf/src/song-video-pcm-reference-repository.pg.test.ts",
  "packages/platform-cf/src/song-video-render-repository.pg.test.ts",
  "packages/platform-cf/src/study-v2-foundation.pg.test.ts",
  "packages/platform-cf/src/study-v2-lifecycle.pg.test.ts",
  "packages/platform-cf/src/telegram-http-practice.pg.test.ts",
  "packages/platform-cf/src/telegram-study-learner.pg.test.ts",
  "packages/platform-cf/src/study-v2-spoken-retry.pg.test.ts",
  "packages/platform-cf/src/study-translation-repository.pg.test.ts",
  "packages/platform-cf/src/verification-completion-repository.pg.test.ts",
  "packages/platform-cf/src/verification-start-repository.pg.test.ts",
  "scripts/public-post-slug-backfill.pg.test.ts",
  "scripts/public-profile-backfill.pg.test.ts",
  "scripts/song-video-render-host.pg.test.ts",
] as const;

export const noBaselinePostgresTestSuites = [
  "packages/platform-cf/src/study-provider-refusal.pg.test.ts",
  "apps/http-worker/src/guest-study-default-worker.pg.test.ts",
  "packages/platform-cf/src/guest-ephemeral-cleanup.pg.test.ts",
  "packages/platform-cf/src/guest-study-managed-readiness.pg.test.ts",
  "apps/jobs-worker/src/account-study-cron-stop-on-unknown.pg.test.ts",
  "packages/platform-cf/src/account-study-producer.pg.test.ts",
  "apps/http-worker/src/guest-study-private-journey.pg.test.ts",
  "packages/platform-cf/src/guest-study-resource-expiry.pg.test.ts",
  "apps/http-worker/src/guest-authority-private-composition.pg.test.ts",
  "packages/platform-cf/src/guest-recovery-deletion.pg.test.ts",
  "packages/platform-cf/src/guest-spoken-recovery.pg.test.ts",
  "packages/platform-cf/src/guest-study-atomic-start.pg.test.ts",
  "packages/platform-cf/src/owner-spoken-archive.pg.test.ts",
  "packages/platform-cf/src/owner-spoken-checkpoint.pg.test.ts",
  "packages/platform-cf/src/owner-study-json-mutations.pg.test.ts",
  "packages/platform-cf/src/owner-study-retention.pg.test.ts",
  "packages/platform-cf/src/owner-spoken-checkpoint-foundation.pg.test.ts",
  "packages/platform-cf/src/guest-spoken-resource-plan.pg.test.ts",
  "packages/platform-cf/src/owner-study-starter.pg.test.ts",
  "packages/platform-cf/src/owner-study-starter-alias.pg.test.ts",
  "packages/platform-cf/src/identity-account-owner.pg.test.ts",
  "packages/platform-cf/src/guest-audio-deletion-fence.pg.test.ts",
  "packages/platform-cf/src/guest-learning-row-boundary.pg.test.ts",
  "packages/platform-cf/src/guest-resource-reservations.pg.test.ts",
  "packages/platform-cf/src/guest-attachment-preparation.pg.test.ts",
  "packages/platform-cf/src/guest-authority-discovery-cleanup.pg.test.ts",
  "packages/platform-cf/src/guest-prepared-content.pg.test.ts",
  "packages/platform-cf/src/guest-authority-transitions.pg.test.ts",
  "packages/platform-cf/src/study-participation-owner-preservation.pg.test.ts",
  "packages/platform-cf/src/guest-learning-authority-foundation.pg.test.ts",
  "packages/platform-cf/src/reward-run-lease.pg.test.ts",
  "packages/platform-cf/src/telegram-linking-privileges.pg.test.ts",
  "packages/platform-cf/src/song-owner-policy-head-lock-grant.pg.test.ts",
  "packages/platform-cf/src/serving-function-privileges.pg.test.ts",
  "scripts/staging-karaoke-release-database.pg.test.ts",
  "scripts/staging-persona-prepare-reset.pg.test.ts",
  "scripts/staging-persona-reset-denied-grants.pg.test.ts",
  "scripts/staging-persona-dependency-scan.pg.test.ts",
  "scripts/staging-persona-schema-authority.pg.test.ts",
  "scripts/staging-persona-session-drain.pg.test.ts",
  "scripts/staging-persona-runtime-denial.pg.test.ts",
  "scripts/staging-persona-database-collector.pg.test.ts",
  "scripts/staging-karaoke-nonreuse.pg.test.ts",
  "scripts/staging-persona-reconstruct.pg.test.ts",
  "scripts/staging-persona-phased-reset.pg.test.ts",
  "scripts/staging-persona-disposable-reset.pg.test.ts",
  "scripts/staging-hns-post-migration-entry.pg.test.ts",
  "scripts/staging-hns-gateway-role.pg.test.ts",
  "packages/platform-cf/src/song-library-repository.pg.test.ts",
  "packages/platform-cf/src/hns-renewal-privileges.pg.test.ts",
  "packages/platform-cf/src/hns-admission-privileges.pg.test.ts",
  "packages/platform-cf/src/video-reconciliation-operator.pg.test.ts",
  "packages/platform-cf/src/video-accepted-analysis-cleanup.pg.test.ts",
  "packages/platform-cf/src/video-source-grants.pg.test.ts",
  "packages/platform-cf/src/video-safety-evidence.pg.test.ts",
  "packages/platform-cf/src/video-workflow-composed.pg.test.ts",
  "packages/platform-cf/src/video-transform-attempt-repository.pg.test.ts",
  "packages/platform-cf/src/video-workflow-migration.pg.test.ts",
  "packages/platform-cf/src/video-publication-reasons-migration.pg.test.ts",
  "packages/platform-cf/src/community-moderation-foundation.pg.test.ts",
  "packages/platform-cf/src/community-membership-follow-invariant.pg.test.ts",
  "packages/platform-cf/src/community-route-migration.pg.test.ts",
  "packages/platform-cf/src/media-persistence-migrations.pg.test.ts",
  "packages/platform-cf/src/persona-community-binding-migration.pg.test.ts",
  "packages/platform-cf/src/karaoke-persona-boundary.pg.test.ts",
  "packages/platform-cf/src/postgres-foundation.pg.test.ts",
  "packages/platform-cf/src/postgres-migrations-runner.pg.test.ts",
  "packages/platform-cf/src/postgres.pg.test.ts",
  "packages/platform-cf/src/text-submission-repository.pg.test.ts",
] as const;

export const classifiedPostgresTestSuites = [
  ...reusablePostgresTestSuites,
  ...freshSchemaPostgresTestSuites,
  ...noBaselinePostgresTestSuites,
] as const;

// Closed required-CI group costs from run38370048198 (2ebccd53), plus five
// historical estimates whose test-file bytes match (not transitive fixtures) from run38353040821. Source
// and safe timing receipts are retained in the reviewed coordinator packet.
// Planning estimates only: no test acceptance, skip, deadline or runtime authority.
// Activity preparation is an explicitly incomplete-tail98s estimate (two passes
// plus the remaining90s callback); nationality is unobserved4*30s=120s.
// The two environment-specific skipped profiles keep the ordinary count model.
export const postgresGeneralSuiteCostEstimates: Readonly<
  Record<string, Readonly<{ sourceCallCount: number; milliseconds: number }>>
> = {
  "apps/http-worker/src/guest-authority-private-composition.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 19625,
  },
  "apps/http-worker/src/guest-study-default-worker.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 25480,
  },
  "apps/http-worker/src/guest-study-private-journey.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 21485,
  },
  "apps/http-worker/src/hns-community-activation-production-worker.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 9059,
  },
  "apps/http-worker/src/hns-community-activation.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 33424,
  },
  "apps/http-worker/src/hns-community-joint-ceremony.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 4278,
  },
  "apps/http-worker/src/hns-community-mixed-version.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 18570,
  },
  "apps/http-worker/src/hns-community-publication.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 14786,
  },
  "apps/http-worker/src/hns-community-separated-clocks.pg.test.ts": {
    sourceCallCount: 9,
    milliseconds: 35422,
  },
  "apps/http-worker/src/hns-lifecycle-observation-scheduling.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2717,
  },
  "apps/http-worker/src/hns-owner-recovery-production.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 9790,
  },
  "apps/http-worker/src/hns-provisional-safe-ownership.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 12904,
  },
  "apps/http-worker/src/hns-txt-attachment.pg.test.ts": { sourceCallCount: 4, milliseconds: 28348 },
  "apps/http-worker/src/public-community-threads-composition.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2303,
  },
  "apps/http-worker/src/rewards-golden-retry.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 4486,
  },
  "apps/http-worker/src/video-song-reference-required.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 7304,
  },
  "apps/jobs-worker/src/account-study-cron-stop-on-unknown.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3303,
  },
  "apps/jobs-worker/src/hns-active-lease-renewal-production.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 25519,
  },
  "apps/jobs-worker/src/megapot-rewards-funding.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5978,
  },
  "packages/platform-cf/src/account-age-verification.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 31835,
  },
  "packages/platform-cf/src/account-study-producer.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 13432,
  },
  "packages/platform-cf/src/activity-participation-authority.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2061,
  },
  "packages/platform-cf/src/activity-participation-composed-acceptance.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 9186,
  },
  "packages/platform-cf/src/activity-participation-preparation.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 98000,
  },
  "packages/platform-cf/src/activity-qualification-repository.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 25007,
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
  "packages/platform-cf/src/guest-attachment-preparation.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 1139,
  },
  "packages/platform-cf/src/guest-audio-deletion-fence.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 1712,
  },
  "packages/platform-cf/src/guest-authority-discovery-cleanup.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 2352,
  },
  "packages/platform-cf/src/guest-authority-transitions.pg.test.ts": {
    sourceCallCount: 11,
    milliseconds: 2726,
  },
  "packages/platform-cf/src/guest-ephemeral-cleanup.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 35462,
  },
  "packages/platform-cf/src/guest-learning-authority-foundation.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 562,
  },
  "packages/platform-cf/src/guest-learning-row-boundary.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 3005,
  },
  "packages/platform-cf/src/guest-prepared-content.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 15725,
  },
  "packages/platform-cf/src/guest-recovery-deletion.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 17843,
  },
  "packages/platform-cf/src/guest-resource-reservations.pg.test.ts": {
    sourceCallCount: 13,
    milliseconds: 3298,
  },
  "packages/platform-cf/src/guest-spoken-recovery.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 24466,
  },
  "packages/platform-cf/src/guest-spoken-resource-plan.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 15301,
  },
  "packages/platform-cf/src/guest-study-atomic-start.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 25142,
  },
  "packages/platform-cf/src/guest-study-managed-readiness.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 80925,
  },
  "packages/platform-cf/src/guest-study-resource-expiry.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 13647,
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
  "packages/platform-cf/src/hns-admission-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 4046,
  },
  "packages/platform-cf/src/hns-community-root-import-repository.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 10772,
  },
  "packages/platform-cf/src/hns-control-observer-repository.pg.test.ts": {
    sourceCallCount: 23,
    milliseconds: 31829,
  },
  "packages/platform-cf/src/hns-execution-ownership.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 14171,
  },
  "packages/platform-cf/src/hns-host-persistence-repository.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 14826,
  },
  "packages/platform-cf/src/hns-import-separated-clocks-migration.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2630,
  },
  "packages/platform-cf/src/hns-incident-recovery.pg.test.ts": {
    sourceCallCount: 13,
    milliseconds: 51955,
  },
  "packages/platform-cf/src/hns-lifecycle-projection.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 15382,
  },
  "packages/platform-cf/src/hns-lifecycle-readiness-patch.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 13999,
  },
  "packages/platform-cf/src/hns-observation-fence.pg.test.ts": {
    sourceCallCount: 9,
    milliseconds: 32447,
  },
  "packages/platform-cf/src/hns-production-import-privileges.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 3889,
  },
  "packages/platform-cf/src/hns-readiness-ownership.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 36974,
  },
  "packages/platform-cf/src/hns-readiness-zone-mutation-admission.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 28163,
  },
  "packages/platform-cf/src/hns-reconciliation-routing.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 12485,
  },
  "packages/platform-cf/src/hns-renewal-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 1664,
  },
  "packages/platform-cf/src/hns-retention-review.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 21166,
  },
  "packages/platform-cf/src/hns-retention-reviewer.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 4933,
  },
  "packages/platform-cf/src/hns-root-import-lifecycle-execution.pg.test.ts": {
    sourceCallCount: 10,
    milliseconds: 42484,
  },
  "packages/platform-cf/src/hns-root-import-lifecycle-migration.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2633,
  },
  "packages/platform-cf/src/hns-root-import-lifecycle-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 1714,
  },
  "packages/platform-cf/src/hns-root-import-lifecycle-transition.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 10283,
  },
  "packages/platform-cf/src/hns-root-import-lifecycle.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 15887,
  },
  "packages/platform-cf/src/hns-root-import-repository.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 57553,
  },
  "packages/platform-cf/src/hns-route-revalidation-scheduler.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 8367,
  },
  "packages/platform-cf/src/hns-single-owner-readiness-cutover.pg.test.ts": {
    sourceCallCount: 19,
    milliseconds: 67581,
  },
  "packages/platform-cf/src/identity-account-owner.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 3966,
  },
  "packages/platform-cf/src/identity.pg.test.ts": { sourceCallCount: 3, milliseconds: 7024 },
  "packages/platform-cf/src/karaoke-finalization-recovery.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 2242,
  },
  "packages/platform-cf/src/karaoke-instrumental-policy.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 10452,
  },
  "packages/platform-cf/src/karaoke-persona-boundary.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 12736,
  },
  "packages/platform-cf/src/karaoke-playback-authority.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 9899,
  },
  "packages/platform-cf/src/learner-audio-deletion-repository.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 14117,
  },
  "packages/platform-cf/src/localization-foundation.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3109,
  },
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
  "packages/platform-cf/src/owner-spoken-archive.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 27574,
  },
  "packages/platform-cf/src/owner-spoken-checkpoint-foundation.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 15387,
  },
  "packages/platform-cf/src/owner-spoken-checkpoint.pg.test.ts": {
    sourceCallCount: 7,
    milliseconds: 22338,
  },
  "packages/platform-cf/src/owner-study-json-mutations.pg.test.ts": {
    sourceCallCount: 5,
    milliseconds: 25045,
  },
  "packages/platform-cf/src/owner-study-retention.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3280,
  },
  "packages/platform-cf/src/owner-study-starter-alias.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 5879,
  },
  "packages/platform-cf/src/owner-study-starter.pg.test.ts": {
    sourceCallCount: 14,
    milliseconds: 89159,
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
  "packages/platform-cf/src/study-participation-owner-preservation.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 2890,
  },
  "packages/platform-cf/src/study-translation-repository.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5681,
  },
  "packages/platform-cf/src/study-v2-foundation.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3130,
  },
  "packages/platform-cf/src/study-v2-lifecycle.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 10070,
  },
  "packages/platform-cf/src/serving-function-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 6080,
  },
  "packages/platform-cf/src/study-v2-spoken-retry.pg.test.ts": {
    sourceCallCount: 8,
    milliseconds: 21063,
  },
  "packages/platform-cf/src/telegram-http-practice.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 3667,
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
  "packages/platform-cf/src/telegram-study-learner.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 4260,
  },
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
  "scripts/community-purchase-funding-plans.pg.test.ts": { sourceCallCount: 3, milliseconds: 5133 },
  "scripts/hns-continuity/promotion.pg.test.ts": { sourceCallCount: 1, milliseconds: 6730 },
  "scripts/hns-monitor/snapshot.pg.test.ts": { sourceCallCount: 1, milliseconds: 2187 },
  "scripts/megapot-golden-adopted-pool.pg.test.ts": { sourceCallCount: 1, milliseconds: 3000 },
  "scripts/public-post-slug-backfill.pg.test.ts": { sourceCallCount: 3, milliseconds: 6925 },
  "scripts/public-profile-backfill.pg.test.ts": { sourceCallCount: 3, milliseconds: 9501 },
  "scripts/song-video-composed-flow.pg.test.ts": { sourceCallCount: 14, milliseconds: 84823 },
  "scripts/song-video-render-host.pg.test.ts": { sourceCallCount: 4, milliseconds: 5757 },
  "scripts/staging-hns-cutover-probe-reseed.pg.test.ts": { sourceCallCount: 1, milliseconds: 3407 },
  "scripts/staging-hns-gateway-role.pg.test.ts": { sourceCallCount: 1, milliseconds: 452 },
  "scripts/staging-hns-post-migration-entry.pg.test.ts": { sourceCallCount: 8, milliseconds: 6067 },
  "scripts/staging-karaoke-nonreuse.pg.test.ts": { sourceCallCount: 3, milliseconds: 176 },
  "scripts/staging-karaoke-release-database.pg.test.ts": { sourceCallCount: 1, milliseconds: 104 },
  "scripts/staging-persona-database-collector.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 527,
  },
  "scripts/staging-persona-dependency-scan.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 16485,
  },
  "scripts/staging-persona-prepare-reset.pg.test.ts": { sourceCallCount: 4, milliseconds: 2588 },
  "scripts/staging-persona-reconstruct.pg.test.ts": { sourceCallCount: 8, milliseconds: 33811 },
  "scripts/staging-persona-reset-denied-grants.pg.test.ts": {
    sourceCallCount: 3,
    milliseconds: 196,
  },
  "scripts/staging-persona-runtime-denial.pg.test.ts": { sourceCallCount: 8, milliseconds: 257 },
  "scripts/staging-persona-schema-authority.pg.test.ts": { sourceCallCount: 1, milliseconds: 47 },
  "scripts/staging-persona-session-drain.pg.test.ts": { sourceCallCount: 6, milliseconds: 624 },
  "scripts/very-staging-community-fixture.pg.test.ts": { sourceCallCount: 1, milliseconds: 3850 },
};
