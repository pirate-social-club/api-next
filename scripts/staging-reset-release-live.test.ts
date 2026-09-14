import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import type { KaraokeSurfaceReceipt } from "./staging-karaoke-release-operation.ts";
import { STAGING_FENCED_QUEUES } from "./staging-persona-cloudflare-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import {
  loadStagingUpgradeArtifacts,
  STAGING_UPGRADE_RELEASE,
} from "./staging-persona-upgrade-plan.ts";
import type { StagingResetReleaseLiveConfiguration } from "./staging-reset-release-live.ts";

// The reset is mocked so the composition binding's failure receipt and port
// wiring can be exercised without a PostgreSQL cluster, exactly as the
// runtime's own suite does. The real module is spread first: Bun applies a
// module mock process-wide, so replacing the whole module here would break
// every later file that imports another export from it.
let makeReset: () => object = () => {
  throw new Error("reset fixture not armed");
};
const actualPhasedReset = await import("./staging-persona-phased-reset.ts");
mock.module("./staging-persona-phased-reset.ts", () => ({
  ...actualPhasedReset,
  readCompletedStagingReset: actualPhasedReset.readCompletedStagingReset,
  reconstructStagingInPhases: async () => makeReset(),
}));

const {
  assertReviewedStagingCheckouts,
  formatLiveReleaseFailure,
  makeLiveAcceptanceCheck,
  makeLiveStagingUpgradeApplier,
  runLiveStagingResetReleaseComposition,
  STAGING_LIVE_RELEASE,
  validateStagingResetReleaseLiveConfiguration,
} = await import("./staging-reset-release-live.ts");
const { makeStagingLiveReleaseSurfaces } = await import("./staging-reset-release-live-runtime.ts");

