import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityAddresses, authorityImage, requireLocalFixtureExecution } from "./authority.ts";
import { acquireAuthorityFixtureLease } from "./lease.ts";

test("local fixture requires its exact execution flag and rejects remote configuration", () => {
  for (const args of [
    [],
    ["--execute"],
    ["--execute-local", "--production"],
    ["--endpoint=https://example.com"],
  ]) {
    expect(() => requireLocalFixtureExecution(args)).toThrow();
  }
  expect(() => requireLocalFixtureExecution(["--execute-local"])).not.toThrow();
  expect(() => requireLocalFixtureExecution(["--execute-local", "--with-chain"])).not.toThrow();
});

test("authorities are loopback-only and image is digest-pinned", () => {
  expect(authorityAddresses).toEqual(["127.0.0.21", "127.0.0.22"]);
  expect(authorityImage).toMatch(/@sha256:[a-f0-9]{64}$/);
});

test("concurrent fixture cannot acquire the same listeners; release permits a later run", async () => {
  const root = await mkdtemp(join(tmpdir(), "hns-fixture-lease-test-"));
  try {
    const path = join(root, "lease");
    const release = await acquireAuthorityFixtureLease(path);
    await expect(acquireAuthorityFixtureLease(path)).rejects.toThrow();
    await release();
    await (await acquireAuthorityFixtureLease(path))();
  } finally {
    await rm(root, { recursive: true });
  }
});
