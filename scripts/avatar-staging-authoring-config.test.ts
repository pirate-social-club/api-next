import { expect, test } from "bun:test";
import * as BunRuntime from "bun";

test("avatar authoring is enabled for staging creation and disabled elsewhere", async () => {
  const path = new URL("../apps/http-worker/wrangler.jsonc", import.meta.url);
  const config = BunRuntime.JSONC.parse(await BunRuntime.file(path).text()) as {
    vars: Record<string, string>;
    env: Record<string, { vars: Record<string, string> }>;
  };
  expect(config.env.staging?.vars.AVATAR_AUTHORING_ENABLED).toBe("true");
  expect(config.env.production?.vars.AVATAR_AUTHORING_ENABLED).toBe("false");
  expect(config.vars.AVATAR_AUTHORING_ENABLED).toBe("false");
});
