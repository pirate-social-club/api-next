import { expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { telegramConfigurationFixture } from "../packages/testing/src/telegram-configuration-fixture.ts";
import { telegramActivationBinding } from "./telegram-activation-preflight.ts";

for (const worker of ["http", "jobs"] as const) {
  test(`${worker} compact activation fits the text-binding limit and preserves its queue`, async () => {
    const config = BunRuntime.JSONC.parse(
      await BunRuntime.file(`apps/${worker}-worker/wrangler.jsonc`).text(),
    ) as {
      vars: Record<string, string>;
      env: Record<
        string,
        {
          vars: Record<string, string>;
          secrets: { required: string[] };
          queues: { producers: { binding: string }[] };
        }
      >;
    };
    for (const environment of ["staging", "production"]) {
      const env = config.env[environment];
      expect(env).toBeDefined();
      if (!env) throw Error("fixture environment missing");
      const intent = JSON.parse(env.vars.TELEGRAM_CONFIG_JSON ?? "null");
      expect(intent).toEqual({
        version: 1,
        enabled: false,
        linking_enabled: false,
        practice_enabled: false,
      });
      expect(env.queues.producers.some((queue) => queue.binding === "TELEGRAM_QUEUE")).toBe(true);
      expect(Object.keys(env.vars).filter((name) => name.startsWith("TELEGRAM_"))).toEqual([
        "TELEGRAM_CONFIG_JSON",
      ]);
      expect(env.vars.TELEGRAM_SECRETS_JSON).toBeUndefined();
    }
    const staging = config.env.staging;
    if (!staging) throw Error("fixture staging missing");
    staging.vars.TELEGRAM_CONFIG_JSON = JSON.stringify({
      ...telegramConfigurationFixture,
      linking_enabled: worker === "http",
      practice_enabled: true,
      practice_community_id: "community",
      practice_post_ids: ["song"],
    });
    const total =
      Object.keys(staging.vars).length +
      new Set([...staging.secrets.required, "TELEGRAM_SECRETS_JSON"]).size;
    expect(total).toBeLessThanOrEqual(128);
    expect(total).toBe(worker === "http" ? 125 : 47);
    expect(telegramActivationBinding(JSON.stringify(config), "staging", worker === "http")).toBe(
      true,
    );
  });
}
