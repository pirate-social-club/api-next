import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { verifyNodeForgeRemediation } from "./node-forge-remediation.ts";

test("both installed forge copies reject extra ASN.1 elements and accept valid RSA signatures", async () => {
  await expect(verifyNodeForgeRemediation()).resolves.toBeUndefined();
});

test("a missing or modified security patch cannot clear the advisory", async () => {
  await expect(
    verifyNodeForgeRemediation(async (path) =>
      path.endsWith(".patch") ? "changed" : readFile(path, "utf8"),
    ),
  ).rejects.toThrow("remediation patch mismatch");
});

test("an unpatched installed package cannot clear the advisory", async () => {
  await expect(
    verifyNodeForgeRemediation(async (path) =>
      path.endsWith("/lib/rsa.js") ? "unpatched" : readFile(path, "utf8"),
    ),
  ).rejects.toThrow("installed RSA remediation mismatch");
});
