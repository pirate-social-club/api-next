import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type WorkerEnvironment = Readonly<{ vars?: Readonly<Record<string, string>> }>;

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as Readonly<{ env: Readonly<Record<string, WorkerEnvironment>> }>;

// The staging verifier answers hns-txt-import-v1 from its maintained config,
// so a routine deploy keeps the capability. Production enables it only by a
// separate, reviewed change.
test("the staging verifier advertises hns-txt-import-v1 and production does not", () => {
  expect(config.env.staging?.vars?.HNS_PROVIDER_CAPABILITIES).toBe("hns-txt-import-v1");
  expect(config.env.production?.vars?.HNS_PROVIDER_CAPABILITIES).toBeUndefined();
});
