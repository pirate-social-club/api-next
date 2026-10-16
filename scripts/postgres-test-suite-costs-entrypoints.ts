// Worker and operational script measurements outside HNS.
// Provenance and public aggregate: postgres-test-suite-costs.ts.
export const postgresEntrypointSuiteCostEstimates = {
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
  "apps/jobs-worker/src/megapot-rewards-funding.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 5978,
  },
  "scripts/community-purchase-funding-plans.pg.test.ts": { sourceCallCount: 3, milliseconds: 5133 },
  "scripts/megapot-golden-adopted-pool.pg.test.ts": { sourceCallCount: 1, milliseconds: 3000 },
  "scripts/public-post-slug-backfill.pg.test.ts": { sourceCallCount: 3, milliseconds: 6925 },
  "scripts/public-profile-backfill.pg.test.ts": { sourceCallCount: 3, milliseconds: 9501 },
  "scripts/song-video-composed-flow.pg.test.ts": { sourceCallCount: 14, milliseconds: 84823 },
  "scripts/song-video-render-host.pg.test.ts": { sourceCallCount: 4, milliseconds: 5757 },
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
} as const;
