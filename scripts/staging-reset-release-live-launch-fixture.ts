import type { Client } from "pg";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import type { KaraokeSurfaceReceipt } from "./staging-karaoke-release-operation.ts";
import { STAGING_FENCED_QUEUES } from "./staging-persona-cloudflare-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import { STAGING_LIVE_RELEASE } from "./staging-reset-release-live.ts";

/** Shared fixtures for the live launch binding suite. They contain no test
 * registration so both the launch suite and the failure-recovery cases can
 * bind the same provider and configuration shapes. */

export const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
export const id = (seed: string) => seed.repeat(32).slice(0, 32);
export const ACCESS_HOST = "main.aws.pirate.example";
export const databasePayload = { id: "mvydkmmwh5x4", kind: "postgresql" };
export const branchPayload = { id: "syu03e00w3ux", name: "main", ready: true, state: "ready" };
export const accessPayload = {
  branch: { id: "syu03e00w3ux" },
  default: true,
  access_host_url: ACCESS_HOST,
};
export const credentials = (role: string) =>
  `postgres://${role}.syu03e00w3ux:secret@aws.connect.psdb.cloud:5432/postgres?sslmode=verify-full&sslrootcert=system`;
export const RUNTIME_EVIDENCE = reconciliationDigest(
  JSON.stringify({ login: "runtime_role", active: "runtime_role", database: "postgres" }),
);

export const plan = {
  version: "staging-karaoke-release-plan-v2",
  ingressApplicationId: id("a"),
  resumeQueues: STAGING_FENCED_QUEUES.map((name, index) => ({ name, id: id(String(index)) })),
  servingWorkers: STAGING_PRODUCER_WORKERS.map((worker, index) => ({
    worker,
    versionId: uuid(index + 1),
  })),
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["versions", "database", "ingress", "producers"],
};

export const configuration = (markerDirectory: string) => ({
  version: "staging-reset-release-live-v1",
  executionAuthorized: true,
  approvedPlanDigest: reconciliationDigest(JSON.stringify(plan)),
  plan,
  deploymentInputs: [
    {
      worker: STAGING_LIVE_RELEASE.checkouts.api.worker,
      sourceSha: STAGING_LIVE_RELEASE.checkouts.api.sourceSha,
      versionId: plan.servingWorkers[0]?.versionId,
    },
    {
      worker: STAGING_LIVE_RELEASE.checkouts.solid.worker,
      sourceSha: STAGING_LIVE_RELEASE.checkouts.solid.sourceSha,
      versionId: uuid(9),
    },
  ],
  restoration: {
    ingress: { kind: "remove-fence-application", remainingApplicationsDigest: "e".repeat(64) },
    database: {
      targetBindingDigest: "c".repeat(64),
      reviewedGrantDigest: "d".repeat(64),
      restoreRuntimeConnect: true,
      runtimeRole: "runtime_role",
      runtimeIdentityEvidence: RUNTIME_EVIDENCE,
    },
    producers: {
      schedules: STAGING_PRODUCER_WORKERS.map((worker) => ({ worker, crons: [] })),
    },
  },
  acceptance: {
    apiBaseUrl: "https://api.staging.example",
    communityId: "community-1",
    privyAccessToken: "privy-token",
  },
  reset: { baselineDigest: "9".repeat(64), defaultsDigest: "8".repeat(64) },
  recovery: { captureId: "capture1", captureEvidenceDigest: "7".repeat(64) },
  markerDirectory,
  validUntilMs: Date.now() + 3_600_000,
  budgets: {
    removal: { maxOwnLockRows: 1_000, maxClusterLockRows: 1_200, maxClosureObjects: 800 },
    replay: { maxLockRows: 1_000, maxClusterLockRows: 1_200, statementTimeoutMs: 120_000 },
  },
});

export function fakeClient(role: string, ends: string[], name: string): Client {
  return {
    async connect() {},
    async end() {
      ends.push(name);
    },
    async query(sql: string) {
      if (sql.includes("session_user"))
        return { rows: [{ login: role, active: role, database: "postgres" }] };
      return { rows: [] };
    },
  } as unknown as Client;
}

export function fakeAdmission(directory: string) {
  return (async (input: { admin: Client }) => ({
    markerDirectory: directory,
    recoveryDigest: "7".repeat(64),
    targetAndFenceDigest: "6".repeat(64),
    validUntilMs: Date.now() + 600_000,
    database: "postgres",
    role: "operator",
    runtimeRole: "runtime_role",
    schemaOid: 42,
    defaultsDigest: "8".repeat(64),
    baselineDigest: "9".repeat(64),
    reviewedGrants: [],
    grantPolicy: { explicitNew: [], forbidden: [] },
    removalBudget: {
      maxOwnLockRows: 1_000,
      maxClusterLockRows: 1_200,
      maxClosureObjects: 800,
    },
    replayBudget: {
      maxLockRows: 1_000,
      maxClusterLockRows: 1_200,
      statementTimeoutMs: 120_000,
    },
    async assertFenceAndRecovery() {},
    async assertBaselineReference() {},
    async assertFreshFence() {},
    admin: input.admin,
  })) as never;
}

export function fakeSurfaces() {
  const surface =
    (name: "versions" | "database" | "ingress" | "producers") =>
    async (_directive: unknown, now: () => string): Promise<KaraokeSurfaceReceipt> => ({
      surface: name,
      releasedAt: now(),
      receipt: `${name}-receipt`,
    });
  return {
    versions: surface("versions"),
    database: surface("database"),
    ingress: surface("ingress"),
    producers: surface("producers"),
  };
}
