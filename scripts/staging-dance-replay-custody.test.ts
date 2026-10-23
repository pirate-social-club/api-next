import { describe, expect, test } from "bun:test";
import { INFISICAL_POLICIES } from "./infisical-secret-drift-audit.ts";

const secretName = "DANCE_MODERATED_REPLAY_KEYS";
type Environment = {
  vars: Record<string, string>;
  triggers?: { crons: string[] };
  secrets?: { required: string[] };
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
};

describe("staging Dance replay custody", () => {
  test("admits only an optional staging runtime key", () => {
    for (const policy of INFISICAL_POLICIES) {
      const admitted = policy.environment === "staging" && policy.path === "/services/api-next";
      expect(policy.allowedNames.includes(secretName)).toBe(admitted);
      expect(policy.requiredNames.includes(secretName)).toBe(false);
    }
  });

  test("prepares processing and its schedule only for the reviewed staging release", async () => {
    const config = Bun.JSONC.parse(
      await Bun.file(
        new URL("../apps/media-processor-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as Environment & { env: Record<string, Environment> };
    expect(config.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("false");
    expect(config.env.staging?.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("true");
    expect(config.env.production?.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("false");
    expect(config.env.staging?.triggers?.crons).toEqual(["* * * * *"]);
    expect(config.triggers?.crons ?? []).toEqual([]);
    expect(config.env.production?.triggers?.crons ?? []).toEqual([]);
    expect(config.env.staging?.secrets?.required).toContain(secretName);
    expect(config.env.production?.secrets?.required ?? []).not.toContain(secretName);
    expect(config.secrets?.required ?? []).not.toContain(secretName);
    for (const env of [config, ...Object.values(config.env)]) {
      expect(Object.hasOwn(env.vars, secretName)).toBe(false);
    }
    const ingress = config.env.staging?.r2_buckets?.filter(
      (bucket) => bucket.binding === "MEDIA_INGRESS",
    );
    expect(ingress).toEqual([
      { binding: "MEDIA_INGRESS", bucket_name: "pirate-media-ingress-staging" },
    ]);
    for (const component of ["http-worker", "jobs-worker"]) {
      const peer = Bun.JSONC.parse(
        await Bun.file(new URL(`../apps/${component}/wrangler.jsonc`, import.meta.url)).text(),
      ) as { env: Record<string, Environment> };
      expect(
        peer.env.staging?.r2_buckets?.filter((bucket) => bucket.binding === "MEDIA_INGRESS"),
      ).toEqual(ingress);
    }
  });
});
