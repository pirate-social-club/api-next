import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { isRemediatedForgeAdvisory, verifyNodeForgeRemediation } from "./node-forge-remediation.ts";

test("both installed Forge copies pass exact security bytes and all real regressions", async () => {
  await expect(verifyNodeForgeRemediation()).resolves.toBeUndefined();
});

test("remediation recognizes only the exact fixed Forge advisory set", () => {
  expect(isRemediatedForgeAdvisory("node-forge", "GHSA-86w9-cpqp-85rv")).toBe(true);
  expect(isRemediatedForgeAdvisory("node-forge", "GHSA-8hrf-8g6f-7xwp")).toBe(true);
  expect(isRemediatedForgeAdvisory("node-forge", "GHSA-unknown-new")).toBe(false);
  expect(isRemediatedForgeAdvisory("another-package", "GHSA-8hrf-8g6f-7xwp")).toBe(false);
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

for (const file of [
  "cipherModes.js",
  "http.js",
  "pbe.js",
  "pem.js",
  "pkcs12.js",
  "tls.js",
  "x509.js",
]) {
  for (const occurrence of [1, 2]) {
    test(`modified ${file} in installed copy ${occurrence} cannot clear any security advisory`, async () => {
      let seen = 0;
      await expect(
        verifyNodeForgeRemediation(async (path) => {
          if (path.endsWith(`/lib/${file}`) && ++seen === occurrence) return "unpatched";
          return readFile(path, "utf8");
        }),
      ).rejects.toThrow("installed security remediation mismatch");
      expect(seen).toBe(occurrence);
    });
  }
}
