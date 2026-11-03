import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./public-post-http-release-core.ts";
import type { TelegramReview } from "./telegram-production-release-admission.ts";
import {
  TELEGRAM_RELEASE as policy,
  type TelegramWorker,
  type TelegramWorkerSnapshot,
  telegramMode,
} from "./telegram-production-release-policy.ts";
import {
  assertTelegramBaselineCurrent,
  assertTelegramBaselineVersion,
  assertTelegramOrdinaryService,
  assertTelegramPreconnectHistory,
  assertTelegramPreconnectWork,
  restoreTelegramBaseline,
  TELEGRAM_PRECONNECT_COUNTS_SQL,
  type TelegramBaselineRecoveryIo,
} from "./telegram-production-release-recovery.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function snapshot(worker: TelegramWorker, candidate = false): TelegramWorkerSnapshot {
  const fixed = policy.workers[worker];
  const version = candidate ? "11111111-1111-4111-8111-111111111111" : fixed.baseline;
  return {
    version,
    latest: version,
    deployment: `fixture-${worker}-deployment`,
    message: `git:${candidate ? policy.source : fixed.source}`,
    module_sha256: candidate ? fixed.module : fixed.baselineModule,
    bindings: [
      {
        name: "TELEGRAM_CONFIG_JSON",
        type: "plain_text",
        text: JSON.stringify(telegramMode(`install-${worker}`)),
      },
      { name: "CONTROL_PLANE", type: "hyperdrive", id: policy.database.hyperdrive },
    ],
    runtime: { compatibility_date: "2026-09-01" },
    settings: { logpush: false },
    domains: [],
    subdomain: { enabled: false },
    queue: {
      queue: policy.queue,
      id: "a".repeat(32),
      consumers: [{ type: "worker", script_name: policy.workers.jobs.name }],
    },
  };
}
function fixture(worker: TelegramWorker = "http") {
  const directory = mkdtempSync(join(tmpdir(), "telegram-baseline-recovery-"));
  directories.push(directory);
  const file = (name: string, input: unknown) => {
    const path = join(directory, name),
      bytes = JSON.stringify(input);
    writeFileSync(path, bytes);
    return { path, sha256: sha256(bytes) };
  };
  const target = { http: snapshot("http"), jobs: snapshot("jobs") };
  const current = { http: snapshot("http", true), jobs: snapshot("jobs", true) };
  const compatibility = {
    kind: "telegram-preconnect-baseline-compatibility-v1",
    accepted: true,
    reviewer_role: "independent_reviewer",
    findings: [],
    candidate_source: policy.source,
    http_source: policy.workers.http.source,
    jobs_source: policy.workers.jobs.source,
    migration_sha256: policy.database.migrationSha256,
    grants_sha256: "5c5b7f7f24a16654a1aea9360083f0499597f93c23d7242cb057bd0f4bd5957f",
    preconnect_only: true,
    additive_schema_and_grants: true,
    ordinary_website_compatible: true,
    immutable_history_preserved: true,
    evidence: [file("compatibility-evidence.json", { disposable_role_fixture: true })],
  };
  // The outer phase/admission machine is tested separately; this exercises its real recovery adapter.
  const review = {
    resolutions: {},
    baseline_recovery_targets: {
      http: file("target-http.json", target.http),
      jobs: file("target-jobs.json", target.jobs),
    },
    serving_workers: {
      http: file("current-http.json", current.http),
      jobs: file("current-jobs.json", current.jobs),
    },
    baseline_compatibility: file("compatibility.json", compatibility),
  } as unknown as TelegramReview;
  const counts = [...TELEGRAM_PRECONNECT_COUNTS_SQL.matchAll(/SELECT '([^']+)'/gu)].map(
    (match) => ({ kind: match[1], rows: "0" }),
  );
  const events: string[] = [],
    attempts: unknown[] = [];
  let writes = 0;
  const io: TelegramBaselineRecoveryIo = {
    observe: async (name) => {
      events.push(`observe-${name}`);
      return structuredClone(current[name]);
    },
    work: async () => {
      events.push("work");
      return counts;
    },
    assertBound: () => {
      events.push("bound");
    },
    attempt: (value) => {
      events.push("attempt");
      attempts.push(value);
    },
    rollback: async (version, boundary) => {
      events.push("guard-preflight");
      await boundary();
      events.push("traffic");
      writes++;
      expect(version).toBe(target[worker].version);
      current[worker] = { ...structuredClone(target[worker]), latest: current[worker].latest };
      return { exitCode: 0 };
    },
  };
  return {
    directory,
    file,
    target,
    current,
    review,
    compatibility,
    counts,
    events,
    attempts,
    io,
    writes: () => writes,
  };
}

