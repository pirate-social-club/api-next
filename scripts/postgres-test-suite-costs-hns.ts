// HNS lifecycle, authority, continuity and operational entrypoint measurements.
// Provenance and public aggregate: postgres-test-suite-costs.ts.
export const postgresHnsSuiteCostEstimates = {
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
  "apps/jobs-worker/src/hns-active-lease-renewal-production.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 25519,
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
  // Baseline constrained-role red took18.49s; a planning estimate, not green acceptance.
  "packages/platform-cf/src/hns-owner-recovery-runtime-privileges.pg.test.ts": {
    sourceCallCount: 1,
    milliseconds: 20000,
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
    // Retain the 130s baseline plus 100s for the four bounded expiry-clock cases.
    milliseconds: 230000,
  },
  "packages/platform-cf/src/hns-route-revalidation-scheduler.pg.test.ts": {
    sourceCallCount: 4,
    milliseconds: 8367,
  },
  "packages/platform-cf/src/hns-single-owner-readiness-cutover.pg.test.ts": {
    sourceCallCount: 19,
    milliseconds: 67581,
  },
  "scripts/hns-continuity/promotion.pg.test.ts": { sourceCallCount: 1, milliseconds: 6730 },
  "scripts/hns-monitor/snapshot.pg.test.ts": { sourceCallCount: 1, milliseconds: 2187 },
  // PostgreSQL 17.11 at 84799d1d (2026-10-30T00:04Z): two passes in 21.59s.
  // Scheduling measurement only; qualification receipts remain separate.
  "scripts/hns-staging-cookie-profile-successor.pg.test.ts": {
    sourceCallCount: 2,
    milliseconds: 21590,
  },
  "scripts/staging-hns-cutover-probe-reseed.pg.test.ts": { sourceCallCount: 1, milliseconds: 3407 },
  "scripts/staging-hns-gateway-role.pg.test.ts": { sourceCallCount: 1, milliseconds: 452 },
  "scripts/staging-hns-post-migration-entry.pg.test.ts": { sourceCallCount: 8, milliseconds: 6067 },
} as const;
