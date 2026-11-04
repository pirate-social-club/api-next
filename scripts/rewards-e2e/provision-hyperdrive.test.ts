import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { provisionIsolatedHyperdrive } from "./provision-hyperdrive.ts";

const identity = {
  branchId: "isolatedbranch",
  branchName: "rewards-runner-20261004",
  hostname: "fixture.pg.psdb.cloud",
  usernameSha256: createHash("sha256").update("isolated_runtime").digest("hex"),
};
const input = {
  identity,
  connectionString: "postgres://isolated_runtime:fixture@fixture.pg.psdb.cloud/postgres",
};
const drive = {
  id: "123456789012345678901234567890ab",
  name: "rewards-runner-isolatedbranch",
  origin: { host: identity.hostname, user: "isolated_runtime", database: "postgres" },
  caching: { disabled: true },
};

test("Hyperdrive adopts one matching isolated target without mutation", async () => {
  const calls: string[] = [];
  const result = await provisionIsolatedHyperdrive(
    input,
    async (path: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      calls.push(path);
      return path === "/hyperdrive/configs" ? [drive] : drive;
    },
  );
  expect(result.id).toBe(drive.id);
  expect(calls.length).toBe(2);
});

test("Hyperdrive refuses duplicate identities or altered provider readback", async () => {
  await expect(provisionIsolatedHyperdrive(input, async () => [drive, drive])).rejects.toThrow(
    "ambiguous",
  );
  for (const altered of [
    { ...drive, caching: { disabled: false } },
    { ...drive, origin: { ...drive.origin, user: "shared_runtime" } },
    { ...drive, origin: { ...drive.origin, host: "shared.pg.psdb.cloud" } },
  ]) {
    await expect(
      provisionIsolatedHyperdrive(input, async (path: string) =>
        path === "/hyperdrive/configs" ? [drive] : altered,
      ),
    ).rejects.toThrow("differs");
  }
});

test("Hyperdrive creates once then verifies independent provider identity", async () => {
  let writes = 0;
  const result = await provisionIsolatedHyperdrive(
    input,
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes++;
        const body = JSON.parse(String(init.body));
        expect(body.origin.user).toBe("isolated_runtime");
        expect(body.caching.disabled).toBe(true);
        return drive;
      }
      return path === "/hyperdrive/configs" ? [] : drive;
    },
  );
  expect(result.id).toBe(drive.id);
  expect(writes).toBe(1);
});