test("preconnect restoration uses the old pair without a candidate upload or credential reader", async () => {
  for (const worker of ["http", "jobs"] as const) {
    const f = fixture(worker);
    await restoreTelegramBaseline(worker, f.review, f.io, f.directory);
    expect(f.writes()).toBe(1);
    expect(f.attempts.length).toBe(1);
    expect(f.events.filter((name) => name === "work")).toHaveLength(2);
    expect(f.events.indexOf("attempt")).toBeGreaterThan(f.events.indexOf("guard-preflight"));
    expect(f.events.indexOf("traffic")).toBeGreaterThan(f.events.indexOf("attempt"));
    expect(f.current[worker].version).toBe(policy.workers[worker].baseline);
  }
});
test("an already restored baseline needs no traffic effect", async () => {
  const f = fixture();
  f.current.http = f.target.http;
  const review = {
    ...f.review,
    serving_workers: { ...f.review.serving_workers, http: f.file("already.json", f.target.http) },
  } as TelegramReview;
  await restoreTelegramBaseline("http", review, f.io, f.directory);
  expect(f.writes()).toBe(0);
  expect(f.attempts).toEqual([]);
});
test("every connect attempt, verified receipt or resolution permanently excludes baseline recovery", async () => {
  const f = fixture();
  for (const worker of ["http", "jobs"])
    for (const suffix of ["attempt", "verified", "resolution", "upload-attempt"]) {
      const path = join(f.directory, `connect-${worker}-${suffix}.json`);
      writeFileSync(path, "{}");
      await expect(restoreTelegramBaseline("http", f.review, f.io, f.directory)).rejects.toThrow(
        "after-any-connect-attempt",
      );
      unlinkSync(path);
    }
  expect(() =>
    assertTelegramPreconnectHistory(
      { ...f.review, resolutions: { "connect-http": {} } } as TelegramReview,
      f.directory,
    ),
  ).toThrow();
  expect(f.events.filter((event) => event !== "bound")).toEqual([]);
  expect(f.writes()).toBe(0);
});
test("global durable setup, session or delivery history cannot be overridden by zero active metrics", async () => {
  const f = fixture();
  expect(() => assertTelegramPreconnectWork(f.counts)).not.toThrow();
  for (const row of f.counts) {
    const bad = f.counts.map((value) => (value === row ? { ...value, rows: "1" } : value));
    await expect(
      restoreTelegramBaseline("http", f.review, { ...f.io, work: async () => bad }, f.directory),
    ).rejects.toThrow("zero-global-telegram-history");
  }
  expect(() => assertTelegramPreconnectWork(f.counts.slice(1))).toThrow();
  expect(() =>
    assertTelegramPreconnectWork([...f.counts, f.counts[0] as Record<string, unknown>]),
  ).toThrow();
  expect(f.writes()).toBe(0);
  expect(f.attempts).toEqual([]);
});
test("exact version, deployment, latest, module, disabled counterpart and resources are fenced", () => {
  const expected = snapshot("http", true),
    target = snapshot("http");
  const changed = [
    { ...expected, version: target.version },
    { ...expected, latest: target.version },
    { ...expected, deployment: "other-deployment" },
    { ...expected, settings: { logpush: true } },
    {
      ...expected,
      bindings: [
        {
          name: "TELEGRAM_CONFIG_JSON",
          type: "plain_text",
          text: JSON.stringify({ enabled: true }),
        },
      ],
    },
  ];
  for (const current of changed)
    expect(() => assertTelegramBaselineCurrent(current, expected, target, "http")).toThrow();
  expect(() =>
    assertTelegramBaselineCurrent(
      expected,
      { ...expected, module_sha256: "a".repeat(64) },
      target,
      "http",
    ),
  ).toThrow();
  expect(() =>
    assertTelegramBaselineCurrent(
      expected,
      expected,
      { ...target, module_sha256: expected.module_sha256 },
      "http",
    ),
  ).toThrow();
  expect(() =>
    assertTelegramBaselineCurrent(
      expected,
      expected,
      { ...target, domains: ["other-domain"] },
      "http",
    ),
  ).toThrow();
});
test("drift or expiry in awaited guard preflight prevents the traffic marker and effect", async () => {
  for (const mutation of ["counterpart", "expiry", "connect", "target"] as const) {
    const f = fixture();
    const rollback: TelegramBaselineRecoveryIo["rollback"] = async (_version, boundary) => {
      if (mutation === "counterpart")
        f.current.jobs = { ...f.current.jobs, settings: { logpush: true } };
      if (mutation === "expiry")
        f.io.assertBound = () => {
          throw Error("expired");
        };
      if (mutation === "connect")
        writeFileSync(join(f.directory, "connect-jobs-attempt.json"), "{}");
      if (mutation === "target")
        writeFileSync(f.review.baseline_recovery_targets?.http.path as string, "{}");
      await boundary();
      throw Error("traffic must remain unreachable");
    };
    await expect(
      restoreTelegramBaseline(
        "http",
        f.review,
        { ...f.io, rollback, assertBound: () => f.io.assertBound() },
        f.directory,
      ),
    ).rejects.toThrow();
    expect(f.writes()).toBe(0);
    expect(f.attempts).toEqual([]);
  }
});
test("unaccepted compatibility cannot authorize traffic", async () => {
  const f = fixture();
  for (const value of [
    { ...f.compatibility, accepted: false },
    { ...f.compatibility, preconnect_only: false },
    { ...f.compatibility, additive_schema_and_grants: false },
    { ...f.compatibility, jobs_source: policy.source },
    { ...f.compatibility, migration_sha256: "a".repeat(64) },
    { ...f.compatibility, evidence: [] },
  ]) {
    const review = { ...f.review, baseline_compatibility: f.file("bad-compatibility.json", value) };
    await expect(restoreTelegramBaseline("http", review, f.io, f.directory)).rejects.toThrow();
  }
  expect(f.writes()).toBe(0);
  expect(f.attempts).toEqual([]);
});
test("lost traffic acknowledgement is never retried or represented as accepted", async () => {
  const f = fixture();
  let calls = 0;
  const rollback: TelegramBaselineRecoveryIo["rollback"] = async (_version, boundary) => {
    calls++;
    await boundary();
    throw Error("lost acknowledgement");
  };
  await expect(
    restoreTelegramBaseline("http", f.review, { ...f.io, rollback }, f.directory),
  ).rejects.toThrow("lost acknowledgement");
  expect(calls).toBe(1);
  expect(f.attempts).toHaveLength(1);
});
test("a skipped boundary or wrong final version cannot yield verified recovery", async () => {
  const f = fixture();
  await expect(
    restoreTelegramBaseline(
      "http",
      f.review,
      { ...f.io, rollback: async () => ({ exitCode: 0 }) },
      f.directory,
    ),
  ).rejects.toThrow("acknowledgement-unresolved");
  expect(() => assertTelegramBaselineVersion(f.current.http, f.target.http, "http")).toThrow();
  expect(f.attempts).toEqual([]);
  expect(f.writes()).toBe(0);
});

