import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import {
  loadStagingUpgradeArtifacts,
  STAGING_UPGRADE_RELEASE,
  stagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";
import {
  type AccessFenceState,
  accessFenceFetch,
} from "./staging-reset-release-live-refence-fixture.ts";

let makeReset: () => object = () => {
  throw new Error("reset fixture not armed");
};
// Spread the real module: Bun applies a module mock process-wide, so a partial
// replacement of the whole module breaks later files importing other exports.
const actualPhasedReset = await import("./staging-persona-phased-reset.ts");
mock.module("./staging-persona-phased-reset.ts", () => ({
  ...actualPhasedReset,
  readCompletedStagingReset: actualPhasedReset.readCompletedStagingReset,
  reconstructStagingInPhases: async () => makeReset(),
}));

const {
  assertLiveBaselineReference,
  assertLiveBranchIdentity,
  liveConnectionTarget,
  liveFenceDigest,
  makeSolidServingVerifier,
  makeStagingLiveRefence,
  runStagingResetReleaseLive,
  withProviderLiveStagingOperator,
} = await import("./staging-reset-release-live-runtime.ts");
const { makeLiveIngressRefence } = await import("./staging-reset-release-ingress-refence.ts");
const {
  ACCESS_HOST,
  accessPayload,
  branchPayload,
  configuration,
  credentials,
  databasePayload,
  fakeAdmission,
  fakeClient,
  fakeSurfaces,
  plan,
  uuid,
} = await import("./staging-reset-release-live-launch-fixture.ts");

test("the provider identity refuses a wrong branch, wrong database or restored branch", () => {
  expect(
    assertLiveBranchIdentity({
      database: databasePayload,
      branch: branchPayload,
      access: accessPayload,
    }),
  ).toBe(ACCESS_HOST);
  expect(() =>
    assertLiveBranchIdentity({
      database: databasePayload,
      branch: { ...branchPayload, id: "other" },
      access: accessPayload,
    }),
  ).toThrow("staging_live_branch_mismatch");
  expect(() =>
    assertLiveBranchIdentity({
      database: { id: databasePayload.id, kind: "mysql" },
      branch: branchPayload,
      access: accessPayload,
    }),
  ).toThrow("staging_live_database_mismatch");
  expect(() =>
    assertLiveBranchIdentity({
      database: databasePayload,
      branch: { ...branchPayload, restored_from_branch: { id: "backup" } },
      access: accessPayload,
    }),
  ).toThrow("staging_live_branch_restored");
});

test("the live connection rewrites to the verified host and refuses rehearsal shapes", () => {
  const target = liveConnectionTarget(credentials("operator"), ACCESS_HOST, "syu03e00w3ux");
  expect(target.role).toBe("operator");
  expect(target.connectionString).toContain(ACCESS_HOST);
  expect(() => liveConnectionTarget(credentials("operator"), ACCESS_HOST, "abc123")).toThrow(
    "staging_live_branch_suffix_mismatch",
  );
  expect(() =>
    liveConnectionTarget(
      "postgres://operator:secret@host:5432/postgres?sslmode=prefer",
      ACCESS_HOST,
      "syu03e00w3ux",
    ),
  ).toThrow("staging_live_connection_unproven");
  expect(() =>
    liveConnectionTarget(
      "postgres://:secret@host:5432/postgres?sslmode=verify-full&sslrootcert=system",
      ACCESS_HOST,
      "syu03e00w3ux",
    ),
  ).toThrow("staging_live_connection_unproven");
});

test("the operator boundary hands out identities with no runtime probe and closes the connection", async () => {
  const ends: string[] = [];
  const clients: Client[] = [fakeClient("operator", ends, "operator")];
  let connects = 0;
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  const env = {
    CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
    CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
  };
  const observed = await withProviderLiveStagingOperator(
    async (_admin, operatorRole, runtimeRole, _connectionString) => {
      expect(operatorRole).toBe("operator");
      expect(runtimeRole).toBe("runtime_role");
      return "ok";
    },
    {
      env,
      provider,
      connect: () => {
        connects++;
        return clients.shift() as Client;
      },
    },
  );
  expect(observed).toBe("ok");
  // Exactly one SQL session is opened. A runtime probe would be refused by the
  // held CONNECT fence or counted by the admission drain, so the boundary
  // deliberately does not open one.
  expect(connects).toBe(1);
  expect(ends).toEqual(["operator"]);
});

test("the operator boundary closes the connection when the callback throws", async () => {
  const ends: string[] = [];
  const clients: Client[] = [fakeClient("operator", ends, "operator")];
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  await expect(
    withProviderLiveStagingOperator(
      async () => {
        throw new Error("surface failed");
      },
      {
        env: {
          CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
        },
        provider,
        connect: () => clients.shift() as Client,
      },
    ),
  ).rejects.toThrow("surface failed");
  expect(ends).toEqual(["operator"]);
});

test("acquisition preserves only allowlisted literals and flattens a shape-only message", async () => {
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  const env = {
    CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
    CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
  };
  const failing = (throwable: Error): Client => {
    const client = fakeClient("operator", [], "operator") as unknown as Client;
    Object.assign(client, {
      query: async () => {
        throw throwable;
      },
    });
    return client;
  };
  const cases: [Error, string][] = [
    // A message that merely starts with staging_live_ is not evidence it is
    // ours; the credential-shaped suffix must not ride out.
    [new Error("staging_live_synthetic_secret_value"), "staging_live_provider_unproven"],
    // A driver body carrying a role name is flattened the same way.
    [
      new Error('password authentication failed for user "pscale_api_example"'),
      "staging_live_provider_unproven",
    ],
    // The module's own verified literal survives.
    [
      new Error("staging_live_operator_identity_unproven"),
      "staging_live_operator_identity_unproven",
    ],
  ];
  for (const [error, expected] of cases)
    await expect(
      withProviderLiveStagingOperator(async () => "ok", {
        env,
        provider,
        connect: () => failing(error),
      }),
    ).rejects.toThrow(expected);
});

test("the operator boundary refuses one role used for both connections", async () => {
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  await expect(
    withProviderLiveStagingOperator(async () => "ok", {
      env: {
        CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("same_role"),
        CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("same_role"),
      },
      provider,
      connect: () => fakeClient("same_role", [], "client"),
    }),
  ).rejects.toThrow("staging_live_roles_not_distinct");
});

test("the fence digest is stable across volatile timestamps and changes on drift", () => {
  const base = {
    database: "postgres",
    schemaOid: 42,
    operatorRole: "operator",
    runtimeRole: "runtime_role",
    sourceLedgerCount: 109,
    defaults: "8".repeat(64),
    producers: { queues: [], verifiedAt: "2026-09-13T00:00:00.000Z" },
    ingress: { ingressDenied: true },
    drain: { other_sessions: 0 },
    recoveryDigest: "7".repeat(64),
  };
  expect(liveFenceDigest(base)).toBe(
    liveFenceDigest({ ...base, producers: { queues: [], verifiedAt: "later" } }),
  );
  expect(liveFenceDigest(base)).not.toBe(
    liveFenceDigest({
      ...base,
      producers: { queues: [{ delivery_paused: false }], verifiedAt: "later" },
    }),
  );
});

test("the baseline reference refuses a foreign source or digest", () => {
  const config = configuration("/tmp/marker") as never;
  expect(() => assertLiveBaselineReference(config, "a".repeat(40), "9".repeat(64))).toThrow(
    "staging_live_baseline_reference_changed",
  );
  expect(() => assertLiveBaselineReference(config, "b".repeat(40), "0".repeat(64))).toThrow(
    "staging_live_baseline_reference_changed",
  );
});

test("the database re-fence rolls back when denial fails", async () => {
  const calls: string[] = [];
  const failing = makeStagingLiveRefence({
    admin: {
      async query(sql: string) {
        calls.push(sql.trim().split("\n")[0] ?? sql);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim())) return { rows: [] };
        if (sql.includes("pg_current_xact_id")) return { rows: [{ xid: "1" }] };
        throw new Error("revocation failed");
      },
    } as unknown as Client,
    runtimeRole: "runtime_role",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    queuePins: plan.resumeQueues,
    fetch: (async () => new Response(JSON.stringify({ success: true, result: [] }))) as never,
  });
  await expect(failing.database()).rejects.toThrow();
  expect(calls[0]).toBe("BEGIN");
  expect(calls).toContain("ROLLBACK");
});

