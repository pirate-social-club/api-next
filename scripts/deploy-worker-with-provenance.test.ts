import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
} from "./deploy-worker-with-provenance";

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
    expect(() =>
      parseWorkerDeploymentArgs([
        "--config",
        input.configPath,
        "--env",
        "staging",
        "--message",
        "handwritten",
      ]),
    ).toThrow("unknown deployment argument: --message");
    expect(() =>
      parseWorkerDeploymentArgs([
        "--config",
        input.configPath,
        "--env",
        "staging",
        "--accepted-main-ref",
        "topic-branch",
      ]),
    ).toThrow("unknown deployment argument: --accepted-main-ref");
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

  test("gates staging HTTP on the gateway and checks HNS serving after deploy", async () => {
    const manifest = JSON.stringify({
      schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
      mode: "staging-public-tls",
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
      { exitCode: 0, stdout: manifest },
      { exitCode: 0, stdout: "preflight passed" },
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: "deployed" },
      { exitCode: 0, stdout: after },
      { exitCode: 0, stdout: "serving passed" },
    ]);
    await expect(
      deployWorkerWithProvenance(
        "/repo",
        httpInput,
        runner,
        () => undefined,
        async () => pin,
        allowRewardDeployment,
        allowStagingBindings,
        allowTelegram,
      ),
    ).resolves.toMatchObject({ worker_version_id: "version-2" });
    expect(commands[5]?.[0]).toBe("timeout");
    expect(commands[6]).toEqual(["node", "scripts/hns-staging-gateway-preflight.mjs"]);
    expect(commands[10]).toEqual(["bun", "run", "check:staging:hns-route"]);

    const refused = queueRunner([
      { exitCode: 0, stdout: sourceSha },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: httpInput.configPath },
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
