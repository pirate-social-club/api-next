import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  configurationDigest,
  HTTP_RELEASE,
  type HttpAttempt,
  type HttpCandidate,
  type HttpReleaseIo,
  type HttpReview,
  type HttpSnapshot,
  publicPostHttpRelease,
  sha256,
} from "./public-post-http-release-core.ts";
import { realHttpReleaseIo } from "./public-post-http-release-provider.ts";
import { assertFixedHttpInput, HTTP_PATHS } from "./public-post-http-release-source.ts";
import { REWARDS_AVAILABILITY_HTTP as policy } from "./rewards-availability-http-release-policy.ts";
import { digest } from "./worker-binding-drift.ts";

function fixture() {
  const now = Date.parse("2026-11-02T20:00:00Z");
  const baseline: HttpSnapshot = {
    version: policy.release.baseline,
    message: `git:${policy.release.base}`,
    deployment: "baseline",
    latest: policy.release.baseline,
    binding_runtime_sha256: policy.release.bindings,
    settings_sha256: policy.release.settings,
    declared_comparable_sha256: "same",
    actual_comparable_sha256: "same",
    verifier_representations: {
      actual: null,
      declared: {
        name: "HNS_OWNER_VERIFIER",
        type: "service",
        service: "pirate-hns-owner-verifier-production",
      },
    },
    namespaces: [],
    domains: [],
    subdomain: {},
  };
  const candidate: HttpCandidate = {
    source: policy.release.source,
    tree: policy.release.tree,
    module_sha256: policy.release.module,
    tooling_source: "e".repeat(40),
  };
  const review: HttpReview = {
    kind: policy.reviewKind,
    verdict: "accepted",
    reviewer_role: "independent_coordinator_reviewer",
    tooling_source: candidate.tooling_source,
    snapshot_sha256: digest(baseline),
    source: candidate.source,
    module_sha256: candidate.module_sha256,
    packet_sha256: policy.release.packet,
    baseline: baseline.version,
    window_start: new Date(now).toISOString(),
    window_end: new Date(now + 1_200_000).toISOString(),
    execution_tools: {
      bun_path: "/bun",
      bun_sha256: "b",
      timeout_sha256: "t",
      node_path: "/node",
      node_sha256: "n",
      wrangler_cli_sha256: "w",
    },
  };
  const records = new Map<string, unknown>(),
    events: string[] = [];
  const state = {
    current: baseline,
    candidate,
    moduleFail: false,
    unknownAck: false,
    failGuard: false,
    beforeCommit: () => {},
  };
  const io: HttpReleaseIo = {
    now: () => now,
    candidate: async () => state.candidate,
    collect: async () => state.current,
    observe: async () => state.current,
    read: (name) => records.get(name),
    record: (name, value) => {
      if (records.has(name)) throw Error("spent");
      events.push(name);
      records.set(name, structuredClone(value));
    },
    modules: async () => {
      if (state.moduleFail) throw Error("module failed");
    },
    guardedUpload: async (commit) => {
      events.push("guards");
      if (state.failGuard) throw Error("guard refused");
      state.beforeCommit();
      await commit(async () => {
        events.push("upload");
        state.current = {
          ...baseline,
          version: "candidate-version",
          latest: "candidate-version",
          message: `git:${candidate.source}`,
        };
        if (state.unknownAck) throw Error("unknown ack");
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      return { version: "candidate-version" };
    },
    rollback: async (version, recheck) => {
      await recheck();
      events.push("rollback");
      state.current = { ...baseline, version, latest: "candidate-version" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const run = (
    mode: "snapshot" | "apply" | "verify" | "rollback",
    selectedReview = review,
    from?: string,
  ) => publicPostHttpRelease(mode, selectedReview, "a".repeat(64), io, from, policy);
  const recovery = () => ({
    ...review,
    recovery: {
      version: state.current.version,
      attempt_sha256: digest(records.get("upload-attempt.json")),
      configuration_sha256: configurationDigest(state.current),
    },
  });
  return { baseline, candidate, review, io, records, events, state, run, recovery };
}

describe("fixed Rewards availability successor", () => {
  test("old entry bytes, tuple and journal remain distinct and immutable", () => {
    expect(sha256(readFileSync(new URL("./public-post-http-release.ts", import.meta.url)))).toBe(
      "1381368e280823be2390563edc87d3d2441559d6bfa0ba17a278ff79bea60b91",
    );
    expect(HTTP_RELEASE.source).toBe("b0b88a075fbe24b59bb69650a39bb3cff563e514");
    expect(HTTP_RELEASE.baseline).toBe("0ca64fda-2415-4629-b6fe-68058eeea402");
    expect(HTTP_RELEASE.packet).toBe(
      "6cb7154d6f652df0e75edcd4f44c304730043c9045ecf23ef5c443d3fff9df5c",
    );
    expect(policy.paths.evidence).not.toBe(HTTP_PATHS.evidence);
    expect(policy.paths.application).not.toBe(HTTP_PATHS.application);
    expect(policy.release.bindings).toBe(HTTP_RELEASE.bindings);
    expect(policy.release.settings).toBe(HTTP_RELEASE.settings);
  });
  test("snapshot is harmless and a single guarded upload spends the journal before effect", async () => {
    const f = fixture();
    await f.run("snapshot");
    expect(f.events).toEqual([]);
    await f.run("apply");
    expect(f.events.indexOf("upload-attempt.json")).toBeLessThan(f.events.indexOf("upload"));
    await expect(f.run("apply")).rejects.toThrow("spent");
    expect(f.events.filter((x) => x === "upload")).toHaveLength(1);
  });
  test("failed guards produce no spent marker or effect", async () => {
    const f = fixture();
    f.state.failGuard = true;
    await expect(f.run("apply")).rejects.toThrow("guard refused");
    expect(f.records.size).toBe(0);
    expect(f.events).not.toContain("upload");
  });
  test("old and new candidates, reviews and spent attempts cannot cross policies", async () => {
    const f = fixture();
    await expect(publicPostHttpRelease("snapshot", undefined, "", f.io)).rejects.toThrow(
      "candidate-differs",
    );
    await expect(
      f.run("apply", { ...f.review, kind: "public-post-http-operation-review-v1" }),
    ).rejects.toThrow("independent-review-required");
    await f.run("apply");
    const attempt = f.records.get("upload-attempt.json") as HttpAttempt;
    f.records.set("upload-attempt.json", { ...attempt, source: HTTP_RELEASE.source });
    await expect(f.run("verify")).rejects.toThrow("valid-upload-attempt-required");
  });
  test.each(["source", "tree", "module_sha256"] as const)(
    "changed candidate %s refuses before an effect",
    async (key) => {
      const f = fixture();
      f.state.candidate = { ...f.candidate, [key]: "changed" };
      await expect(f.run("apply")).rejects.toThrow("candidate-differs");
      expect(f.events).toEqual([]);
    },
  );
  test("source and baseline are rechecked after maintained guards", async () => {
    const f = fixture();
    f.state.beforeCommit = () => {
      f.state.current = { ...f.baseline, latest: "foreign" };
    };
    await expect(f.run("apply")).rejects.toThrow("baseline-moved-before-upload");
    expect(f.records.size).toBe(0);
  });
  test("lost acknowledgement remains spent and independently reviewed recovery can restore the baseline", async () => {
    const f = fixture();
    f.state.unknownAck = true;
    await expect(f.run("apply")).rejects.toThrow("upload-unresolved");
    await expect(f.run("apply")).rejects.toThrow("spent");
    await f.run("rollback", f.recovery(), "candidate-version");
    expect(f.state.current.version).toBe(policy.release.baseline);
    expect(f.state.current.latest).toBe("candidate-version");
    await expect(f.run("verify")).resolves.toMatchObject({ state: "baseline" });
  });
  test("persistent failed candidate modules do not prevent exact reviewed recovery", async () => {
    const f = fixture();
    f.state.moduleFail = true;
    await expect(f.run("apply")).rejects.toThrow("module failed");
    await expect(f.run("verify")).rejects.toThrow("module failed");
    await expect(f.run("rollback", f.review, "candidate-version")).rejects.toThrow(
      "rollback-review-does-not-bind-attempt",
    );
    await f.run("rollback", f.recovery(), "candidate-version");
    await expect(f.run("verify")).resolves.toMatchObject({ state: "baseline" });
  });
  test("recovery refuses an unreviewed configuration or foreign version", async () => {
    const f = fixture();
    f.state.moduleFail = true;
    await expect(f.run("apply")).rejects.toThrow();
    const review = f.recovery();
    f.state.current = { ...f.state.current, settings_sha256: "foreign" };
    await expect(f.run("rollback", review, "candidate-version")).rejects.toThrow(
      "rollback-configuration-not-reviewed",
    );
    f.state.current = { ...f.state.current, version: "foreign", latest: "foreign" };
    await expect(f.run("rollback", f.recovery(), "foreign")).rejects.toThrow(
      "rollback-acknowledged-version-differs",
    );
    expect(f.events).not.toContain("rollback");
  });
  test("fixed source adapter rejects old source, root and configuration", () => {
    const input = {
      configPath: policy.release.config,
      environment: "production",
      sourceRef: policy.release.source,
      acceptedMainRef: "origin/main",
    };
    expect(() => assertFixedHttpInput(policy.paths.application, input, policy)).not.toThrow();
    for (const patch of [
      { sourceRef: HTTP_RELEASE.source },
      { configPath: "apps/jobs-worker/wrangler.jsonc" },
      { environment: "staging" },
      { bindingReviewPath: "/override" },
    ])
      expect(() =>
        assertFixedHttpInput(policy.paths.application, { ...input, ...patch }, policy),
      ).toThrow("fixed-http");
    expect(() => assertFixedHttpInput(HTTP_PATHS.application, input, policy)).toThrow("fixed-http");
  });
  test("new real adapter refuses unbound mutations before provider or credential access", async () => {
    await expect(
      realHttpReleaseIo({} as HttpReview, undefined, policy).guardedUpload(async (send) => send()),
    ).rejects.toThrow("bounded-child-required");
    await expect(
      realHttpReleaseIo({} as HttpReview, undefined, policy).rollback(
        policy.release.baseline,
        async () => {},
      ),
    ).rejects.toThrow("bounded-child-required");
  });
  test("relative binary or entry invocation refuses before source or provider adapters", async () => {
    const entry = resolve(import.meta.dir, "rewards-availability-http-release.ts");
    for (const argv of [
      [process.execPath, "scripts/rewards-availability-http-release.ts", "snapshot"],
      ["bun", entry, "snapshot"],
    ]) {
      const child = Bun.spawn(argv, {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("absolute-fixed-entry-required");
    }
  });
});