test("the producer re-fence pauses every queue and clears every schedule", async () => {
  const requests: { url: string; method: string; body?: string }[] = [];
  const refence = makeStagingLiveRefence({
    admin: {} as Client,
    runtimeRole: "runtime_role",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    queuePins: plan.resumeQueues,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return new Response(JSON.stringify({ success: true, result: [] }));
    }) as typeof globalThis.fetch,
  });
  await refence.producers();
  const queuePatches = requests.filter((request) => request.method === "PATCH");
  expect(queuePatches).toHaveLength(4);
  expect(queuePatches.every((request) => request.body?.includes('"delivery_paused":true'))).toBe(
    true,
  );
  const schedulePuts = requests.filter((request) => request.method === "PUT");
  expect(schedulePuts).toHaveLength(STAGING_PRODUCER_WORKERS.length);
  expect(schedulePuts.every((request) => request.body === "[]")).toBe(true);
});

test("the ingress re-fence refuses by name when no operator reversal is bound", async () => {
  const refence = makeStagingLiveRefence({
    admin: {} as Client,
    runtimeRole: "runtime_role",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    queuePins: plan.resumeQueues,
    fetch: (async () => new Response(JSON.stringify({ success: true, result: [] }))) as never,
  });
  await expect(refence.ingress()).rejects.toThrow("staging_live_ingress_refence_unavailable");
  let called = false;
  const bound = makeStagingLiveRefence({
    admin: {} as Client,
    runtimeRole: "runtime_role",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    queuePins: plan.resumeQueues,
    refenceIngress: async () => {
      called = true;
    },
    fetch: (async () => new Response(JSON.stringify({ success: true, result: [] }))) as never,
  });
  await bound.ingress();
  expect(called).toBe(true);
});

