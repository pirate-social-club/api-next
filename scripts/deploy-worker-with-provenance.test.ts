import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CommandRunner,
  commandEnvironment,
  deployWorkerWithProvenance,
  findDeployedVersion,
  parseWorkerDeploymentArgs,
  parseWorkerVersions,
  resolveDeploymentRepository,
  runCommand,
  runDeploymentCommand,
  verifyDeploymentSource,
  type WorkerDeploymentInput,
} from "./deploy-worker-with-provenance";

import { HNS_STAGING_DIRECT_CHECK_COMMAND } from "./hns-staging-gateway-preflight.ts";
import type { PrepareStagingBindingGuard } from "./staging-serving-bindings-preflight.ts";

import type { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";

const allowTelegram: typeof withTelegramActivationDeployment = async (
  _root,
  _config,
  _environment,
  operation,
) => operation();

const allowStagingBindings: PrepareStagingBindingGuard = async () => null;

import type { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";

const allowRewardDeployment: typeof withRewardsBindingDeployment = async (
  _root,
  _config,
  _environment,
  operation,
) => operation();

const sourceSha = "a".repeat(40);
const input = {
  configPath: "apps/jobs-worker/wrangler.jsonc",
  environment: "staging",
  sourceRef: "origin/main",
  acceptedMainRef: "origin/main",
} as const;

const bootstrapAccount = "b".repeat(32);
const bootstrapWorker = "pirate-video-source-gateway-production";
const absentWorker = (account = bootstrapAccount, worker = bootstrapWorker, code = 10007) =>
  `A request to the Cloudflare API (/accounts/${account}/workers/scripts/${worker}/versions?deployable=true) failed.\nThis Worker does not exist on your account. [code: ${code}]`;
const sourceChecks = (configPath: string) => [
  { exitCode: 0, stdout: sourceSha },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0, stdout: configPath },
];
async function withFirstDeploymentConfig(
  use: (root: string, release: WorkerDeploymentInput) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "worker-first-deployment-"));
  const configPath = "apps/video-source-gateway/wrangler.jsonc";
  try {
    await mkdir(join(root, "apps/video-source-gateway"), { recursive: true });
    await writeFile(
      join(root, configPath),
      JSON.stringify({
        account_id: bootstrapAccount,
        name: "pirate-video-source-gateway",
        env: { production: { name: bootstrapWorker } },
      }),
    );
    await use(root, { ...input, configPath, environment: "production" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function queueRunner(
  results: readonly Readonly<{ exitCode: number; stdout?: string; stderr?: string }>[],
  commands: string[][] = [],
): Readonly<{ runner: CommandRunner; commands: string[][] }> {
  let index = 0;
  return {
    commands,
    runner: async (command) => {
      commands.push([...command]);
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error("unexpected command");
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

describe("Worker deployment provenance", () => {
  test("bootstraps only the exact missing Worker and retains guards and version provenance", async () => {
    await withFirstDeploymentConfig(async (root, release) => {
      const { runner, commands } = queueRunner([
        ...sourceChecks(release.configPath),
        { exitCode: 1, stderr: absentWorker() },
        { exitCode: 0, stdout: "deployed" },
        {
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "first-version", annotations: { "workers/message": `git:${sourceSha}` } },
          ]),
        },
      ]);
      const guarded: string[] = [];
      const reward: typeof withRewardsBindingDeployment = async (
        _root,
        _config,
        _env,
        operation,
      ) => {
        guarded.push("reward");
        return operation();
      };
      const telegram: typeof withTelegramActivationDeployment = async (
        _root,
        _config,
        _env,
        operation,
      ) => {
        guarded.push("telegram");
        return operation();
      };
      const bindings: PrepareStagingBindingGuard = async () => {
        guarded.push("bindings");
        return null;
      };
      const receipt = await deployWorkerWithProvenance(
        root,
        release,
        runner,
        () => {},
        undefined,
        reward,
        bindings,
        telegram,
      );
      expect(receipt).toMatchObject({
        source_sha: sourceSha,
        worker_version_id: "first-version",
        environment: "production",
      });
      expect(guarded).toEqual(["bindings", "telegram", "reward"]);
      expect(commands.filter((command) => command.includes("deploy"))).toHaveLength(1);
      expect(commands[6]?.slice(-2)).toEqual(["--message", `git:${sourceSha}`]);
    });
  });

  test("refuses authentication, transport and wrong-target errors before first deployment", async () => {
    await withFirstDeploymentConfig(async (root, release) => {
      for (const failure of [
        { exitCode: 1, stderr: absentWorker(bootstrapAccount, bootstrapWorker, 10000) },
        { exitCode: 1, stderr: absentWorker("c".repeat(32)) },
        { exitCode: 1, stderr: absentWorker(bootstrapAccount, "other-worker") },
        { exitCode: 1, stderr: `${absentWorker()}\nAuthentication failed [code: 10000]` },
        { exitCode: 1, stderr: "network unavailable [code: 10007]" },
        { exitCode: 124, stderr: absentWorker() },
      ]) {
        const { runner, commands } = queueRunner([...sourceChecks(release.configPath), failure]);
        await expect(deployWorkerWithProvenance(root, release, runner)).rejects.toThrow(
          "pre-deploy version listing failed",
        );
        expect(commands.some((command) => command.includes("deploy"))).toBe(false);
      }
    });
  });

  test("refuses a missing Worker after upload instead of admitting an unproven first deployment", async () => {
    await withFirstDeploymentConfig(async (root, release) => {
      const { runner, commands } = queueRunner([
        ...sourceChecks(release.configPath),
        { exitCode: 1, stderr: absentWorker() },
        { exitCode: 0 },
        { exitCode: 1, stderr: absentWorker() },
      ]);
      await expect(
        deployWorkerWithProvenance(
          root,
          release,
          runner,
          () => {},
          undefined,
          allowRewardDeployment,
          allowStagingBindings,
          allowTelegram,
        ),
      ).rejects.toThrow("post-deploy version listing failed");
      expect(commands.filter((command) => command.includes("deploy"))).toHaveLength(1);
    });
  });

  test("both reward Workers refuse upload when the obligation guard refuses", async () => {
    for (const configPath of [
      "apps/http-worker/wrangler.jsonc",
      "apps/jobs-worker/wrangler.jsonc",
    ]) {
      const release = { ...input, configPath, environment: "prod" };
      const { runner, commands } = queueRunner([
        { exitCode: 0, stdout: sourceSha },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: configPath },
        { exitCode: 0, stdout: "[]" },
      ]);
      const refuse: typeof withRewardsBindingDeployment = async (_root, config, environment) => {
        expect(config).toBe(configPath);
        expect(environment).toBe("prod");
        throw Error("reward binding shutdown refused: unpaid_credits");
      };
      await expect(
        deployWorkerWithProvenance(
          "/repo",
          release,
          runner,
          undefined,
          undefined,
          refuse,
          allowStagingBindings,
          allowTelegram,
        ),
      ).rejects.toThrow("unpaid_credits");
      expect(commands.some((command) => command.includes("deploy"))).toBe(false);
    }
  });
  test("both Telegram executors refuse upload before reward or deployment work", async () => {
    for (const configPath of [
      "apps/http-worker/wrangler.jsonc",
      "apps/jobs-worker/wrangler.jsonc",
    ]) {
      const { runner, commands } = queueRunner([
        { exitCode: 0, stdout: sourceSha },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: configPath },
        { exitCode: 0, stdout: "[]" },
      ]);
      const refused: typeof withTelegramActivationDeployment = async (_root, config, env) => {
        expect(config).toBe(configPath);
        expect(env).toBe("prod");
        throw Error("Telegram activation refused");
      };
      const reward: typeof withRewardsBindingDeployment = async () => {
        throw Error("reward must not run");
      };
      await expect(
        deployWorkerWithProvenance(
          "/repo",
          { ...input, configPath, environment: "prod" },
          runner,
          undefined,
          undefined,
          reward,
          allowStagingBindings,
          refused,
        ),
      ).rejects.toThrow("Telegram activation refused");
      expect(commands.some((command) => command.includes("deploy"))).toBe(false);
    }
  });
  test("Wrangler children never inherit the staging diagnostics token", () => {
    const environment = { CLOUDFLARE_API_TOKEN: "diagnostics", CLOUDFLARE_ACCOUNT_ID: "account" };
    expect(commandEnvironment(["bunx", "wrangler", "deploy"], environment)).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
    });
    expect(commandEnvironment(["bunx", "wrangler", "versions", "list"], environment)).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
    });
    expect(
      commandEnvironment(["bun", "scripts/telegram-activation-preflight.ts"], environment),
    ).toEqual(environment);
    expect(environment.CLOUDFLARE_API_TOKEN).toBe("diagnostics");
  });

  test("shared diagnostics runner preserves its token and deploy environment removes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploy-auth-env-"));
    try {
      const executable = join(directory, "bunx");
      await Bun.write(
        executable,
        `#!${process.execPath}
console.log(JSON.stringify({tokenPresent:!!process.env.CLOUDFLARE_API_TOKEN,account:process.env.CLOUDFLARE_ACCOUNT_ID}));
`,
      );
      const { chmod } = await import("node:fs/promises");
      await chmod(executable, 0o700);
      const environment = {
        PATH: directory,
        CLOUDFLARE_API_TOKEN: "test-diagnostics",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
      };
      const command = ["bunx", "wrangler", "versions", "list"];
      const diagnostics = await runCommand(command, directory, undefined, environment);
      expect(diagnostics.exitCode).toBe(0);
      expect(JSON.parse(diagnostics.stdout)).toEqual({
        tokenPresent: true,
        account: "test-account",
      });
      const deployment = await runDeploymentCommand(command, directory, undefined, environment);
      expect(deployment.exitCode).toBe(0);
      expect(JSON.parse(deployment.stdout)).toEqual({
        tokenPresent: false,
        account: "test-account",
      });
      expect(environment.CLOUDFLARE_API_TOKEN).toBe("test-diagnostics");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("parses only the bounded deploy surface and rejects manual messages", () => {
    expect(
      parseWorkerDeploymentArgs([
        "--config",
        input.configPath,
        "--env",
        "staging",
        "--source-ref",
        "origin/main",
      ]),
    ).toEqual(input);
    for (const [argument, value] of [
      ["--message", "handwritten"],
      ["--accepted-main-ref", "topic-branch"],
      ["--var", "MEGAPOT_REWARDS_ENABLED:true"],
      ["--var", "MEGAPOT_REWARDS_ENABLED:false"],
      ["--disabled-rewards", "false"],
    ])
      expect(() =>
        parseWorkerDeploymentArgs([
          "--config",
          input.configPath,
          "--env",
          "staging",
          argument ?? "",
          value ?? "",
        ]),
      ).toThrow(`unknown deployment argument: ${argument}`);
  });

  test("verifies an accepted exact clean tree and tracked config", async () => {
    const { runner } = queueRunner([
      { exitCode: 0, stdout: `${sourceSha}\n` },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${input.configPath}\n` },
    ]);
    await expect(verifyDeploymentSource("/repo", input, runner)).resolves.toEqual({
      sourceSha,
      configPath: input.configPath,
    });
  });

  test("rejects unreachable, divergent, and untracked source trees", async () => {
    const unreachable = queueRunner([{ exitCode: 0, stdout: sourceSha }, { exitCode: 1 }]).runner;
    await expect(verifyDeploymentSource("/repo", input, unreachable)).rejects.toThrow(
      "not reachable",
    );

    const divergent = queueRunner([
      { exitCode: 0, stdout: sourceSha },
      { exitCode: 0 },
      { exitCode: 1 },
    ]).runner;
    await expect(verifyDeploymentSource("/repo", input, divergent)).rejects.toThrow(
      "does not match",
    );

    const untracked = queueRunner([
      { exitCode: 0, stdout: sourceSha },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "scratch.ts\n" },
    ]).runner;
    await expect(verifyDeploymentSource("/repo", input, untracked)).rejects.toThrow(
      "untracked files",
    );
  });

  test("parses only version ids and Git messages", () => {
    expect(
      parseWorkerVersions(
        JSON.stringify([
          {
            id: "version-1",
            annotations: { "workers/message": `git:${sourceSha}`, ignored: "value" },
            metadata: { author_email: "ignored@example.test" },
          },
          { id: "version-2", annotations: {} },
        ]),
      ),
    ).toEqual([
      { id: "version-1", message: `git:${sourceSha}` },
      { id: "version-2", message: null },
    ]);
    expect(() => parseWorkerVersions("not json")).toThrow("invalid JSON");
    expect(() => parseWorkerVersions(JSON.stringify({ id: "version-1" }))).toThrow("non-array");
  });

  test("fails closed on missing or ambiguous new provenance", () => {
    const before = [{ id: "version-1", message: null }];
    expect(() => findDeployedVersion(before, before, `git:${sourceSha}`)).toThrow("missing");
    expect(() =>
      findDeployedVersion(
        before,
        [
          ...before,
          { id: "version-2", message: `git:${sourceSha}` },
          { id: "version-3", message: `git:${sourceSha}` },
        ],
        `git:${sourceSha}`,
      ),
    ).toThrow("ambiguous");
  });

  test("derives the message and verifies the new remote version", async () => {
    const before = JSON.stringify([{ id: "version-1", annotations: {} }]);
    const after = JSON.stringify([
      { id: "version-2", annotations: { "workers/message": `git:${sourceSha}` } },
      { id: "version-1", annotations: {} },
    ]);
    const commands: string[][] = [];
    const { runner } = queueRunner(
      [
        { exitCode: 0, stdout: sourceSha },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: input.configPath },
        { exitCode: 0, stdout: before },
        { exitCode: 0, stdout: "deployed\n" },
        { exitCode: 0, stdout: after },
      ],
      commands,
    );
    const diagnostics: string[] = [];

    await expect(
      deployWorkerWithProvenance(
        "/repo",
        input,
        runner,
        (text) => diagnostics.push(text),
        undefined,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).resolves.toEqual({
      schema_version: 1,
      source_sha: sourceSha,
      worker_version_id: "version-2",
      environment: "staging",
      config_path: input.configPath,
    });
    expect(commands[6]).toEqual([
      "bunx",
      "wrangler",
      "deploy",
      "--env",
      "staging",
      "--config",
      input.configPath,
      "--message",
      `git:${sourceSha}`,
    ]);
    expect(diagnostics).toEqual(["deployed\n"]);
  });

  test("keeps gateway configuration guards and requires direct-host release acceptance", async () => {
    const manifest = JSON.stringify({
      schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
      mode: "staging-public-tls",
      public_tls_listener: "94.103.168.209:443",
      solid_origin: "https://hns-community-ingress-staging.pirate.sc",
      solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"a".repeat(64)}`,
    });
    const pin = {
      schema: "pirate-hns-staging-gateway-deploy-pin-v1",
      gateway_reference: `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest).digest("hex")}`,
      solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"a".repeat(64)}`,
    };
    const httpInput = { ...input, configPath: "apps/http-worker/wrangler.jsonc" };
    const before = JSON.stringify([{ id: "version-1", annotations: {} }]);
    const after = JSON.stringify([
      { id: "version-1", annotations: {} },
      { id: "version-2", annotations: { "workers/message": `git:${sourceSha}` } },
    ]);
    const { runner, commands } = queueRunner([
      { exitCode: 0, stdout: sourceSha },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: httpInput.configPath },
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
      { exitCode: 0, stdout: "preflight passed" },
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: "deployed" },
      { exitCode: 0, stdout: after },
      { exitCode: 0, stdout: '{"direct":"passed","hns":"failed"}' },
    ]);
    const solidDirectories: string[] = [];
    const linkedRunner: CommandRunner = async (command, cwd, signal) => {
      if (command[0] === "node" || command.includes("check:staging:release"))
        solidDirectories.push(cwd);
      return runner(command, cwd, signal);
    };
    await expect(
      deployWorkerWithProvenance(
        "/workspace/.worktrees/api-next/staging-release",
        httpInput,
        linkedRunner,
        () => undefined,
        async () => pin,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).resolves.toMatchObject({ worker_version_id: "version-2" });
    expect(commands[6]?.[0]).toBe("timeout");
    expect(commands[7]).toEqual(["node", "scripts/hns-staging-gateway-preflight.mjs"]);
    expect(commands[11]).toEqual(["bun", "run", "check:staging:release"]);
    expect(solidDirectories).toEqual([
      "/workspace/pirate-web-solid",
      "/workspace/pirate-web-solid",
    ]);

    const failedDirect = queueRunner([
      ...sourceChecks(httpInput.configPath),
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
      { exitCode: 0 },
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: "deployed" },
      { exitCode: 0, stdout: after },
      { exitCode: 1 },
    ]);
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        failedDirect.runner,
        () => undefined,
        async () => pin,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).rejects.toThrow("staging direct-host release check failed after HTTP deploy");

    const refused = queueRunner([
      { exitCode: 0, stdout: sourceSha },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: httpInput.configPath },
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
    ]);
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        refused.runner,
        () => undefined,
        async () => ({ ...pin, gateway_reference: "old" }),
      ),
    ).rejects.toThrow("differs from the reviewed deploy pin");
    expect(refused.commands.some((command) => command.includes("deploy"))).toBe(false);

    const target = `solid-hns-ingress-sha256:${"b".repeat(64)}`;
    const pendingPin = {
      ...pin,
      gateway_reference: `hns-community-app-handle-gateway-sha256:${"c".repeat(64)}`,
      solid_ingress_composition_reference: target,
      pending_cutover_from: {
        gateway_reference: pin.gateway_reference,
        solid_ingress_composition_reference: pin.solid_ingress_composition_reference,
      },
    };
    const pending = queueRunner([
      ...sourceChecks(httpInput.configPath),
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
      { exitCode: 0, stdout: `${target}\n` },
      { exitCode: 0, stdout: "{}" },
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: "deployed" },
      { exitCode: 0, stdout: after },
      { exitCode: 0, stdout: '{"direct":"passed","hns":"failed"}' },
    ]);
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        pending.runner,
        () => undefined,
        async () => pendingPin,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).resolves.toMatchObject({ worker_version_id: "version-2" });
    expect(pending.commands[7]).toEqual(["node", "scripts/hns-ingress-composition-identity.mjs"]);
    expect(pending.commands[8]).toEqual(HNS_STAGING_DIRECT_CHECK_COMMAND);
    expect(pending.commands[12]).toEqual(HNS_STAGING_DIRECT_CHECK_COMMAND);
    expect(pending.commands.flat()).not.toContain("check:staging:release");

    const failedPendingPrecheck = queueRunner([
      ...sourceChecks(httpInput.configPath),
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
      { exitCode: 0, stdout: `${target}\n` },
      { exitCode: 1 },
    ]);
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        failedPendingPrecheck.runner,
        () => undefined,
        async () => pendingPin,
      ),
    ).rejects.toThrow("staging direct-host check failed before HTTP deploy");
    expect(failedPendingPrecheck.commands.some((command) => command.includes("deploy"))).toBe(
      false,
    );

    const failedPendingDirect = queueRunner([
      ...sourceChecks(httpInput.configPath),
      { exitCode: 0, stdout: "/workspace/api-next/.git" },
      { exitCode: 0, stdout: manifest },
      { exitCode: 0, stdout: `${target}\n` },
      { exitCode: 0, stdout: "{}" },
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: "deployed" },
      { exitCode: 0, stdout: after },
      { exitCode: 1, stdout: "direct-out\n", stderr: "TypeError: fetch failed\n" },
    ]);
    const failureDiagnostics: string[] = [];
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        failedPendingDirect.runner,
        (text) => failureDiagnostics.push(text),
        async () => pendingPin,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).rejects.toThrow("staging direct-host release check failed after HTTP deploy");
    expect(failureDiagnostics).toContain("direct-out\n");
    expect(failureDiagnostics).toContain("TypeError: fetch failed\n");

    for (const solidIdentity of [
      { exitCode: 0, stdout: `${pin.solid_ingress_composition_reference}\n` },
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: `${target}\n` },
    ]) {
      const wrongSolid = queueRunner([
        ...sourceChecks(httpInput.configPath),
        { exitCode: 0, stdout: "/workspace/api-next/.git" },
        { exitCode: 0, stdout: manifest },
        solidIdentity,
      ]);
      await expect(
        deployWorkerWithProvenance(
          "/repo",
          httpInput,
          wrongSolid.runner,
          () => undefined,
          async () => pendingPin,
        ),
      ).rejects.toThrow("staging Solid ingress preflight failed before HTTP deploy");
      expect(wrongSolid.commands.some((command) => command.includes("deploy"))).toBe(false);
    }

    const relativeGit = queueRunner([
      ...sourceChecks(httpInput.configPath),
      { exitCode: 0, stdout: ".git" },
    ]);
    await expect(
      deployWorkerWithProvenance("/repo", httpInput, relativeGit.runner),
    ).rejects.toThrow("Git common directory must be absolute");
    expect(relativeGit.commands.some((command) => command[0] === "timeout")).toBe(false);
  });
});

test("external deployment source requires accepted clean tooling in the same repository", async () => {
  const { runner, commands } = queueRunner([
    { exitCode: 0, stdout: sourceSha },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0, stdout: input.configPath },
    { exitCode: 0, stdout: "/repo/.git" },
    { exitCode: 0, stdout: "/repo/.git" },
  ]);
  await expect(
    resolveDeploymentRepository({ ...input, repositoryRoot: "/target" }, runner, "/tooling"),
  ).resolves.toBe("/target");
  expect(commands[0]).toContain("origin/main^{commit}");
  const wrong = queueRunner([
    { exitCode: 0, stdout: sourceSha },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0, stdout: input.configPath },
    { exitCode: 0, stdout: "/repo/.git" },
    { exitCode: 0, stdout: "/other/.git" },
  ]);
  await expect(
    resolveDeploymentRepository({ ...input, repositoryRoot: "/target" }, wrong.runner, "/tooling"),
  ).rejects.toThrow("share");
  await expect(
    resolveDeploymentRepository(
      { ...input, environment: "prod", repositoryRoot: "/target" },
      runner,
      "/tooling",
    ),
  ).rejects.toThrow("staging");
  expect(() =>
    parseWorkerDeploymentArgs([
      "--config",
      input.configPath,
      "--env",
      "staging",
      "--repository-root",
      "relative",
    ]),
  ).toThrow("absolute");
});
