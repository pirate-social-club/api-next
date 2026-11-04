import { expect, test } from "bun:test";
import { preserveStagingTelegramConfiguration } from "./staging-telegram-config.ts";
import type { CandidateBindings, ServingVersion } from "./worker-binding-drift.ts";

const disabled = JSON.stringify({
  version: 1,
  enabled: false,
  linking_enabled: false,
  practice_enabled: false,
});
const enabled = JSON.stringify({
  version: 1,
  enabled: true,
  linking_enabled: false,
  practice_enabled: false,
  public_origin: "https://web.example",
  webhook_origin: "https://api.example",
  credential_active_version: "v1",
});
const binding = (text: string) => ({ name: "TELEGRAM_CONFIG_JSON", type: "plain_text", text });
const candidate: CandidateBindings = {
  worker_name: "staging",
  bindings: [binding(disabled), { name: "OTHER", type: "plain_text", text: "keep" }],
  runtime: {},
  required_secrets: ["TELEGRAM_SECRETS_JSON"],
};
const serving = (text: string): ServingVersion => ({
  version_id: "v1",
  percentage: 100,
  bindings: [binding(text)],
  runtime: {},
});
const context = {
  source_sha: "a".repeat(40),
  environment: "staging",
  config_path: "apps/http-worker/wrangler.jsonc",
};

test("enabled serving Telegram overrides all-off source without changing unrelated settings or secrets", () => {
  const result = preserveStagingTelegramConfiguration(context, candidate, [serving(enabled)]);
  expect(result.telegramConfig).toBe(enabled);
  expect(result.candidate.bindings).toEqual([binding(enabled), ...candidate.bindings.slice(1)]);
  expect(result.candidate.required_secrets).toEqual(candidate.required_secrets);
  expect(candidate.bindings[0]).toEqual(binding(disabled));
});
test("all traffic versions must agree on exact public Telegram configuration", () => {
  expect(() =>
    preserveStagingTelegramConfiguration(context, candidate, [serving(enabled), serving(disabled)]),
  ).toThrow("disagree");
  expect(
    preserveStagingTelegramConfiguration(context, candidate, [serving(enabled), serving(enabled)])
      .telegramConfig,
  ).toBe(enabled);
});
test("missing, malformed, duplicate or secret serving configuration refuses", () => {
  for (const bindings of [
    [],
    [binding("{")],
    [binding(enabled), binding(enabled)],
    [{ name: "TELEGRAM_CONFIG_JSON", type: "secret_text" }],
  ]) {
    expect(() =>
      preserveStagingTelegramConfiguration(context, candidate, [{ ...serving(enabled), bindings }]),
    ).toThrow();
  }
  expect(() => preserveStagingTelegramConfiguration(context, candidate, [])).toThrow(
    "serving versions",
  );
  expect(() =>
    preserveStagingTelegramConfiguration(context, { ...candidate, bindings: [] }, [
      serving(enabled),
    ]),
  ).toThrow("candidate");
});
test("jobs linking refuses and production does not inherit staging preservation", () => {
  const linked = JSON.stringify({
    ...JSON.parse(enabled),
    linking_enabled: true,
    login_client_id: "123",
    login_redirect_uri: "https://web.example/callback",
  });
  expect(() =>
    preserveStagingTelegramConfiguration(
      { ...context, config_path: "apps/jobs-worker/wrangler.jsonc" },
      candidate,
      [serving(linked)],
    ),
  ).toThrow("jobs");
  expect(
    preserveStagingTelegramConfiguration({ ...context, environment: "prod" }, candidate, [
      serving(enabled),
    ]),
  ).toEqual({ candidate });
});