test("the Solid serving verifier requires the pinned version at full percentage", async () => {
  const versionId = uuid(9);
  const response = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const serving = makeSolidServingVerifier({
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    worker: "pirate-web-solid-staging",
    versionId,
    fetch: (async () =>
      response({
        deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }],
      })) as never,
  });
  await expect(serving()).resolves.toBeUndefined();
  const notServing = makeSolidServingVerifier({
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    apiToken: "token",
    worker: "pirate-web-solid-staging",
    versionId,
    fetch: (async () =>
      response({
        deployments: [{ versions: [{ version_id: uuid(3), percentage: 100 }] }],
      })) as never,
  });
  await expect(notServing()).rejects.toThrow("staging_live_solid_not_serving");
});

async function acceptanceFetch(url: string | URL | Request) {
  if (String(url).endsWith("/auth/session/exchange"))
    return new Response(null, {
      status: 200,
      headers: { "set-cookie": "__Host-pirate_session=session; Path=/; Secure" },
    });
  return new Response(
    JSON.stringify({
      personas: [
        {
          persona_id: "persona-2",
          status: "active",
          community_binding: { community_id: "community-1" },
        },
      ],
    }),
    { status: 200 },
  );
}

async function launcherHarness() {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-"));
  const configPath = join(directory, "live-release.json");
  await writeFile(configPath, JSON.stringify(configuration(directory)));
  const ends: string[] = [];
  const clients: Client[] = [fakeClient("operator", ends, "operator")];
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  const applied = loadStagingUpgradeArtifacts()
    .migrations.filter(({ version }) => Number(version.slice(0, 4)) >= 120)
    .map(({ version }) => version);
  makeReset = () => ({
    async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
      await verifyServingPair();
    },
  });
  const run = (upgradeFails: boolean) =>
    runStagingResetReleaseLive({
      env: {
        STAGING_RESET_RELEASE_LIVE_CONFIG: configPath,
        CLOUDFLARE_API_TOKEN: "token",
        CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
        CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
      },
      provider,
      connect: () => clients.shift() as Client,
      fetch: acceptanceFetch as unknown as typeof globalThis.fetch,
      refenceIngress: async () => {},
      dependencies: {
        reset: async () => makeReset() as never,
        assertCheckouts: () => ({ api: "reviewed-api", solid: "reviewed-solid" }),
        measureAdmission: fakeAdmission(directory),
        makeSurfaces: (() => fakeSurfaces()) as never,
        makeRefence: (() => ({
          async database() {},
          async ingress() {},
          async producers() {},
        })) as never,
        makeVerifier: (() => async () => {}) as never,
        makeCommunityCreation: (() => async () => {}) as never,
        makeApplier: (() => async () => {
          if (upgradeFails) throw new Error("migration apply failed");
          return stagingUpgradeReceipt({ sourceSha: STAGING_UPGRADE_RELEASE.sourceSha }, applied);
        }) as never,
      },
    });
  return { directory, ends, run, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("the launcher composes the reviewed path and closes the connection", async () => {
  const harness = await launcherHarness();
  try {
    const result = await harness.run(false);
    expect(result.release.disposition).toBe("released");
    expect(harness.ends).toEqual(["operator"]);
  } finally {
    await harness.dispose();
  }
});

test("the launcher writes the recovery receipt and closes connections on upgrade failure", async () => {
  const harness = await launcherHarness();
  try {
    await expect(harness.run(true)).rejects.toThrow("staging_upgrade_failed_restore_required");
    expect(harness.ends).toEqual(["operator"]);
    const receipt = JSON.parse(
      await readFile(join(harness.directory, "staging-reset-release-recovery.json"), "utf8"),
    ) as { disposition: string; reason: string };
    expect(receipt.disposition).toBe("unresolved");
    expect(receipt.reason).toBe("staging_upgrade_failed_restore_required");
  } finally {
    await harness.dispose();
  }
});

test("an acceptance failure after ingress opens re-fences through the production reversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-acceptance-"));
  const configPath = join(directory, "live-release.json");
  await writeFile(configPath, JSON.stringify(configuration(directory)));
  const accessState: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  const access = accessFenceFetch(accessState);
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url.startsWith("https://api.staging.example/auth/session/exchange"))
      return new Response(null, {
        status: 200,
        headers: { "set-cookie": "__Host-pirate_session=session; Path=/; Secure" },
      });
    if (url.startsWith("https://api.staging.example/personas"))
      return Response.json({ personas: [] });
    return access(raw as never, init as never);
  }) as unknown as typeof globalThis.fetch;
  const ends: string[] = [];
  const clients: Client[] = [fakeClient("operator", ends, "operator")];
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  const applied = loadStagingUpgradeArtifacts()
    .migrations.filter(({ version }) => Number(version.slice(0, 4)) >= 120)
    .map(({ version }) => version);
  makeReset = () => ({
    async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
      await verifyServingPair();
    },
  });
  try {
    await expect(
      runStagingResetReleaseLive({
        env: {
          STAGING_RESET_RELEASE_LIVE_CONFIG: configPath,
          CLOUDFLARE_API_TOKEN: "token",
          CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
        },
        provider,
        connect: () => clients.shift() as Client,
        fetch,
        dependencies: {
          reset: async () => makeReset() as never,
          assertCheckouts: () => ({ api: "reviewed-api", solid: "reviewed-solid" }),
          measureAdmission: fakeAdmission(directory),
          makeSurfaces: (() => fakeSurfaces()) as never,
          // The real production reversal is bound by the launcher; this only
          // replaces the database and producer re-fences so the production
          // ingress callback runs through the fake provider transport.
          makeRefence: ((input: Parameters<typeof makeStagingLiveRefence>[0]) => {
            const real = makeStagingLiveRefence(input);
            return { database: async () => {}, producers: async () => {}, ingress: real.ingress };
          }) as never,
          makeVerifier: (() => async () => {}) as never,
          makeCommunityCreation: (() => async () => {
            throw new Error("staging_community_creation_failed");
          }) as never,
          makeApplier: (() => async () =>
            stagingUpgradeReceipt(
              { sourceSha: STAGING_UPGRADE_RELEASE.sourceSha },
              applied,
            )) as never,
        },
      }),
    ).rejects.toThrow("staging_reset_release_unresolved_restore_required");
    expect(accessState.creates).toBe(1);
    expect(accessState.policyCreates).toBe(1);
    const receipt = JSON.parse(
      await readFile(join(directory, "staging-reset-release-recovery.json"), "utf8"),
    ) as { refenced: { ingress: string } | null };
    expect(receipt.refenced?.ingress).toBe("restored");
    expect(ends).toEqual(["operator"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled probe records ingress failure and the database re-fence still runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-stalled-"));
  const configPath = join(directory, "live-release.json");
  await writeFile(configPath, JSON.stringify(configuration(directory)));
  const accessState: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  const access = accessFenceFetch(accessState);
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url.startsWith("https://api.staging.example/auth/session/exchange"))
      return new Response(null, {
        status: 200,
        headers: { "set-cookie": "__Host-pirate_session=session; Path=/; Secure" },
      });
    if (url.startsWith("https://api.staging.example/personas"))
      return Response.json({ personas: [] });
    if (
      url.startsWith("https://api-next-staging.pirate.sc/") ||
      url.startsWith("https://pirate-http-worker-staging.")
    )
      return await new Promise<Response>(() => {});
    return access(raw as never, init as never);
  }) as unknown as typeof globalThis.fetch;
  const ends: string[] = [];
  const clients: Client[] = [fakeClient("operator", ends, "operator")];
  let databaseRestored = false;
  const provider = async (path: string) =>
    path.endsWith("/roles/default")
      ? accessPayload
      : path.includes("/branches/")
        ? branchPayload
        : databasePayload;
  const applied = loadStagingUpgradeArtifacts()
    .migrations.filter(({ version }) => Number(version.slice(0, 4)) >= 120)
    .map(({ version }) => version);
  makeReset = () => ({
    async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
      await verifyServingPair();
    },
  });
  try {
    const started = Date.now();
    await expect(
      runStagingResetReleaseLive({
        env: {
          STAGING_RESET_RELEASE_LIVE_CONFIG: configPath,
          CLOUDFLARE_API_TOKEN: "token",
          CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
        },
        provider,
        connect: () => clients.shift() as Client,
        fetch,
        dependencies: {
          reset: async () => makeReset() as never,
          assertCheckouts: () => ({ api: "reviewed-api", solid: "reviewed-solid" }),
          measureAdmission: fakeAdmission(directory),
          makeSurfaces: (() => fakeSurfaces()) as never,
          makeIngressRefence: ((input: Parameters<typeof makeLiveIngressRefence>[0]) =>
            makeLiveIngressRefence({ ...input, probeTimeoutMs: 25 })) as never,
          makeRefence: ((input: Parameters<typeof makeStagingLiveRefence>[0]) => {
            const real = makeStagingLiveRefence(input);
            return {
              database: async () => {
                databaseRestored = true;
              },
              producers: async () => {},
              ingress: real.ingress,
            };
          }) as never,
          makeVerifier: (() => async () => {}) as never,
          makeCommunityCreation: (() => async () => {
            throw new Error("staging_community_creation_failed");
          }) as never,
          makeApplier: (() => async () =>
            stagingUpgradeReceipt(
              { sourceSha: STAGING_UPGRADE_RELEASE.sourceSha },
              applied,
            )) as never,
        },
      }),
    ).rejects.toThrow("staging_reset_release_unresolved_restore_required");
    // The bounded probe fails instead of holding recovery open, so the
    // database re-fence that follows ingress still runs.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(databaseRestored).toBe(true);
    const receipt = JSON.parse(
      await readFile(join(directory, "staging-reset-release-recovery.json"), "utf8"),
    ) as { refenced: { ingress: string; database: string } | null };
    expect(receipt.refenced?.ingress).toBe("failed");
    expect(receipt.refenced?.database).toBe("restored");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a launcher whose reversal cannot be read refuses before any mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-refence-"));
  const configPath = join(directory, "live-release.json");
  await writeFile(configPath, JSON.stringify(configuration(directory)));
  let providerCalls = 0;
  try {
    await expect(
      runStagingResetReleaseLive({
        env: {
          STAGING_RESET_RELEASE_LIVE_CONFIG: configPath,
          CLOUDFLARE_API_TOKEN: "token",
          CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
        },
        fetch: (async () => {
          throw new Error("access transport unavailable");
        }) as unknown as typeof globalThis.fetch,
        dependencies: {
          assertCheckouts: () => ({ api: "reviewed-api", solid: "reviewed-solid" }),
          makeCommunityCreation: (() => async () => {}) as never,
        },
        provider: async () => {
          providerCalls++;
          return databasePayload;
        },
      }),
    ).rejects.toThrow("staging_live_ingress_refence_unavailable");
    expect(providerCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing journey credentials refuse before any provider contact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-credentials-"));
  const configPath = join(directory, "live-release.json");
  await writeFile(configPath, JSON.stringify(configuration(directory)));
  let providerCalls = 0;
  try {
    await expect(
      runStagingResetReleaseLive({
        env: {
          STAGING_RESET_RELEASE_LIVE_CONFIG: configPath,
          CLOUDFLARE_API_TOKEN: "token",
          CONTROL_PLANE_POSTGRES_ADMIN_URL: credentials("operator"),
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: credentials("runtime_role"),
        },
        dependencies: {
          assertCheckouts: () => ({ api: "reviewed-api", solid: "reviewed-solid" }),
        },
        provider: async () => {
          providerCalls++;
          return databasePayload;
        },
      }),
    ).rejects.toThrow("staging_community_creation_credentials_missing");
    expect(providerCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the launcher refuses an unauthorized configuration before contacting anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-launcher-unauthorized-"));
  try {
    const configPath = join(directory, "live-release.json");
    await writeFile(
      configPath,
      JSON.stringify({ ...configuration(directory), executionAuthorized: false }),
    );
    await expect(
      runStagingResetReleaseLive({
        env: { STAGING_RESET_RELEASE_LIVE_CONFIG: configPath, CLOUDFLARE_API_TOKEN: "token" },
        provider: async () => {
          throw new Error("provider must not be contacted");
        },
      }),
    ).rejects.toThrow("staging_live_execution_unauthorized");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
