import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedSolidConfiguration, prepareSolidArtifact } from "./prepare-solid-artifact.mjs";

const source = {
  account_id: "08a4c22cf52e2ecae883e36f80a33f4a",
  compatibility_date: "2026-08-13",
  compatibility_flags: ["nodejs_compat", "enable_request_signal"],
  env: { staging: { vars: { PRIVY_APP_ID: "cmsw5pis300b80cladbxx7bsr" } } },
  durable_objects: {
    bindings: [{ name: "HNS_COMMUNITY_APP_REPLAY", class_name: "HnsCommunityAppReplayStoreDO" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["HnsCommunityAppReplayStoreDO"] }],
};

test("isolated Solid proxies only the isolated API and disables shared ingress", () => {
  const config = isolatedSolidConfiguration(source);
  expect(config.env["rewards-e2e"].vars.API_NEXT_ORIGIN).toBe(
    "https://api-megapot-e2e-staging.pirate.sc",
  );
  expect(config.routes).toEqual([
    { pattern: "web-megapot-e2e-staging.pirate.sc", custom_domain: true },
  ]);
  expect(config.vars.HNS_COMMUNITY_APP_INGRESS_ENABLED).toBe("false");
  expect(config.vars.HNS_HANDLE_HOST_INGRESS_ENABLED).toBe("false");
});

test("a new Solid Durable Object migration or account requires review", () => {
  expect(() => isolatedSolidConfiguration({ ...source, account_id: "shared" })).toThrow(
    "inventory changed",
  );
  expect(() =>
    isolatedSolidConfiguration({
      ...source,
      migrations: [{ tag: "v2", deleted_classes: ["HnsCommunityAppReplayStoreDO"] }],
    }),
  ).toThrow("inventory changed");
});

test("Solid evidence substitution refuses before reading or copying the artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-solid-evidence-"));
  try {
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, "{}");
    await expect(
      prepareSolidArtifact({ root: directory, solidRoot: directory, manifestPath }),
    ).rejects.toThrow("independent review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