const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`.replace(/[^0-9a-f-]/gu, "0");
const id = (seed: string) => seed.repeat(32).slice(0, 32);

const plan = {
  version: "staging-karaoke-release-plan-v2",
  ingressApplicationId: id("a"),
  resumeQueues: STAGING_FENCED_QUEUES.map((name, index) => ({
    name,
    id: id(String(index)),
  })),
  servingWorkers: STAGING_PRODUCER_WORKERS.map((worker, index) => ({
    worker,
    versionId: uuid(index + 1),
  })),
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["versions", "database", "ingress", "producers"],
};
const disposable = {
  mode: "drop_schema_recreate",
  roleName: "api-next-disposable-reset-fixture",
  branchId: "syu03e00w3ux",
  roleTtlMinutes: 30,
};

const configuration = (overrides: { markerDirectory?: string } = {}) => ({
  version: "staging-disposable-release-live-v1",
  executionAuthorized: false,
  approvedPlanDigest: reconciliationDigest(JSON.stringify({ plan, disposable })),
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
      runtimeRole: "api_next_app",
      runtimeIdentityEvidence: "f".repeat(64),
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
  markerDirectory: overrides.markerDirectory ?? "/tmp/staging-live-marker",
  validUntilMs: Date.now() + 3_600_000,
  budgets: {
    removal: { maxOwnLockRows: 1_000, maxClusterLockRows: 1_200, maxClosureObjects: 800 },
    replay: { maxLockRows: 1_000, maxClusterLockRows: 1_200, statementTimeoutMs: 120_000 },
  },
  disposable,
});

test("the reviewed live configuration binds the plan, checkouts and versions", () => {
  const validated = validateStagingResetReleaseLiveConfiguration(configuration());
  expect(validated.approvedPlanDigest).toBe(
    reconciliationDigest(JSON.stringify({ plan, disposable })),
  );
  expect(validated.deploymentInputs).toHaveLength(2);
  expect(validated.plan.surfaceOrder).toEqual(["versions", "database", "ingress", "producers"]);
});

test("the live database surface receives the explicit restoration intent from the plan", () => {
  const validated = validateStagingResetReleaseLiveConfiguration(configuration());
  expect(validated.restoration.database.restoreRuntimeConnect).toBe(true);
  let captured: unknown;
  const surfaces = makeStagingLiveReleaseSurfaces(
    validated,
    {
      accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
      apiToken: "token",
    },
    {
      makeDatabaseRelease: ((configuration: unknown) => {
        captured = structuredClone(configuration);
        return {
          async execute() {
            throw new Error("database surface not exercised in this suite");
          },
          async observeRestored() {
            return "fenced" as const;
          },
        };
      }) as never,
    },
  );
  expect(typeof surfaces.database).toBe("function");
  expect(captured).toMatchObject({
    restoreRuntimeConnect: true,
    runtimeRole: "api_next_app",
    targetBindingDigest: "c".repeat(64),
    reviewedGrantDigest: "d".repeat(64),
    runtimeIdentityEvidence: "f".repeat(64),
  });
});

test("a configuration without the explicit restoration intent refuses", () => {
  const base = configuration();
  const { restoreRuntimeConnect: _removed, ...database } = base.restoration.database;
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      restoration: { ...base.restoration, database },
    }),
  ).toThrow();
});

test("the live failure formatter states only allowlisted reasons and a digest", () => {
  const secret = "postgres://operator:hunter2@aws.connect.psdb.cloud:5432/postgres";
  const described = JSON.parse(formatLiveReleaseFailure(new Error(secret))) as {
    reason: string | null;
    message_sha256: string | null;
  };
  expect(described.reason).toBeNull();
  expect(JSON.stringify(described)).not.toContain("hunter2");
  expect(JSON.stringify(described)).not.toContain("postgres://");
  expect(described.message_sha256).toMatch(/^[a-f0-9]{64}$/u);
  const known = JSON.parse(
    formatLiveReleaseFailure(new Error("staging_upgrade_failed_restore_required")),
  ) as { reason: string | null };
  expect(known.reason).toBe("staging_upgrade_failed_restore_required");
});

test("a changed plan digest, order, queue set or serving set refuses", () => {
  const base = configuration();
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({ ...base, approvedPlanDigest: "0".repeat(64) }),
  ).toThrow("staging_live_release_plan_changed");
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      disposable: { ...disposable, roleName: "api-next-disposable-reset-changed" },
    }),
  ).toThrow("staging_live_release_plan_changed");
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      plan: { ...plan, surfaceOrder: ["versions", "ingress", "database", "producers"] },
      approvedPlanDigest: reconciliationDigest(
        JSON.stringify({
          plan: {
            ...plan,
            surfaceOrder: ["versions", "ingress", "database", "producers"],
          },
          disposable,
        }),
      ),
    }),
  ).toThrow("staging_live_release_order_changed");
  const changedQueues = {
    ...plan,
    resumeQueues: plan.resumeQueues.map((queue, index) =>
      index === 0 ? { ...queue, name: "pirate-other-staging" } : queue,
    ),
  };
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      plan: changedQueues,
      approvedPlanDigest: reconciliationDigest(JSON.stringify({ plan: changedQueues, disposable })),
    }),
  ).toThrow("staging_live_release_queue_set_changed");
  const changedServing = { ...plan, servingWorkers: plan.servingWorkers.slice(0, 3) };
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      plan: changedServing,
      approvedPlanDigest: reconciliationDigest(
        JSON.stringify({ plan: changedServing, disposable }),
      ),
    }),
  ).toThrow("staging_live_release_serving_set_changed");
});

test("an unreviewed checkout, mismatched version pin or wrong grant digest refuses", () => {
  const base = configuration();
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      deploymentInputs: base.deploymentInputs.map((input, index) =>
        index === 0 ? { ...input, sourceSha: "0".repeat(40) } : input,
      ),
    }),
  ).toThrow("staging_live_deployment_input_unreviewed");
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      deploymentInputs: base.deploymentInputs.map((input, index) =>
        index === 0 ? { ...input, versionId: uuid(9) } : input,
      ),
    }),
  ).toThrow("staging_live_deployment_version_unpinned");
  expect(() =>
    validateStagingResetReleaseLiveConfiguration({
      ...base,
      restoration: {
        ...base.restoration,
        database: { ...base.restoration.database, reviewedGrantDigest: "0".repeat(64) },
      },
    }),
  ).toThrow("staging_live_release_grant_digest_changed");
});

test("checkout reachability is proven from immutable Git history in both repositories", () => {
  const calls: string[][] = [];
  const accept = (args: readonly string[]) => {
    calls.push([...args]);
    return { stdout: "", status: 0 };
  };
  const verified = assertReviewedStagingCheckouts({
    api: { root: "/api", run: accept },
    solid: { root: "/solid", run: accept },
  });
  expect(verified).toEqual({
    api: STAGING_LIVE_RELEASE.checkouts.api.sourceSha,
    solid: STAGING_LIVE_RELEASE.checkouts.solid.sourceSha,
  });
  expect(calls.some((args) => args[0] === "merge-base" && args.at(-1) === "origin/main")).toBe(
    true,
  );
  expect(() =>
    assertReviewedStagingCheckouts({
      api: {
        root: "/api",
        run: (args) =>
          args[0] === "cat-file" &&
          args.some((arg) => arg.startsWith(STAGING_LIVE_RELEASE.checkouts.api.sourceSha))
            ? { stdout: "", status: 1 }
            : { stdout: "", status: 0 },
      },
      solid: { root: "/solid", run: accept },
    }),
  ).toThrow("staging_live_checkout_missing:api");
  expect(() =>
    assertReviewedStagingCheckouts({
      api: { root: "/api", run: accept },
      solid: {
        root: "/solid",
        run: (args) =>
          args[0] === "merge-base" && args.includes(STAGING_LIVE_RELEASE.checkouts.solid.sourceSha)
            ? { stdout: "", status: 1 }
            : { stdout: "", status: 0 },
      },
    }),
  ).toThrow("staging_live_checkout_unreviewed:solid");
}, 120_000);

test("the live applier requires the exact reconstructed prefix and refuses dry runs", async () => {
  const applied = loadStagingUpgradeArtifacts()
    .migrations.filter(({ version }) => Number(version.slice(0, 4)) >= 120)
    .map(({ version }) => version);
  const seen: unknown[] = [];
  const applier = makeLiveStagingUpgradeApplier("postgres://live", async (input) => {
    seen.push(input);
    return { dryRun: false, result: { applied } } as never;
  });
  const receipt = await applier();
  expect(receipt.toVersion).toBe(STAGING_UPGRADE_RELEASE.terminalVersion);
  expect(receipt.applied).toHaveLength(STAGING_UPGRADE_RELEASE.upgradeCount);
  expect((seen[0] as { connectionString: string }).connectionString).toBe("postgres://live");
  const dry = makeLiveStagingUpgradeApplier(
    "postgres://live",
    async () =>
      ({
        dryRun: true,
        result: { applied: [] },
      }) as never,
  );
  await expect(dry()).rejects.toThrow("staging_live_upgrade_unexpected_dry_run");
}, 120_000);

function sessionResponse(body: unknown = null) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: 200,
    headers: { "set-cookie": "__Host-pirate_session=session-token; Path=/; Secure" },
  });
}

test("the acceptance read exchanges the proof and requires a community-bound persona", async () => {
  const calls: { url: string; cookie?: string | null }[] = [];
  const people = [
    { persona_id: "persona-1", status: "retired", community_binding: null },
    {
      persona_id: "persona-2",
      status: "active",
      community_binding: { community_id: "community-1" },
    },
  ];
  const check = makeLiveAcceptanceCheck({
    apiBaseUrl: "https://api.staging.example/",
    communityId: "community-1",
    privyAccessToken: "privy-token",
    expectedPersonaId: "persona-2",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), cookie: new Headers(init?.headers).get("cookie") });
      if (String(url).endsWith("/auth/session/exchange")) return sessionResponse();
      return new Response(JSON.stringify({ personas: people }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  await expect(check()).resolves.toEqual({ personaId: "persona-2" });
  expect(calls[0]?.url).toBe("https://api.staging.example/auth/session/exchange");
  expect(calls[1]?.cookie).toBe("__Host-pirate_session=session-token");
});

test("the acceptance read refuses a failed session, read or unbound persona", async () => {
  const failing = (status: number) =>
    makeLiveAcceptanceCheck({
      apiBaseUrl: "https://api.staging.example",
      communityId: "community-1",
      privyAccessToken: "privy-token",
      fetch: (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch,
    });
  await expect(failing(401)()).rejects.toThrow("staging_live_acceptance_session_failed");
  const unbound = makeLiveAcceptanceCheck({
    apiBaseUrl: "https://api.staging.example",
    communityId: "community-1",
    privyAccessToken: "privy-token",
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/session/exchange")) return sessionResponse();
      return new Response(JSON.stringify({ personas: [] }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  await expect(unbound()).rejects.toThrow("staging_live_acceptance_persona_unbound");
  const readFailed = makeLiveAcceptanceCheck({
    apiBaseUrl: "https://api.staging.example",
    communityId: "community-1",
    privyAccessToken: "privy-token",
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/session/exchange")) return sessionResponse();
      return new Response(null, { status: 503 });
    }) as typeof globalThis.fetch,
  });
  await expect(readFailed()).rejects.toThrow("staging_live_acceptance_persona_read_failed");
});

test("the composition binding writes a redacted recovery receipt on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-release-recovery-"));
  const base = configuration({ markerDirectory: directory });
  makeReset = () => ({
    async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
      await verifyServingPair();
    },
  });
  const surface =
    (name: "versions" | "database" | "ingress" | "producers") =>
    async (): Promise<KaraokeSurfaceReceipt> => ({
      surface: name,
      releasedAt: new Date().toISOString(),
      receipt: `${name}-receipt`,
    });
  try {
    await expect(
      runLiveStagingResetReleaseComposition({
        configuration: base as unknown as StagingResetReleaseLiveConfiguration,
        database: {} as never,
        artifacts: {} as never,
        admission: {
          markerDirectory: directory,
          targetAndFenceDigest: "e".repeat(64),
          validUntilMs: Date.now() + 600_000,
        } as never,
        surfaces: {
          versions: surface("versions"),
          database: surface("database"),
          ingress: surface("ingress"),
          producers: surface("producers"),
        },
        refence: {
          async database() {},
          async ingress() {},
          async producers() {},
        },
        verifyDeployedPair: async () => {},
        upgrade: {
          async apply() {
            throw new Error("migration apply failed");
          },
        },
      }),
    ).rejects.toThrow("staging_upgrade_failed_restore_required");
    const receipt = JSON.parse(
      await readFile(join(directory, "staging-reset-release-recovery.json"), "utf8"),
    ) as { policy: string; disposition: string; reason: string; upgrade: unknown };
    expect(receipt.policy).toBe(STAGING_LIVE_RELEASE.recovery);
    expect(receipt.disposition).toBe("unresolved");
    expect(receipt.reason).toBe("staging_upgrade_failed_restore_required");
    expect(receipt.upgrade).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
