import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CommandRunner,
  deployWorkerWithProvenance,
  parseWorkerDeploymentArgs,
  resolveDeploymentRepository,
  verifyDeploymentSource,
  type WorkerDeploymentInput,
} from "./deploy-worker-with-provenance.ts";
import { POSTING_FROZEN_RUNTIME as snapshot } from "./posting-frozen-source.ts";
import type { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import type { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";
import type { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";

const root = "/snapshot";
const remoteUser = "operator_origin_marker";
const remoteCredential = "synthetic_credential_marker";
const tooling = "a".repeat(40);
const main = "b".repeat(40);
const config = "apps/http-worker/wrangler.jsonc";
const input: WorkerDeploymentInput = {
  configPath: config,
  environment: "staging",
  sourceRef: snapshot.source,
  acceptedMainRef: "origin/main",
  repositoryRoot: root,
  toolingSourceRef: tooling,
  postingFrozenRuntime: true,
};
const manifest = JSON.stringify({
  schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
  mode: "staging-public-tls",
  public_tls_listener: "94.103.168.209:443",
  solid_origin: "https://hns-community-ingress-staging.pirate.sc",
  solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"d".repeat(64)}`,
});
const pin = {
  schema: "pirate-hns-staging-gateway-deploy-pin-v1",
  gateway_reference: `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest).digest("hex")}`,
  solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"d".repeat(64)}`,
};
type Fault =
  | "source"
  | "tree"
  | "origin"
  | "origin-credentials"
  | "head"
  | "ref"
  | "ambiguous-ref"
  | "stale-main"
  | "ancestor"
  | "baseline-ancestor"
  | "donor-ancestor"
  | "config-untracked"
  | "tooling-dirty"
  | "paths"
  | "blob"
  | "publication-race"
  | "dirty"
  | "untracked"
  | "tooling"
  | "common-git";
function fixture(fault?: Fault, changeBeforeUpload = false) {
  const commands: string[][] = [];
  let sourceReads = 0,
    publications = 0,
    uploaded = false;
  const runner: CommandRunner = async (command, cwd) => {
    commands.push([...command]);
    const ok = (stdout = "", exitCode = 0) => ({ exitCode, stdout, stderr: "" });
    if (command[0] === "git") {
      const args = command.slice(1);
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (cwd === root) {
          sourceReads++;
          return ok(
            fault === "source" || (changeBeforeUpload && sourceReads > 1)
              ? "e".repeat(40)
              : snapshot.source,
          );
        }
        return ok(tooling);
      }
      if (args[0] === "merge-base") {
        if (
          args[2] === snapshot.source ||
          fault === "ancestor" ||
          (fault === "baseline-ancestor" && args[2] === snapshot.baseline) ||
          (fault === "donor-ancestor" && args[2] === snapshot.donor) ||
          (fault === "tooling" && args[2] === tooling)
        )
          return ok("", 1);
        return ok();
      }
      if (args[0] === "diff" && args[1] === "--quiet")
        return ok(
          "",
          (fault === "dirty" && cwd === root) || (fault === "tooling-dirty" && cwd !== root)
            ? 1
            : 0,
        );
      if (
        args[0] === "ls-files" &&
        args.includes("--error-unmatch") &&
        cwd === root &&
        fault === "config-untracked"
      )
        return ok("", 1);
      if (args[0] === "ls-files")
        return ok(
          args.includes("--others")
            ? fault === "untracked" && cwd === root
              ? "scratch.ts"
              : ""
            : config,
        );
      if (args[0] === "remote" && fault === "origin-credentials")
        return ok(`https://${remoteUser}:${remoteCredential}@untrusted.invalid/repository`);
      if (args[0] === "remote")
        return ok(
          fault === "origin"
            ? "https://untrusted.example/repository"
            : "https://github.com/pirate-social-club/api-next.git",
        );
      if (args[0] === "ls-remote") {
        publications++;
        const ref =
          fault === "ref" || (fault === "publication-race" && publications > 1)
            ? "f".repeat(40)
            : snapshot.source;
        const rows = `${main}\trefs/heads/main\n${ref}\t${snapshot.ref}`;
        return ok(fault === "ambiguous-ref" ? `${rows}\n${ref}\t${snapshot.ref}` : rows);
      }
      if (args[0] === "rev-parse") {
        if (args.includes("--git-common-dir"))
          return ok(
            fault === "common-git" && cwd === root ? "/other/.git" : "/workspace/api-next/.git",
          );
        if (args[1] === "HEAD") return ok(fault === "head" ? "f".repeat(40) : snapshot.source);
        if (args[1] === "origin/main") return ok(fault === "stale-main" ? "f".repeat(40) : main);
        if (args[1]?.endsWith("^{tree}"))
          return ok(fault === "tree" ? "f".repeat(40) : snapshot.tree);
        if (args.length === 3)
          return ok(`${"c".repeat(40)}\n${(fault === "blob" ? "d" : "c").repeat(40)}`);
      }
      if (args[0] === "diff" && args.includes("--name-only"))
        return ok([...snapshot.paths, ...(fault === "paths" ? ["other.ts"] : [])].join("\n"));
      throw Error(`Unexpected Git proof command: ${command.join(" ")}`);
    }
    if (command[0] === "timeout") return ok(manifest);
    if (command[0] === "node") return ok("gateway preflight passed");
    if (command.includes("deploy")) {
      uploaded = true;
      return ok("uploaded");
    }
    if (command.includes("versions") && command.includes("list"))
      return ok(
        JSON.stringify([
          { id: "old", annotations: {} },
          ...(uploaded
            ? [{ id: "new", annotations: { "workers/message": `git:${snapshot.source}` } }]
            : []),
        ]),
      );
    if (command.includes("check:staging:release")) return ok("direct and HNS checked");
    throw Error(`Unexpected non-Git command: ${command.join(" ")}`);
  };
  return { runner, commands, sourceReads: () => sourceReads };
}
const rewards: typeof withRewardsBindingDeployment = async (_root, _config, _env, operation) =>
  operation();
