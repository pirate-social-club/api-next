import { describe, expect, test } from "bun:test";
import { Config } from "effect";
import { AppEnv, HttpWorkerConfig, loadConfig, loadConfigFrom, secret } from "./index.ts";

describe("config system (000 §9)", () => {
  test("fail-at-startup: a missing required variable throws at load", () => {
    delete process.env.API_NEXT_ENV;
    expect(() => loadConfig(AppEnv)).toThrow();
  });

  test("fail-at-startup: an invalid literal value throws at load", () => {
    const env = Config.literals(["development", "staging", "production"], "API_NEXT_ENV_INVALID");
    process.env.API_NEXT_ENV_INVALID = "prod";
    expect(() => loadConfig(env)).toThrow();
    delete process.env.API_NEXT_ENV_INVALID;
  });

  test("a valid environment parses", () => {
    const env = Config.literals(["development", "staging", "production"], "API_NEXT_ENV_VALID");
    process.env.API_NEXT_ENV_VALID = "staging";
    expect(loadConfig(env)).toBe("staging");
    delete process.env.API_NEXT_ENV_VALID;
  });

  test("a defaulted variable falls back rather than failing", () => {
    delete process.env.API_NEXT_PORT;
    const port = Config.port("API_NEXT_PORT").pipe(Config.withDefault(8080));
    expect(loadConfig(port)).toBe(8080);
  });

  test("secrets are redacted: the value never prints", () => {
    process.env.API_NEXT_TEST_SECRET = "hunter2";
    const value = loadConfig(secret("API_NEXT_TEST_SECRET"));
    expect(String(value)).toBe("<redacted>");
    delete process.env.API_NEXT_TEST_SECRET;
  });

  test("HTTP composition fails before route construction when required config is absent", () => {
    expect(() =>
      loadConfigFrom(HttpWorkerConfig, {
        API_NEXT_ENV: "production",
        CORS_ORIGIN: "https://pirate.app",
      }),
    ).toThrow();
  });
});
