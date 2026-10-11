import { describe, expect, test } from "bun:test";
import { type CommandRunner, deployWorkerWithProvenance } from "./deploy-worker-with-provenance.ts";
import type { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import {
  type PrepareStagingBindingGuard,
  prepareStagingBindingGuard,
} from "./staging-serving-bindings-preflight.ts";
import type { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import type { CandidateBindings } from "./worker-binding-drift.ts";

const sourceSha = "a".repeat(40);
const configPath = "apps/jobs-worker/wrangler.jsonc";
const input = {
  configPath,
  environment: "staging",
  sourceRef: "HEAD",
  acceptedMainRef: "origin/main",
};
const runtime = {
  compatibility_date: "2026-08-01",
  compatibility_flags: ["nodejs_compat"],
  migration_tag: "v1",
  usage_model: "standard",
};
const telegramConfig = JSON.stringify({
  version: 1,
  enabled: false,
  linking_enabled: false,
  practice_enabled: false,
});
const telegramBinding = { name: "TELEGRAM_CONFIG_JSON", type: "plain_text", text: telegramConfig };
const binding = (text: string) => ({
  name: "SONG_VIDEO_PCM_ADMISSION_ENABLED",
  type: "plain_text",
  text,
});
const candidate = (text: string): CandidateBindings => ({
  worker_name: "jobs-staging",
  bindings: [binding(text), telegramBinding],
  runtime,
  required_secrets: [],
});
const allowRewards: typeof withRewardsBindingDeployment = async (
  _root,
  _config,
  _environment,
  operation,
) => operation();

const allowTelegram: typeof withTelegramActivationDeployment = async (
  _root,
  _config,
  _environment,
  operation,
) => operation();
function fixture(
  options: {
    text?: string;
    servingRace?: boolean;
    telegram?: string;
    telegramGuard?: typeof withTelegramActivationDeployment;
    incomplete?: boolean;
    sourceRace?: boolean;
    controlConnectionLost?: boolean;
    sourceRaceDuringRead?: boolean;
    servingRaceDuringRead?: boolean;
  } = {},
) {
  const commands: string[][] = [];
  const diagnostics: string[] = [];
  let allocations = 0;
  let sourceReads = 0;
  let versionViews = 0;
  let currentSource = sourceSha;
  let currentServing = "serving-version";
  let uploaded = false;
  let candidateReads = 0;
  const cancellation = new AbortController();
  const runner: CommandRunner = async (command) => {
    commands.push([...command]);
    let stdout = "";
    if (command[0] === "git") {
      if (command[1] === "rev-parse")
        stdout = ++sourceReads > 1 && options.sourceRace ? "b".repeat(40) : currentSource;
      if (command[1] === "ls-files" && command.includes("--error-unmatch")) stdout = configPath;
    } else if (command[0] === "bun" && command[1] === "scripts/telegram-activation-preflight.ts") {
      stdout = "Telegram privilege admission ready";
    } else if (command.includes("deployments")) {
      const version_id =
        ++allocations > 2 && options.servingRace ? "other-version" : currentServing;
      stdout = JSON.stringify([
        { created_on: "2026-10-01T07:12:17Z", versions: [{ version_id, percentage: 100 }] },
      ]);
    } else if (command.includes("view")) {
      if (++versionViews === 2) {
        if (options.sourceRaceDuringRead) currentSource = "b".repeat(40);
        if (options.servingRaceDuringRead) currentServing = "changed-serving-version";
      }
      stdout = JSON.stringify({
        id: command[4],
        resources: {
          ...(options.incomplete
            ? {}
            : {
                bindings: [
                  binding("true"),
                  { ...telegramBinding, text: options.telegram ?? telegramConfig },
                ],
              }),
          script_runtime: runtime,
        },
      });
    } else if (command.includes("list")) {
      stdout = JSON.stringify([
        { id: "serving-version", annotations: {} },
        ...(uploaded
          ? [{ id: "new-version", annotations: { "workers/message": `git:${sourceSha}` } }]
          : []),
      ]);
    } else if (command.includes("deploy")) {
      uploaded = true;
    } else throw Error("unexpected fixture command");
    return { exitCode: 0, stdout, stderr: "" };
  };
  const guard: PrepareStagingBindingGuard = (...args) =>
    prepareStagingBindingGuard(...args, async () => {
      if (++candidateReads > 1 && options.controlConnectionLost) cancellation.abort();
      return candidate(options.text ?? "true");
    });
  const execute = () =>
    deployWorkerWithProvenance(
      "/repo",
      input,
      runner,
      (text) => diagnostics.push(text),
      undefined,
      options.controlConnectionLost
        ? async (_root, _config, _environment, operation) => operation(cancellation.signal)
        : allowRewards,
      guard,
      options.telegramGuard ?? allowTelegram,
    );
  return { execute, commands, diagnostics };
}

describe("normal staging deployment binding preflight", () => {
  test("refuses the captured PCM regression before upload or deploy", async () => {
    const run = fixture({ text: "false" });
    await expect(run.execute()).rejects.toThrow("SONG_VIDEO_PCM_ADMISSION_ENABLED");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
    const receipt = JSON.parse(run.diagnostics[0] ?? "{}").staging_binding_preflight;
    expect(receipt.source_sha).toBe(sourceSha);
    expect(receipt.changes).toHaveLength(1);
    expect(run.diagnostics.join("")).not.toContain('"text"');
  });
  test("unchanged configuration rechecks exact source and baseline before deploy", async () => {
    const run = fixture();
    await expect(run.execute()).resolves.toMatchObject({
      worker_version_id: "new-version",
      staging_binding_preflight: { changes: [] },
    });
    const upload = run.commands.findIndex((command) => command.includes("deploy"));
    expect(run.commands[upload - 1]).toContain("ls-files");
    const lastView = run.commands.reduce(
      (found, command, index) => (command.includes("view") ? index : found),
      -1,
    );
    const finalSource = run.commands.reduce(
      (found, command, index) => (command.includes("rev-parse") ? index : found),
      -1,
    );
    expect(finalSource).toBeGreaterThan(lastView);
    expect(run.commands.filter((command) => command.includes("rev-parse"))).toHaveLength(2);
    expect(run.commands.filter((command) => command.includes("deployments"))).toHaveLength(4);
  });
  test("a serving-version race refuses even an otherwise unchanged candidate", async () => {
    const run = fixture({ servingRace: true });
    await expect(run.execute()).rejects.toThrow("changed before upload");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
  test("serving allocation movement during the final version read refuses upload", async () => {
    const run = fixture({ servingRaceDuringRead: true });
    await expect(run.execute()).rejects.toThrow("allocation changed during inventory read");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
  test("source movement during the final version read refuses upload", async () => {
    const run = fixture({ sourceRaceDuringRead: true });
    await expect(run.execute()).rejects.toThrow("deployment source changed before upload");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
  test("missing native inventory refuses before mutation", async () => {
    const run = fixture({ incomplete: true });
    await expect(run.execute()).rejects.toThrow("missing binding inventory");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
  test("control connection loss during the fresh read refuses before upload", async () => {
    const run = fixture({ controlConnectionLost: true });
    await expect(run.execute()).rejects.toThrow("control connection lost before deploy");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
  test("source movement after initial review refuses before upload", async () => {
    const run = fixture({ sourceRace: true });
    await expect(run.execute()).rejects.toThrow("deployment source changed before upload");
    expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
  });
});

test("same serving Telegram configuration reaches permission check and actual upload", async () => {
  const enabled = JSON.stringify({
    version: 1,
    enabled: true,
    linking_enabled: false,
    practice_enabled: false,
    public_origin: "https://web.example",
    webhook_origin: "https://api.example",
    credential_active_version: "v1",
  });
  let checked: string | undefined;
  const telegramGuard: typeof withTelegramActivationDeployment = async (
    _root,
    _config,
    _env,
    operation,
    effective,
    preflight,
  ) => {
    checked = effective;
    await preflight?.("managed-runtime-connection");
    return operation();
  };
  const run = fixture({ telegram: enabled, telegramGuard });
  await run.execute();
  expect(checked).toBe(enabled);
  expect(
    run.commands.some(
      (command) => command.join(" ") === "bun scripts/telegram-activation-preflight.ts",
    ),
  ).toBe(true);
  const upload = run.commands.find((command) => command.includes("deploy"));
  expect(upload).toContain(`TELEGRAM_CONFIG_JSON:${enabled}`);
  expect(upload).toContain("--var");
});
test("effective Telegram privilege refusal prevents upload", async () => {
  const run = fixture({
    telegramGuard: async (_root, _config, _env, _operation, effective) => {
      expect(effective).toBe(telegramConfig);
      throw Error("privilege refused");
    },
  });
  await expect(run.execute()).rejects.toThrow("privilege refused");
  expect(run.commands.some((command) => command.includes("deploy"))).toBe(false);
});
