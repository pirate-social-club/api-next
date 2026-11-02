import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  deployWorkerWithProvenance,
  parseWorkerDeploymentArgs,
  type verifyDeploymentSource,
} from "./deploy-worker-with-provenance.ts";
import { parseHttpReleaseArguments } from "./public-post-http-release.ts";
import { HTTP_RELEASE, type HttpReview, sha256 } from "./public-post-http-release-core.ts";
import {
  publicPostBindingProposal,
  publicPostProviderEnvironment,
  realHttpReleaseIo,
} from "./public-post-http-release-provider.ts";
import {
  assertFixedHttpInput,
  assertQualifiedInputFile,
  HTTP_PATHS,
} from "./public-post-http-release-source.ts";
import type { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import type { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";
import type { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import type { Binding, CandidateBindings } from "./worker-binding-drift.ts";

describe("HTTP release admission boundary", () => {
  const fixed = {
    configPath: HTTP_RELEASE.config,
    environment: "production",
    sourceRef: HTTP_RELEASE.source,
    acceptedMainRef: "origin/main",
  };
  test("the fixed source policy cannot be retargeted to another application or environment", () => {
    expect(() => assertFixedHttpInput(HTTP_PATHS.application, fixed)).not.toThrow();
    for (const patch of [
      { environment: "staging" },
      { configPath: "apps/jobs-worker/wrangler.jsonc" },
      { sourceRef: "origin/main" },
      { acceptedMainRef: "release/unreviewed" },
      { bindingReviewPath: "/tmp/override.json" },
      { toolingSourceRef: "a".repeat(40) },
    ]) {
      expect(() => assertFixedHttpInput(HTTP_PATHS.application, { ...fixed, ...patch })).toThrow(
        "fixed-http-source-input-required",
      );
    }
    expect(() => assertFixedHttpInput("/another/checkout", fixed)).toThrow("fixed-http");
  });
  test("ordinary deployments still reject non-ancestor source before any guard or upload", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      return command[1] === "rev-parse"
        ? { exitCode: 0, stdout: HTTP_RELEASE.source, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "" };
    };
    await expect(deployWorkerWithProvenance("/repo", fixed, runner)).rejects.toThrow(
      "source commit is not reachable from accepted main",
    );
    expect(commands).toHaveLength(2);
    expect(commands.some((row) => row.includes("deploy"))).toBe(false);
    expect(() =>
      parseWorkerDeploymentArgs([
        "--config",
        HTTP_RELEASE.config,
        "--env",
        "production",
        "--public-post-source-exception",
        "1",
      ]),
    ).toThrow("unknown deployment argument");
  });
  test("the internal fixed verifier runs again at the guarded effect boundary", async () => {
    const rewards: typeof withRewardsBindingDeployment = async (_root, _config, _env, op) => op();
    const telegram: typeof withTelegramActivationDeployment = async (_root, _config, _env, op) =>
      op();
    const serving: typeof withServingFunctionPrivilegesDeployment = async (_root, _config, op) =>
      op();
    for (const changed of [false, true]) {
      let checks = 0,
        lists = 0,
        uploads = 0;
      const verifier: typeof verifyDeploymentSource = async () => ({
        sourceSha: ++checks === 2 && changed ? "f".repeat(40) : HTTP_RELEASE.source,
        configPath: HTTP_RELEASE.config,
      });
      const runner: CommandRunner = async (command) => {
        if (command[2] === "deploy") uploads++;
        const stdout =
          command[2] === "versions"
            ? JSON.stringify(
                ++lists === 1
                  ? []
                  : [
                      {
                        id: "new-version",
                        annotations: { "workers/message": `git:${HTTP_RELEASE.source}` },
                      },
                    ],
              )
            : "";
        return { exitCode: 0, stdout, stderr: "" };
      };
      const result = deployWorkerWithProvenance(
        "/repo",
        fixed,
        runner,
        () => {},
        undefined,
        rewards,
        async () => null,
        telegram,
        serving,
        async () => null,
        verifier,
      );
      if (changed) await expect(result).rejects.toThrow("source changed before upload");
      else await expect(result).resolves.toMatchObject({ worker_version_id: "new-version" });
      expect(checks).toBe(2);
      expect(uploads).toBe(changed ? 0 : 1);
    }
  });
  test.each(["--env", "--source", "--config", "--worker", "--evidence", "--skip-review"])(
    "the fixed CLI has no %s override",
    (flag) => {
      expect(() =>
        parseHttpReleaseArguments([
          "apply",
          "--review",
          "/review.json",
          "--review-sha",
          "a".repeat(64),
          flag,
          "override",
        ]),
      ).toThrow("unknown-or-duplicate");
    },
  );
  test("read-only snapshot has no child path and mutations require an exact review", () => {
    expect(parseHttpReleaseArguments(["snapshot"])).toMatchObject({
      mode: "snapshot",
      child: false,
    });
    expect(() => parseHttpReleaseArguments(["apply"])).toThrow("review-required");
    expect(() => parseHttpReleaseArguments(["--child", "snapshot"])).toThrow("child-mode");
    expect(() =>
      parseHttpReleaseArguments([
        "--child",
        "verify",
        "--review",
        "/review",
        "--review-sha",
        "a".repeat(64),
      ]),
    ).toThrow("child-mode");
    expect(() =>
      parseHttpReleaseArguments([
        "rollback",
        "--review",
        "/review",
        "--review-sha",
        "a".repeat(64),
      ]),
    ).toThrow("rollback-from-required");
  });
  test("the real mutation adapter refuses an unbound caller before credentials or provider calls", async () => {
    const review = {} as HttpReview;
    await expect(realHttpReleaseIo(review).guardedUpload(async (send) => send())).rejects.toThrow(
      "bounded-child-required",
    );
    await expect(realHttpReleaseIo(review).rollback(HTTP_RELEASE.baseline)).rejects.toThrow(
      "bounded-child-required",
    );
  });
  test("the managed login child strips injected credentials and disables credential-bearing logs", () => {
    const environment = publicPostProviderEnvironment({
      PATH: "/tools",
      HOME: "/operator",
      CLOUDFLARE_API_TOKEN: "diagnostics-only",
      HNS_PRODUCTION_POSTGRES_ADMIN_URL: "not-a-child-value",
      SECRET_VALUE: "not-a-child-value",
      WRANGLER_WRITE_LOGS: "true",
      WRANGLER_SEND_METRICS: "true",
    });
    expect(environment).toEqual({
      PATH: "/tools",
      HOME: "/operator",
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_SEND_METRICS: "false",
    });
  });
  test("binding comparison preserves default production metadata but rejects changed or missing bindings", () => {
    const service: Binding = {
      name: "HNS_OWNER_VERIFIER",
      type: "service",
      service: "pirate-hns-owner-verifier-production",
    };
    const flag: Binding = { name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text", text: "false" };
    const secret: Binding = { name: "EXISTING_AUTH", type: "secret_text" };
    const actual = [{ ...service, environment: "production" }, flag, secret];
    const candidate: CandidateBindings = {
      worker_name: HTTP_RELEASE.worker,
      bindings: [service, flag],
      runtime: {},
      required_secrets: ["EXISTING_AUTH"],
    };
    expect(publicPostBindingProposal(actual, candidate).verifierActual.environment).toBe(
      "production",
    );
    expect(
      publicPostBindingProposal(actual, candidate).verifierDeclared.environment,
    ).toBeUndefined();
    for (const change of [
      { environment: "staging" },
      { service: "another-worker" },
      { entrypoint: "Other" },
    ]) {
      expect(() =>
        publicPostBindingProposal(actual, {
          ...candidate,
          bindings: [{ ...service, ...change }, flag],
        }),
      ).toThrow();
    }
    expect(() =>
      publicPostBindingProposal(
        actual.filter((row) => row.name !== service.name),
        candidate,
      ),
    ).toThrow("verifier-binding-missing");
    expect(() => publicPostBindingProposal(actual, { ...candidate, bindings: [flag] })).toThrow(
      "verifier-binding-missing",
    );
    expect(() =>
      publicPostBindingProposal(
        actual.filter((row) => row.name !== secret.name),
        candidate,
      ),
    ).toThrow("required-existing-secret-missing");
    expect(() =>
      publicPostBindingProposal(
        [...actual, { name: "UNEXPECTED", type: "plain_text", text: "x" }],
        candidate,
      ),
    ).toThrow("candidate-bindings-differ");
    expect(() =>
      publicPostBindingProposal(actual, {
        ...candidate,
        bindings: [service, flag, { name: "NEW", type: "plain_text", text: "x" }],
      }),
    ).toThrow("candidate-bindings-differ");
  });
});

describe("qualified build input integrity", () => {
  test("tampering, wrong sizes, traversal and external symlinks refuse", () => {
    const temporary = mkdtempSync(join(tmpdir(), "public-post-inputs-"));
    try {
      const root = join(temporary, "qualified");
      mkdirSync(root);
      writeFileSync(join(root, "index.js"), "qualified code");
      const row = { path: "index.js", bytes: 14, sha256: sha256("qualified code") };
      expect(() => assertQualifiedInputFile(root, row)).not.toThrow();
      expect(() => assertQualifiedInputFile(root, { ...row, bytes: 13 })).toThrow("changed");
      writeFileSync(join(root, "index.js"), "tampered code!");
      expect(() => assertQualifiedInputFile(root, row)).toThrow("changed");
      writeFileSync(join(temporary, "outside.js"), "qualified code");
      expect(() => assertQualifiedInputFile(root, { ...row, path: "../outside.js" })).toThrow(
        "outside",
      );
      symlinkSync(join(temporary, "outside.js"), join(root, "linked.js"));
      expect(() => assertQualifiedInputFile(root, { ...row, path: "linked.js" })).toThrow(
        "outside",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
