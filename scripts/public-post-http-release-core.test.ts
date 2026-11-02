import { describe, expect, test } from "bun:test";
import {
  HTTP_RELEASE,
  type HttpCandidate,
  type HttpReleaseIo,
  type HttpReview,
  type HttpSnapshot,
  normalizedVerifier,
  publicPostHttpRelease,
} from "./public-post-http-release-core.ts";
import { digest } from "./worker-binding-drift.ts";

const now = Date.parse("2026-11-02T16:00:00Z"),
  reviewSha = "a".repeat(64);
function fixture() {
  const baseline: HttpSnapshot = {
    version: HTTP_RELEASE.baseline,
    message: `git:${HTTP_RELEASE.base}`,
    deployment: "baseline-deployment",
    latest: HTTP_RELEASE.baseline,
    binding_runtime_sha256: HTTP_RELEASE.bindings,
    settings_sha256: HTTP_RELEASE.settings,
    declared_comparable_sha256: "same",
    actual_comparable_sha256: "same",
    verifier_representations: {
      actual: {
        name: "HNS_OWNER_VERIFIER",
        type: "service",
        service: "pirate-hns-owner-verifier-production",
        environment: "production",
      },
      declared: {
        name: "HNS_OWNER_VERIFIER",
        type: "service",
        service: "pirate-hns-owner-verifier-production",
      },
    },
    namespaces: [{ name: "DO", type: "durable_object_namespace", namespace_id: "namespace-1" }],
    domains: [{ hostname: "api-next.pirate.sc" }],
    subdomain: { enabled: true },
  };
  const candidate: HttpCandidate = {
    source: HTTP_RELEASE.source,
    tree: HTTP_RELEASE.tree,
    module_sha256: HTTP_RELEASE.module,
    tooling_source: "e".repeat(40),
  };
  const review: HttpReview = {
    kind: "public-post-http-operation-review-v1",
    verdict: "accepted",
    reviewer_role: "independent_coordinator_reviewer",
    tooling_source: candidate.tooling_source,
    snapshot_sha256: digest(baseline),
    source: HTTP_RELEASE.source,
    module_sha256: HTTP_RELEASE.module,
    packet_sha256: HTTP_RELEASE.packet,
    baseline: HTTP_RELEASE.baseline,
    window_start: new Date(now).toISOString(),
    window_end: new Date(now + 1_200_000).toISOString(),
    execution_tools: {
      bun_path: "/test/bun",
      bun_sha256: "b",
      timeout_sha256: "t",
      node_path: "/test/node",
      node_sha256: "n",
      wrangler_cli_sha256: "w",
    },
  };
  const records = new Map<string, unknown>(),
    events: string[] = [];
  const state = {
    current: baseline,
    candidate,
    now,
    exit: 0,
    failGuard: false,
    failModules: false,
    throwUpload: false,
    beforeCommit: undefined as (() => void) | undefined,
  };
  const io: HttpReleaseIo = {
    now: () => state.now,
    candidate: async () => state.candidate,
    collect: async () => state.current,
    read: (name) => records.get(name),
    record: (name, value) => {
      if (records.has(name)) throw Error("exclusive record already exists");
      events.push(`record:${name}`);
      records.set(name, structuredClone(value));
    },
    guardedUpload: async (commit) => {
      events.push("guards");
      if (state.failGuard) throw Error("live preflight refused");
      state.beforeCommit?.();
      await commit(async () => {
        events.push("upload");
        state.current = {
          ...baseline,
          version: "candidate-version",
          latest: "candidate-version",
          message: `git:${HTTP_RELEASE.source}`,
          deployment: "candidate-deployment",
        };
        if (state.throwUpload) throw Error("connection lost after upload");
        return { exitCode: state.exit, stdout: "provider output", stderr: "" };
      });
    },
    modules: async (version) => {
      events.push(`modules:${version}`);
      if (state.failModules) throw Error("module bytes differ");
    },
    rollback: async (version) => {
      events.push(`rollback:${version}`);
      state.current = baseline;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const run = (mode: "snapshot" | "apply" | "verify" | "rollback", from?: string) =>
    publicPostHttpRelease(mode, review, reviewSha, io, from);
  return { baseline, review, state, records, events, io, run };
}

describe("fixed public-post HTTP operation", () => {
  test("snapshot is read-only and admission marker precedes the single effect", async () => {
    const f = fixture();
    await expect(f.run("snapshot")).resolves.toMatchObject({ read_only: true });
    expect(f.events).toEqual([]);
    await expect(f.run("apply")).resolves.toMatchObject({
      uploaded: true,
      version: "candidate-version",
    });
    expect(f.events.indexOf("record:upload-attempt.json")).toBeLessThan(f.events.indexOf("upload"));
    expect(f.events).toContain("modules:candidate-version");
    expect(f.records.has("upload-readback.json")).toBe(true);
    await expect(f.run("apply")).rejects.toThrow("upload-attempt-spent");
    expect(f.events.filter((value) => value === "upload")).toHaveLength(1);
  });
  test("a failed maintained preflight has no upload marker or provider effect", async () => {
    const f = fixture();
    f.state.failGuard = true;
    await expect(f.run("apply")).rejects.toThrow("preflight refused");
    expect(f.records.size).toBe(0);
    expect(f.events).not.toContain("upload");
  });
  test("a conditional review, wrong tuple or insufficient window cannot authorize an upload", async () => {
    for (const patch of [
      { verdict: "conditional" },
      { reviewer_role: "author" },
      { source: HTTP_RELEASE.base },
      { module_sha256: "changed" },
      { tooling_source: "f".repeat(40) },
      { window_start: new Date(now + 1).toISOString() },
      { window_end: new Date(now + 189_999).toISOString() },
    ]) {
      const f = fixture();
      await expect(
        publicPostHttpRelease("apply", { ...f.review, ...patch } as HttpReview, reviewSha, f.io),
      ).rejects.toThrow();
      expect(f.records.size).toBe(0);
      expect(f.events).not.toContain("upload");
    }
  });
  test.each(["binding", "settings", "latest", "source", "declaration", "snapshot"] as const)(
    "refuses %s drift before any upload",
    async (change) => {
      const f = fixture();
      const fields = {
        binding: { binding_runtime_sha256: "different" },
        settings: { settings_sha256: "different" },
        latest: { latest: "unserved-version" },
        source: { message: "git:another-source" },
        declaration: { declared_comparable_sha256: "different" },
        snapshot: { domains: [{ hostname: "unexpected.pirate.sc" }] },
      };
      f.state.current = { ...f.baseline, ...fields[change] };
      await expect(f.run("apply")).rejects.toThrow();
      expect(f.records.size).toBe(0);
      expect(f.events).not.toContain("upload");
    },
  );
  test.each(["source", "tree", "module_sha256"] as const)(
    "rejects a different candidate %s",
    async (key) => {
      const f = fixture();
      f.state.candidate = { ...f.state.candidate, [key]: "different" };
      await expect(f.run("apply")).rejects.toThrow("candidate-differs");
      expect(f.records.size).toBe(0);
    },
  );
  test("rechecks baseline and bytes after DB preflights and before the attempt", async () => {
    for (const target of ["baseline", "candidate"]) {
      const f = fixture();
      f.state.beforeCommit = () => {
        if (target === "baseline") f.state.current = { ...f.baseline, deployment: "moved" };
        else f.state.candidate = { ...f.state.candidate, module_sha256: "changed-after-preflight" };
      };
      await expect(f.run("apply")).rejects.toThrow("before-upload");
      expect(f.records.size).toBe(0);
      expect(f.events).not.toContain("upload");
    }
  });
  test.each(["nonzero", "throw"] as const)(
    "lost acknowledgement (%s) remains spent and reconciles without another effect",
    async (kind) => {
      const f = fixture();
      f.state.exit = 1;
      f.state.throwUpload = kind === "throw";
      await expect(f.run("apply")).rejects.toThrow("upload-unresolved");
      expect(f.records.has("upload-attempt.json")).toBe(true);
      await expect(f.run("apply")).rejects.toThrow("upload-attempt-spent");
      await expect(f.run("verify")).resolves.toMatchObject({ read_only: true, state: "candidate" });
      expect(f.events.filter((value) => value === "upload")).toHaveLength(1);
    },
  );
  test("a failed module postcheck cannot replay; a later read-only check can resolve it", async () => {
    const f = fixture();
    f.state.failModules = true;
    await expect(f.run("apply")).rejects.toThrow("module bytes differ");
    expect(f.records.has("upload-attempt.json")).toBe(true);
    expect(f.records.has("upload-readback.json")).toBe(false);
    await expect(f.run("apply")).rejects.toThrow("upload-attempt-spent");
    f.state.failModules = false;
    await expect(f.run("verify")).resolves.toMatchObject({ state: "candidate" });
  });
  test("expired mutation window refuses, while recovery reads remain possible", async () => {
    const f = fixture();
    await f.run("apply");
    f.state.now += 3_600_000;
    await expect(f.run("rollback", "candidate-version")).rejects.toThrow("window-not-ready");
    await expect(f.run("verify")).resolves.toMatchObject({ read_only: true, state: "candidate" });
  });
  test("rollback verifies the attempted candidate and cannot target an unrelated version", async () => {
    const f = fixture();
    await f.run("apply");
    await expect(f.run("rollback", "another-version")).rejects.toThrow(
      "rollback-from-version-differs",
    );
    expect(f.records.has("rollback-attempt.json")).toBe(false);
    await expect(f.run("rollback", "candidate-version")).resolves.toMatchObject({
      rolled_back: true,
      version: HTTP_RELEASE.baseline,
    });
    expect(f.events.filter((value) => value.startsWith("rollback:"))).toEqual([
      `rollback:${HTTP_RELEASE.baseline}`,
    ]);
    await expect(f.run("verify")).resolves.toMatchObject({ state: "baseline" });
  });
});

describe("fixed service representation", () => {
  const service = {
    name: "HNS_OWNER_VERIFIER",
    type: "service",
    service: "pirate-hns-owner-verifier-production",
  };
  test("only missing/default production environment is equivalent", () => {
    expect(normalizedVerifier(service)).toEqual({ ...service, environment: "production" });
    expect(normalizedVerifier({ ...service, environment: "production" })).toEqual(
      normalizedVerifier(service),
    );
    expect(() => normalizedVerifier({ ...service, environment: "staging" })).toThrow("environment");
    expect(() => normalizedVerifier({ ...service, service: "another-worker" })).toThrow("service");
    expect(digest(normalizedVerifier({ ...service, entrypoint: "Other" }))).not.toEqual(
      digest(normalizedVerifier(service)),
    );
  });
});
