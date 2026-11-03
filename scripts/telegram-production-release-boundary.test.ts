import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { sha256 } from "./public-post-http-release-core.ts";
import { telegramReadinessFence } from "./telegram-production-release.ts";
import {
  telegramPracticeReadiness,
  telegramReferenceInventory,
} from "./telegram-production-release-catalogue.ts";
import {
  assertTelegramGlobalInventory,
  assertTelegramRowLockAuthority,
  TELEGRAM_ROW_LOCK_TABLES,
} from "./telegram-production-release-database.ts";
import { TELEGRAM_RELEASE as policy, telegramMode } from "./telegram-production-release-policy.ts";
import {
  assertTelegramForwardWorker,
  assertTelegramHyperdriveOrigin,
  assertTelegramRecoveryVersion,
  collectTelegramWorker,
  collectTelegramWorkerMetadata,
  type TelegramWorkerSnapshot,
  telegramUploadBoundary,
  telegramWorkerState,
} from "./telegram-production-release-workers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("abort during awaited observation prevents both marker and upload", async () => {
  const controller = new AbortController();
  let attempts = 0,
    uploads = 0;
  await expect(
    telegramUploadBoundary({
      signal: controller.signal,
      preflight: async () => {
        controller.abort();
      },
      assertBound: () => {},
      attempt: () => {
        attempts++;
      },
      upload: async () => {
        uploads++;
      },
    }),
  ).rejects.toThrow("control-connection-lost");
  expect(attempts).toBe(0);
  expect(uploads).toBe(0);
});
test("expiry or process loss during preflight prevents upload at the actual boundary", async () => {
  let valid = true,
    attempts = 0,
    uploads = 0;
  await expect(
    telegramUploadBoundary({
      preflight: async () => {
        valid = false;
      },
      assertBound: () => {
        if (!valid) throw Error("expired-or-process-lost");
      },
      attempt: () => {
        attempts++;
      },
      upload: async () => {
        uploads++;
      },
    }),
  ).rejects.toThrow("expired-or-process-lost");
  expect(attempts).toBe(0);
  expect(uploads).toBe(0);
});
test("loss immediately after the durable marker retains it and issues zero upload", async () => {
  const controller = new AbortController();
  let attempts = 0,
    uploads = 0;
  await expect(
    telegramUploadBoundary({
      signal: controller.signal,
      preflight: async () => {},
      assertBound: () => {},
      attempt: () => {
        attempts++;
        controller.abort();
      },
      upload: async () => {
        uploads++;
      },
    }),
  ).rejects.toThrow("control-connection-lost");
  expect(attempts).toBe(1);
  expect(uploads).toBe(0);
});
test("retained input refusal occurs before any provider attempt", async () => {
  let uploads = 0,
    attempts = 0;
  await expect(
    telegramUploadBoundary({
      preflight: async () => {
        throw Error("retained-upload-input-changed");
      },
      assertBound: () => {},
      attempt: () => {
        attempts++;
      },
      upload: async () => {
        uploads++;
      },
    }),
  ).rejects.toThrow("retained-upload-input-changed");
  expect(attempts).toBe(0);
  expect(uploads).toBe(0);
});
test("the actual Hyperdrive host, branch-qualified role and database must match", () => {
  const origin = {
    scheme: "postgres",
    host: policy.database.host,
    database: policy.database.name,
    user: `${policy.database.runtime}.${policy.database.branch}`,
    port: 5432,
  };
  expect(() => assertTelegramHyperdriveOrigin(origin)).not.toThrow();
  for (const wrong of [
    { ...origin, host: "other.invalid" },
    { ...origin, database: "other" },
    { ...origin, user: `${policy.database.owner}.${policy.database.branch}` },
    { ...origin, port: 5433 },
    { ...origin, user: `${policy.database.runtime}.otherbranch` },
  ])
    expect(() => assertTelegramHyperdriveOrigin(wrong)).toThrow();
});
test("all21 reviewed owner, ingress and native Study lock relations remain mandatory", () => {
  expect(TELEGRAM_ROW_LOCK_TABLES).toHaveLength(21);
  const rows = TELEGRAM_ROW_LOCK_TABLES.map((table_name) => ({
    table_name,
    table_exists: true,
    can_select: true,
    any_update: true,
  }));
  expect(() => assertTelegramRowLockAuthority(rows)).not.toThrow();
  for (const table of TELEGRAM_ROW_LOCK_TABLES)
    expect(() =>
      assertTelegramRowLockAuthority(
        rows.map((r) => (r.table_name === table ? { ...r, any_update: false } : r)),
      ),
    ).toThrow();
});
test("global inventory admits zero or the exact canary, rejects foreign, stale and overflowing work", () => {
  const allow = [{ bot_id: "fixture-bot", bot_epoch: "fixture-epoch" }];
  const row = {
    community_id: policy.canary.community,
    bot_id: "fixture-bot",
    bot_epoch: "fixture-epoch",
    revision: "2",
    record_revision: "2",
    record_bot_epoch: "fixture-epoch",
    assistant_enabled: false,
    automatic_since: null,
  };
  expect(() => assertTelegramGlobalInventory([], [], [])).not.toThrow();
  expect(() => assertTelegramGlobalInventory([row], [], allow)).not.toThrow();
  expect(() => assertTelegramGlobalInventory([row], [], [])).toThrow();
  expect(() =>
    assertTelegramGlobalInventory([{ ...row, community_id: "foreign" }], [], allow),
  ).toThrow();
  expect(() => assertTelegramGlobalInventory([row, row], [], allow)).toThrow();
  expect(() =>
    assertTelegramGlobalInventory(
      [row],
      Array(21).fill({ community_id: policy.canary.community, bot_epoch: "fixture-epoch" }),
      allow,
    ),
  ).toThrow();
  expect(() =>
    assertTelegramGlobalInventory(
      [row],
      [{ community_id: policy.canary.community, bot_epoch: "stale" }],
      allow,
    ),
  ).toThrow();
});
function disabledSnapshot(version: string): TelegramWorkerSnapshot {
  return {
    version,
    latest: version,
    deployment: "fixture-deployment",
    message: `git:${policy.source}`,
    module_sha256: policy.workers.http.module,
    bindings: [
      {
        name: "TELEGRAM_CONFIG_JSON",
        type: "plain_text",
        text: JSON.stringify(telegramMode("install-http")),
      },
    ],
    runtime: {},
    settings: {},
    domains: [],
    subdomain: {},
    queue: { queue: policy.queue, id: "fixture-queue", consumers: [] },
  };
}
test("equal disabled semantics cannot resolve recovery at the wrong version", () => {
  const target = disabledSnapshot("11111111-1111-1111-1111-111111111111"),
    wrong = disabledSnapshot("22222222-2222-2222-2222-222222222222");
  expect(telegramWorkerState(wrong, true)).toEqual(telegramWorkerState(target, true));
  expect(() => assertTelegramRecoveryVersion(wrong, target, "http")).toThrow(
    "target-version-not-serving",
  );
  expect(() => assertTelegramRecoveryVersion(target, target, "http")).not.toThrow();
  expect(telegramWorkerState({ ...target, latest: wrong.version })).not.toEqual(
    telegramWorkerState(target),
  );
});
test("recovery metadata remains available when compiled module observation fails", async () => {
  const version = "11111111-1111-1111-1111-111111111111",
    calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("?include=modules")) throw Error("module-endpoint-unavailable");
    if (path.endsWith("/deployments"))
      return {
        deployments: [{ id: "deployment", versions: [{ version_id: version, percentage: 100 }] }],
      };
    if (path.endsWith("/versions")) return { items: [{ id: version }] };
    if (path.endsWith(`/versions/${version}`))
      return {
        resources: {
          bindings: [],
          script_runtime: {
            compatibility_date: "2026-08-11",
            compatibility_flags: [],
            usage_model: "standard",
          },
        },
        annotations: {},
      };
    if (path.endsWith("/settings") || path.endsWith("/subdomain")) return {};
    if (path.includes("/workers/domains")) return [];
    if (path.startsWith("/queues?"))
      return [{ queue_name: policy.queue, queue_id: "fixture-queue" }];
    if (path.endsWith("/consumers"))
      return [{ type: "worker", script_name: policy.workers.jobs.name }];
    throw Error("unexpected-read");
  };
  const metadata = await collectTelegramWorkerMetadata("http", api);
  expect(metadata.version).toBe(version);
  expect(metadata.module_sha256).toBeUndefined();
  expect(telegramWorkerState(metadata)).toHaveProperty("module_observation", "not_requested");
  expect(calls.some((path) => path.includes("include=modules"))).toBe(false);
  await expect(collectTelegramWorker("http", api)).rejects.toThrow("module-endpoint-unavailable");
  expect(calls.at(-1)).toBe(
    `/workers/workers/${policy.workers.http.name}/versions/${version}?include=modules`,
  );
  let deployments = 0;
  await expect(
    collectTelegramWorkerMetadata("http", async (path) => {
      const result = await api(path);
      if (path.endsWith("/deployments") && ++deployments > 1)
        return {
          deployments: [
            { id: "changed-deployment", versions: [{ version_id: version, percentage: 100 }] },
          ],
        };
      return result;
    }),
  ).rejects.toThrow("worker-traffic-moved-during-observation");
});
test("metadata-only recovery proves the reviewed exact version without claiming byte observation", () => {
  const target = disabledSnapshot("11111111-1111-1111-1111-111111111111");
  const { module_sha256: _module, ...metadata } = target;
  expect(() => assertTelegramRecoveryVersion(metadata, target, "http")).not.toThrow();
  expect(telegramWorkerState(metadata)).not.toEqual(telegramWorkerState(target));
});
test("same-source latest-serving wrong-mode counterpart and equal-mode version swap refuse", () => {
  const expected = {
    ...disabledSnapshot("11111111-1111-1111-1111-111111111111"),
    module_sha256: policy.workers.jobs.module,
    bindings: [
      {
        name: "TELEGRAM_CONFIG_JSON",
        type: "plain_text",
        text: JSON.stringify(telegramMode("practice-jobs")),
      },
    ],
  };
  expect(() =>
    assertTelegramForwardWorker("practice-http", "jobs", expected, expected),
  ).not.toThrow();
  const wrongMode = {
    ...expected,
    bindings: [
      {
        name: "TELEGRAM_CONFIG_JSON",
        type: "plain_text",
        text: JSON.stringify(telegramMode("connect-jobs")),
      },
    ],
  };
  expect(telegramWorkerState(wrongMode)).not.toEqual(telegramWorkerState(expected));
  expect(() => assertTelegramForwardWorker("practice-http", "jobs", wrongMode, expected)).toThrow(
    "current-worker-version-or-mode-drift",
  );
  expect(() => assertTelegramForwardWorker("practice-http", "jobs", wrongMode, wrongMode)).toThrow(
    "reviewed-current-worker-mode-differs",
  );
  const version = "22222222-2222-2222-2222-222222222222";
  expect(() =>
    assertTelegramForwardWorker(
      "practice-http",
      "jobs",
      { ...expected, version, latest: version },
      expected,
    ),
  ).toThrow("current-worker-version-or-mode-drift");
});
test("the canary intent disable skips unavailable provider and rejecting global readiness", async () => {
  let calls = 0;
  const fail = async () => {
    calls++;
    throw Error("forward-readiness-unavailable");
  };
  expect(await telegramReadinessFence("pause-intent", fail, fail)).toEqual({
    observation_scope: "fixed-canary-intent-only",
  });
  expect(calls).toBe(0);
  await expect(telegramReadinessFence("practice-http", fail, fail)).rejects.toThrow(
    "forward-readiness-unavailable",
  );
  expect(calls).toBe(1);
});
test("global practice can become available before the owner UI enables current-bot Study", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-readiness-fixture-"));
  directories.push(directory);
  const path = join(directory, "readiness.json"),
    now = Date.now();
  const value = JSON.stringify({
    kind: "telegram-production-channel-readiness-v1",
    accepted: true,
    reviewer_role: "independent_reviewer",
    community: policy.canary.community,
    bot_id: "fixture-bot",
    bot_epoch: "fixture-epoch",
    webhook_live: true,
    observed_at: new Date(now).toISOString(),
  });
  writeFileSync(path, value);
  const db = {
    query: async () => ({
      rows: [
        {
          bot_id: "fixture-bot",
          bot_epoch: "fixture-epoch",
          status: "ready",
          study_bot_id: "fixture-bot",
          study_enabled: "false",
        },
      ],
    }),
  } as unknown as pg.Client;
  expect(await telegramPracticeReadiness(db, { path, sha256: sha256(value) }, now)).toMatchObject({
    study_enabled: false,
  });
  await expect(
    telegramPracticeReadiness(db, { path, sha256: sha256(value) }, now, true),
  ).rejects.toThrow("owner-study-intent");
});

test("review keys count independently from all deterministic reference variants", () => {
  const rows = Array.from({ length: 22 }, (_, i) => ({
    exercise_review_key: `key-${i}`,
    lyric_line_id: `line-${i}`,
    reference_sha256: sha256(`reference-${i}`),
    reference_chars: 10,
  }));
  const variants = [
    ...rows,
    {
      ...rows[0],
      exercise_review_key: "key-0",
      lyric_line_id: "line-variant",
      reference_sha256: sha256("variant"),
      reference_chars: 12,
    },
  ];
  expect(telegramReferenceInventory(variants)).toEqual(
    telegramReferenceInventory([...variants].reverse()),
  );
  expect(telegramReferenceInventory(variants)).toMatchObject({
    exercise_count: 22,
    reference_variant_count: 23,
  });
  expect(() =>
    telegramReferenceInventory(variants.filter((r) => r.exercise_review_key !== "key-21")),
  ).toThrow("22-exercise");
});