test("connection requires actual disabled backend, deployed website and ordinary-flow acceptance", () => {
  const f = fixture();
  expect(() => assertTelegramOrdinaryService(f.review)).toThrow("before-connect");
  const value = {
    kind: "telegram-disabled-ordinary-service-acceptance-v1",
    accepted: true,
    reviewer_role: "independent_reviewer",
    findings: [],
    operation: policy.operation,
    api_source: policy.source,
    http_module_sha256: policy.workers.http.module,
    jobs_module_sha256: policy.workers.jobs.module,
    website_source: "78ab15f93ff7e12cdd88277c2b9fa22a186323a2",
    website_artifact: "cd6a0045f711a3f3cea18c6fea33cf98e3d6134f4cf4efc740b897befb2cca85",
    disabled_backend_verified: true,
    website_deployed_verified: true,
    ordinary_flows_verified: true,
    evidence: ["backend", "website", "ordinary-flow"].map((name) =>
      f.file(`${name}-proof.json`, { role_fixture: true }),
    ),
  };
  const accepted = { ...f.review, ordinary_service_acceptance: f.file("ordinary.json", value) };
  expect(() => assertTelegramOrdinaryService(accepted)).not.toThrow();
  for (const bad of [
    { ...value, accepted: false },
    { ...value, api_source: policy.workers.http.source },
    { ...value, website_source: policy.source },
    { ...value, website_deployed_verified: false },
    { ...value, ordinary_flows_verified: false },
    { ...value, operation: "other-operation" },
  ])
    expect(() =>
      assertTelegramOrdinaryService({
        ...f.review,
        ordinary_service_acceptance: f.file("bad-ordinary.json", bad),
      }),
    ).toThrow();
  expect(f.events).toEqual([]);
});
