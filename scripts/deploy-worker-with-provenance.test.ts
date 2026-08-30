import { describe, expect, test } from "bun:test";

import {
  type CommandRunner,
  deployWorkerWithProvenance,
  findDeployedVersion,
  parseWorkerDeploymentArgs,
  parseWorkerVersions,
  verifyDeploymentSource,
} from "./deploy-worker-with-provenance";

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
      deployWorkerWithProvenance("/repo", input, runner, (text) => diagnostics.push(text)),
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
});
