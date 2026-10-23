import { describe, expect, test } from "bun:test";
import { INFISICAL_POLICIES } from "./infisical-secret-drift-audit.ts";

const secretName = "DANCE_MODERATED_REPLAY_KEYS";
type Environment = {
  vars: Record<string, string>;
  triggers?: { crons: string[] };
  secrets?: { required: string[] };
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
};

describe("deployed Dance replay custody", () => {
  test("admits an optional key only in each deployed runtime store", () => {
    for (const policy of INFISICAL_POLICIES) {
      const admitted =
        (policy.environment === "staging" || policy.environment === "prod") &&
        policy.path === "/services/api-next";
      expect(policy.allowedNames.includes(secretName)).toBe(admitted);
      expect(policy.requiredNames.includes(secretName)).toBe(false);
    }
  });

  test("requires isolated key and ingress bindings for each deployed processor", async () => {
    const config = Bun.JSONC.parse(
      await Bun.file(
        new URL("../apps/media-processor-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as Environment & { env: Record<string, Environment> };
    expect(config.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("false");
    expect(config.env.staging?.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("true");
    expect(config.env.production?.vars.DANCE_MODERATED_PROCESSING_ENABLED).toBe("true");
    expect(config.env.staging?.triggers?.crons).toEqual(["* * * * *"]);
    expect(config.triggers?.crons ?? []).toEqual([]);
    expect(config.env.production?.triggers?.crons).toEqual(["* * * * *"]);
    expect(config.env.staging?.secrets?.required).toContain(secretName);
    expect(config.env.production?.secrets?.required).toContain(secretName);
    expect(config.secrets?.required ?? []).not.toContain(secretName);
    for (const env of [config, ...Object.values(config.env)]) {
      expect(Object.hasOwn(env.vars, secretName)).toBe(false);
    }
    for (const environment of ["staging", "production"]) {
      const ingress = config.env[environment]?.r2_buckets?.filter(
        (bucket) => bucket.binding === "MEDIA_INGRESS",
      );
      expect(ingress).toEqual([
        { binding: "MEDIA_INGRESS", bucket_name: `pirate-media-ingress-${environment}` },
      ]);
      for (const component of ["http-worker", "jobs-worker"]) {
        const peer = Bun.JSONC.parse(
          await Bun.file(new URL(`../apps/${component}/wrangler.jsonc`, import.meta.url)).text(),
        ) as { env: Record<string, Environment> };
        expect(
          peer.env[environment]?.r2_buckets?.filter((bucket) => bucket.binding === "MEDIA_INGRESS"),
        ).toEqual(ingress);
      }
    }
  });
});