const telegram: typeof withTelegramActivationDeployment = async (_root, _config, _env, operation) =>
  operation();
const privileges: typeof withServingFunctionPrivilegesDeployment = async (
  _root,
  _config,
  operation,
) => operation();
const deploy = (runner: CommandRunner, value = input) =>
  deployWorkerWithProvenance(
    root,
    value,
    runner,
    () => {},
    async () => pin,
    rewards,
    async () => null,
    telegram,
    privileges,
    async () => null,
  );

describe("fixed posting staging source", () => {
  test("accepts only the complete fixed proof with separate accepted tooling", async () => {
    const f = fixture();
    await expect(verifyDeploymentSource(root, input, f.runner)).resolves.toEqual({
      sourceSha: snapshot.source,
      configPath: config,
    });
    expect(f.commands.some((c) => c.includes(`${tooling}^{commit}`))).toBe(true);
    expect(f.commands.filter((c) => c[1] === "ls-remote")).toHaveLength(2);
  });
  for (const fault of [
    "source",
    "tree",
    "origin",
    "head",
    "ref",
    "ambiguous-ref",
    "stale-main",
    "ancestor",
    "baseline-ancestor",
    "donor-ancestor",
    "config-untracked",
    "tooling-dirty",
    "paths",
    "blob",
    "publication-race",
    "dirty",
    "untracked",
    "tooling",
    "common-git",
  ] as const) {
    test(`refuses ${fault} before any provider action`, async () => {
      const f = fixture(fault);
      await expect(deploy(f.runner)).rejects.toThrow();
      expect(f.commands.every((c) => c[0] === "git")).toBe(true);
    });
  }
  test("origin refusal never echoes a username or credential", async () => {
    const f = fixture("origin-credentials");
    const error = await deploy(f.runner).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw Error("Expected a closed origin refusal");
    expect(error.message).toBe("posting origin differs");
    expect(error.message).not.toContain(remoteUser);
    expect(error.message).not.toContain(remoteCredential);
    expect(f.commands.every((c) => c[0] === "git")).toBe(true);
  });
  test("normal mode still refuses the same unpublished-main ancestry", async () => {
    const { postingFrozenRuntime: _fixed, ...normal } = input;
    const f = fixture();
    await expect(verifyDeploymentSource(root, normal, f.runner)).rejects.toThrow("not reachable");
    expect(f.commands.some((c) => c[1] === "ls-remote")).toBe(false);
  });
  for (const value of [
    { ...input, environment: "production" },
    { ...input, configPath: "apps/jobs-worker/wrangler.jsonc" },
    { ...input, acceptedMainRef: snapshot.ref },
  ]) {
    test(`refuses incompatible target ${value.environment}/${value.configPath}/${value.acceptedMainRef}`, async () => {
      const f = fixture();
      await expect(deploy(f.runner, value)).rejects.toThrow();
      expect(f.commands.every((c) => c[0] === "git")).toBe(true);
    });
  }
  test("CLI opt-in cannot select jobs, production, or same-root tooling", async () => {
    const args = [
      "--config",
      config,
      "--env",
      "staging",
      "--repository-root",
      root,
      "--posting-frozen-runtime",
    ];
    expect(parseWorkerDeploymentArgs(args).postingFrozenRuntime).toBe(true);
    expect(() =>
      parseWorkerDeploymentArgs(args.filter((x) => x !== "--repository-root" && x !== root)),
    ).toThrow("separate");
    expect(() =>
      parseWorkerDeploymentArgs(args.map((x) => (x === "staging" ? "production" : x))),
    ).toThrow("staging HTTP");
    expect(() =>
      parseWorkerDeploymentArgs(
        args.map((x) => (x === config ? "apps/jobs-worker/wrangler.jsonc" : x)),
      ),
    ).toThrow("staging HTTP");
    expect(() => parseWorkerDeploymentArgs([...args, "--posting-frozen-runtime"])).toThrow(
      "duplicate",
    );
    await expect(resolveDeploymentRepository(input, fixture().runner, root)).rejects.toThrow(
      "separate",
    );
  });
  test("repeats the fixed proof at upload and preserves normal runtime gates", async () => {
    const f = fixture();
    await expect(deploy(f.runner)).resolves.toMatchObject({
      source_sha: snapshot.source,
      worker_version_id: "new",
    });
    expect(f.sourceReads()).toBe(2);
    expect(f.commands.filter((c) => c[1] === "ls-remote")).toHaveLength(4);
    expect(f.commands.filter((c) => c.includes("deploy"))).toHaveLength(1);
    expect(f.commands.some((c) => c.includes("check:staging:release"))).toBe(true);
  });
  test("source changing after admission cannot reach upload", async () => {
    const f = fixture(undefined, true);
    await expect(deploy(f.runner)).rejects.toThrow("source differs");
    expect(f.sourceReads()).toBe(2);
    expect(f.commands.some((c) => c.includes("deploy"))).toBe(false);
  });
});
