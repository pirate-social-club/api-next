import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTelegramConfiguration } from "../packages/platform-cf/src/telegram-configuration.ts";
import { directoryIdentity } from "./production-release/production-operation-evidence.ts";
import { HTTP_RELEASE, sha256 } from "./public-post-http-release-core.ts";
import {
  assertExecutionTools,
  publicPostExecutionTools,
} from "./public-post-http-release-source.ts";
import { telegramProductionRelease } from "./telegram-production-release.ts";
import {
  admitTelegram,
  resolveTelegramPhase,
  type TelegramAdmission,
  type TelegramPhaseIo,
  type TelegramReview,
  telegramJournal,
  telegramPhase,
} from "./telegram-production-release-admission.ts";
import {
  createTelegramWrappingKey,
  telegramSecretMetadata,
} from "./telegram-production-release-credentials.ts";
import { assertTelegramMatrix, TELEGRAM_GRANTS } from "./telegram-production-release-database.ts";
import {
  TELEGRAM_RELEASE as policy,
  TELEGRAM_PHASES,
  type TelegramPhase,
  telegramMode,
} from "./telegram-production-release-policy.ts";
import {
  telegramBindingDelta,
  telegramPhaseConfig,
  telegramQueueConsumer,
} from "./telegram-production-release-workers.ts";

const directories: string[] = [];
const fixture = () => {
  const path = mkdtempSync(join(tmpdir(), "telegram-release-fixture-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const hash = "a".repeat(64),
  now = Date.parse("2026-11-03T07:00:00Z");
function admissionFixture() {
  const directory = fixture();
  const file = (name: string, value: unknown) => {
    const path = join(directory, name),
      bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: sha256(bytes) };
  };
  const instruction = file("owner-instruction.json", { task: policy.task, authorized: true });
  const authority = file("authority.json", {
    kind: "telegram-production-owner-authority-v1",
    actor_role: "workspace_owner",
    accepted: true,
    task: policy.task,
    operation: policy.operation,
    instruction,
    actions: ["workers-install-disabled"],
    community: policy.canary.community,
    post: policy.canary.post,
    funds: false,
  });
  const evidence = file("evidence.json", { fixture: true });
  const review: TelegramReview = {
    kind: "telegram-production-practice-review-v1",
    operation: policy.operation,
    accepted: true,
    reviewer_role: "independent_reviewer",
    findings: [],
    tooling_source: "a".repeat(40),
    execution_tools: publicPostExecutionTools(),
    authority,
    tooling_dependencies: evidence,
    files: [evidence],
    evidence_identity: directoryIdentity(directory),
    journal_identity: directoryIdentity(directory),
    production_backup: evidence,
    website_receipt: evidence,
    credential_contract: evidence,
    catalogue_acceptance: evidence,
    configs: {},
    recovery_targets: { http: evidence, jobs: evidence },
    accepted_predecessor_reviews: [],
    resolutions: {},
    before: {},
    after: {},
  };
  const admission: TelegramAdmission = {
    kind: "telegram-production-resource-admission-v1",
    operation: policy.operation,
    review_sha256: hash,
    phase: "install-jobs",
    access: "effect",
    resource_owner_role: "workspace_coordinator",
    exclusive: true,
    resources: policy.resources,
    not_before: new Date(now - 1_000).toISOString(),
    latest_start: new Date(now + 60_000).toISOString(),
    expires_at: new Date(now + 300_000).toISOString(),
    recovery_until: new Date(now + 600_000).toISOString(),
  };
  return { directory, review, admission, file };
}
test("scope authority is separate from fresh execution admission and cannot be inferred from source acceptance", () => {
  const { directory, review, admission } = admissionFixture();
  expect(() =>
    admitTelegram(review, hash, admission, "install-jobs", "effect", now, directory),
  ).not.toThrow();
  for (const invalid of [
    { ...admission, access: "observe" as const },
    { ...admission, exclusive: false },
    { ...admission, review_sha256: "b".repeat(64) },
    { ...admission, phase: "install-http" as const },
    { ...admission, latest_start: new Date(now - 1).toISOString() },
    { ...admission, expires_at: new Date(now + 199_999).toISOString() },
  ])
    expect(() =>
      admitTelegram(
        review,
        hash,
        invalid as TelegramAdmission,
        "install-jobs",
        "effect",
        now,
        directory,
      ),
    ).toThrow();
  expect(() =>
    admitTelegram(
      { ...review, authority: review.website_receipt },
      hash,
      admission,
      "install-jobs",
      "effect",
      now,
      directory,
    ),
  ).toThrow();
  writeFileSync(review.files[0]?.path ?? "", "changed");
  expect(() =>
    admitTelegram(review, hash, admission, "install-jobs", "effect", now, directory),
  ).toThrow("reviewed-file-changed");
});
function phaseFixture(phase: TelegramPhase = "migration") {
  const directory = fixture(),
    journal = telegramJournal(directory);
  let value = "before",
    effects = 0,
    admissions = 0,
    fail: "none" | "before" | "after" = "none";
  const review = {
    before: { [phase]: sha256(JSON.stringify(value)) },
    after: { [phase]: sha256(JSON.stringify("after")) },
  } as TelegramReview;
  const io: TelegramPhaseIo = {
    ...journal,
    now: () => now,
    admit: async () => {
      admissions++;
      if (fail === "before" && admissions > 1) throw Error("window-closed");
    },
    observe: async () => value,
    effect: async () => {
      effects++;
      value = "after";
      if (fail === "after") throw Error("COMMIT reply lost");
    },
  };
  return {
    directory,
    io,
    review,
    effects: () => effects,
    fail: (next: typeof fail) => {
      fail = next;
    },
  };
}
test("read observation cannot produce an effect or an attempt", async () => {
  const f = phaseFixture();
  await telegramPhase("migration", f.review, hash, hash, "observe", f.io);
  expect(f.effects()).toBe(0);
  expect(f.io.read("migration", "attempt")).toBeUndefined();
});
test("an exclusive durable attempt precedes effect and acknowledgement loss cannot be replayed", async () => {
  const f = phaseFixture();
  f.fail("after");
  await expect(telegramPhase("migration", f.review, hash, hash, "effect", f.io)).rejects.toThrow(
    "COMMIT reply lost",
  );
  expect(f.effects()).toBe(1);
  expect(f.io.read("migration", "attempt")?.state).toBe("attempt");
  expect(f.io.read("migration", "verified")).toBeUndefined();
  await expect(telegramPhase("migration", f.review, hash, hash, "effect", f.io)).rejects.toThrow(
    "phase-already-attempted",
  );
  expect(f.effects()).toBe(1);
});
test("expiry after attempt is retained without effect, and concurrent record replacement is refused", async () => {
  const f = phaseFixture();
  f.fail("before");
  await expect(telegramPhase("migration", f.review, hash, hash, "effect", f.io)).rejects.toThrow(
    "window-closed",
  );
  expect(f.effects()).toBe(0);
  const receipt = f.io.read("migration", "attempt");
  if (!receipt) throw Error("fixture attempt missing");
  expect(() => f.io.save(receipt)).toThrow();
  expect(JSON.parse(readFileSync(join(f.directory, "migration-attempt.json"), "utf8"))).toEqual(
    receipt,
  );
});
test("a reviewed read-only resolution closes a lost acknowledgement without repeating the effect", async () => {
  const f = phaseFixture();
  f.fail("after");
  await expect(telegramPhase("migration", f.review, hash, hash, "effect", f.io)).rejects.toThrow();
  const original = readFileSync(join(f.directory, "migration-attempt.json"));
  f.fail("none");
  const review = {
    ...f.review,
    resolutions: {
      migration: {
        accepted: true as const,
        reviewer_role: "independent_reviewer" as const,
        attempt_sha256: f.io.attemptDigest("migration"),
        observation_sha256: sha256(JSON.stringify("after")),
        conclusion: "effect_verified" as const,
      },
    },
  };
  expect(await resolveTelegramPhase("migration", review, hash, hash, f.io)).toMatchObject({
    conclusion: "effect_verified",
    effect_repeated: false,
  });
  expect(f.effects()).toBe(1);
  expect(f.io.read("migration", "verified")?.state).toBe("verified");
  expect(readFileSync(join(f.directory, "migration-attempt.json"))).toEqual(original);
  await expect(resolveTelegramPhase("migration", review, hash, hash, f.io)).rejects.toThrow(
    "exact-attempt",
  );
});
test("Jobs installation and activation always precede HTTP; recovery has no candidate acceptance prerequisite", async () => {
  expect(TELEGRAM_PHASES["install-http"].predecessors).toEqual(["install-jobs"]);
  expect(TELEGRAM_PHASES["practice-http"].predecessors).toEqual(["practice-jobs"]);
  expect(TELEGRAM_PHASES["pause-http"].predecessors).toEqual(["pause-intent"]);
  expect(TELEGRAM_PHASES["pause-intent"].predecessors).toEqual([]);
  const f = phaseFixture("practice-http");
  await expect(
    telegramPhase("practice-http", f.review, hash, hash, "effect", f.io),
  ).rejects.toThrow("verified-predecessor-required");
  expect(f.effects()).toBe(0);
});
test("all fixed modes decode with linking, pilot and Rewards absent from activation", () => {
  for (const phase of Object.keys(TELEGRAM_PHASES) as TelegramPhase[]) {
    const mode = telegramMode(phase),
      decoded = decodeTelegramConfiguration({ TELEGRAM_CONFIG_JSON: JSON.stringify(mode) });
    expect(decoded.linking_enabled).toBe(false);
    expect(decoded.practice_enabled).toBe(false);
    expect(decoded.community_practice_enabled).toBe(phase.startsWith("practice-"));
  }
  expect(policy.source).not.toBe(HTTP_RELEASE.source);
  expect(HTTP_RELEASE.base).toBe("6862fa976a2fc387ee0e0274ba9f1b2abc447427");
  expect(() => assertExecutionTools({ execution_tools: publicPostExecutionTools() })).not.toThrow();
});
test("the complete grant matrix catches every forbidden privilege and missing reservation permission", () => {
  const rows = [
    ...TELEGRAM_GRANTS.map(([table_name, , expected]) => ({
      table_name,
      table_exists: true,
      schema_usage: true,
      owner_equivalent: false,
      can_delegate: false,
      table_privileges: [...expected, false, false, false, false],
      column_privileges: [expected[0], expected[1], expected[2], false],
    })),
    {
      table_name: "telegram_restricted_bot_affirmations",
      table_exists: true,
      schema_usage: true,
      owner_equivalent: false,
      can_delegate: false,
      table_privileges: Array(8).fill(false),
      column_privileges: Array(4).fill(false),
    },
  ];
  expect(() => assertTelegramMatrix(rows, true)).not.toThrow();
  for (let i = 0; i < rows.length; i++)
    for (const key of ["can_delegate", "owner_equivalent"] as const) {
      const changed = structuredClone(rows);
      const row = changed[i];
      if (!row) throw Error("fixture row missing");
      row[key] = true;
      expect(() => assertTelegramMatrix(changed, true)).toThrow();
    }
  for (let i = 0; i < rows.length; i++)
    for (let p = 0; p < 8; p++) {
      const changed = structuredClone(rows);
      const row = changed[i];
      if (!row) throw Error("fixture row missing");
      row.table_privileges[p] = !row.table_privileges[p];
      expect(() => assertTelegramMatrix(changed, true)).toThrow();
    }
  expect(() => assertTelegramMatrix(rows.slice(0, 9), true)).toThrow();
});
const secret = (name: string, operation: string | null = policy.operation) => ({
  id: "fixture-secret-id",
  workspace: policy.vault.project,
  environment: policy.vault.environment,
  type: "shared",
  secretKey: name,
  version: 1,
  secretValue: "must-never-escape",
  secretMetadata: operation ? [{ key: "pirate_release_operation", value: operation }] : [],
});
test("create-only credentials reject existing names before generating a provider write", async () => {
  let creates = 0;
  await expect(
    createTelegramWrappingKey(
      {
        list: async () => [telegramSecretMetadata(secret(policy.vault.name))],
        create: async () => {
          creates++;
          return {};
        },
      },
      () => {},
    ),
  ).rejects.toThrow("unexpected-existing");
  expect(creates).toBe(0);
});
test("create is one POST, approval is unresolved, and metadata never retains values", async () => {
  let creates = 0,
    lists = 0;
  const row = secret(policy.vault.name);
  const result = await createTelegramWrappingKey(
    {
      list: async () => (++lists === 1 ? [] : [telegramSecretMetadata(row)]),
      create: async (value) => {
        creates++;
        expect(Buffer.from(JSON.parse(value).credential_keys.v1, "base64").length).toBe(32);
        // The v4 create schema omits metadata; list/readback supplies the operation marker.
        return { secret: { ...row, secretMetadata: undefined } };
      },
    },
    () => {},
  );
  expect(creates).toBe(1);
  expect(JSON.stringify(result)).not.toContain("must-never-escape");
  await expect(
    createTelegramWrappingKey(
      { list: async () => [], create: async () => ({ approval: { id: "pending" } }) },
      () => {},
    ),
  ).rejects.toThrow("approval-or-creation-unresolved");
});
test("the single production Jobs consumer accepts either exact own target alias", () => {
  const queue = { queue_name: policy.queue, queue_id: "fixture-queue" };
  for (const target of [
    { script_name: policy.workers.jobs.name },
    { script: policy.workers.jobs.name },
    { script_name: policy.workers.jobs.name, script: policy.workers.jobs.name },
  ])
    for (const environment of [{}, { environment: undefined }, { environment: "production" }])
      expect(() =>
        telegramQueueConsumer(queue, [{ type: "worker", ...target, ...environment }]),
      ).not.toThrow();
});
test("target aliases cannot hide a conflicting, malformed or wrong worker", () => {
  const queue = { queue_name: policy.queue, queue_id: "fixture-queue" };
  for (const target of [
    {},
    { service: policy.workers.jobs.name },
    { script_name: "pirate-jobs-worker-staging" },
    { script: "pirate-jobs-worker-staging" },
    { script_name: policy.workers.jobs.name, script: "pirate-jobs-worker-staging" },
    { script_name: "pirate-jobs-worker-staging", script: policy.workers.jobs.name },
    { script_name: policy.workers.jobs.name, script: undefined },
    { script_name: undefined, script: policy.workers.jobs.name },
    { script_name: policy.workers.jobs.name, script: null },
    { script_name: null, script: policy.workers.jobs.name },
    { script_name: policy.workers.jobs.name, script: 1 },
    { script_name: {}, script: policy.workers.jobs.name },
    { script: [policy.workers.jobs.name] },
    { script: ` ${policy.workers.jobs.name}` },
  ])
    expect(() => telegramQueueConsumer(queue, [{ type: "worker", ...target }])).toThrow();
  const inherited = Object.assign(Object.create({ script: policy.workers.jobs.name }), {
    type: "worker",
  });
  expect(() => telegramQueueConsumer(queue, [inherited])).toThrow();
});
test("queue, exact-one, worker type and production environment fences remain required", () => {
  const queue = { queue_name: policy.queue, queue_id: "fixture-queue" };
  const consumer = { type: "worker", script: policy.workers.jobs.name };
  for (const rows of [
    [],
    [consumer, consumer],
    [{ ...consumer, type: "http_pull" }],
    ...["staging", "", null, false].map((environment) => [{ ...consumer, environment }]),
  ])
    expect(() => telegramQueueConsumer(queue, rows)).toThrow();
  for (const target of [
    { ...queue, queue_name: "pirate-community-telegram-staging" },
    { ...queue, queue_id: undefined },
  ])
    expect(() => telegramQueueConsumer(target, [consumer])).toThrow();
});
test("phase configuration preserves unrelated flags and binding drift is refused", () => {
  const source = JSON.stringify({
    name: "development",
    account_id: policy.account,
    main: "src/index.ts",
    compatibility_date: "2026-08-01",
    env: {
      production: {
        name: policy.workers.http.name,
        vars: { MEGAPOT_REWARDS_ENABLED: "false", UNRELATED: "keep" },
        queues: { producers: [] },
      },
    },
  });
  const flat = telegramPhaseConfig("http", "connect-http", source);
  expect(flat.env).toBeUndefined();
  expect(flat.vars).toMatchObject({ UNRELATED: "keep", MEGAPOT_REWARDS_ENABLED: "false" });
  const before = [{ name: "UNRELATED", type: "plain_text", text: "keep" }];
  const after = [
    ...before,
    {
      name: "TELEGRAM_CONFIG_JSON",
      type: "plain_text",
      text: JSON.stringify(telegramMode("connect-http")),
    },
    { name: policy.vault.name, type: "secret_text" },
  ];
  expect(() => telegramBindingDelta("http", before, after, "connect-http", true)).not.toThrow();
  expect(() =>
    telegramBindingDelta(
      "http",
      before,
      [{ name: "UNRELATED", type: "plain_text", text: "changed" }, ...after.slice(1)],
      "connect-http",
      true,
    ),
  ).toThrow("unrelated");
});
test("live CLI refuses unreviewed modes and generic target overrides before I/O", async () => {
  for (const args of [
    ["execute"],
    ["preview", "--worker", "other"],
    ["preview", "--phase", "migration"],
    ["deploy"],
  ])
    await expect(telegramProductionRelease(args)).rejects.toThrow();
});

test("intent COMMIT and a failed HTTP pause stay separately resolvable without another COMMIT", async () => {
  const f = phaseFixture("pause-intent");
  await telegramPhase("pause-intent", f.review, hash, hash, "effect", f.io);
  const before = sha256(JSON.stringify("after"));
  const review = {
    ...f.review,
    accepted_predecessor_reviews: [],
    before: { "pause-http": before },
    after: { "pause-http": sha256(JSON.stringify("paused")) },
    resolutions: {},
  } as TelegramReview;
  const io = {
    ...f.io,
    effect: async () => {
      throw Error("HTTP upload not applied");
    },
  };
  await expect(telegramPhase("pause-http", review, hash, hash, "effect", io)).rejects.toThrow(
    "not applied",
  );
  const resolved = {
    ...review,
    resolutions: {
      "pause-http": {
        accepted: true as const,
        reviewer_role: "independent_reviewer" as const,
        attempt_sha256: io.attemptDigest("pause-http"),
        observation_sha256: before,
        conclusion: "not_applied" as const,
      },
    },
  };
  expect(await resolveTelegramPhase("pause-http", resolved, hash, hash, io)).toMatchObject({
    conclusion: "not_applied",
  });
  expect(io.read("pause-intent", "verified")?.state).toBe("verified");
  expect(f.effects()).toBe(1);
  expect(io.read("pause-http", "verified")).toBeUndefined();
});
