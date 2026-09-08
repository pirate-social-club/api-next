import { expect, test } from "bun:test";
import { makeTelegramCredentialVault } from "./telegram-credential-vault.ts";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/=+$/u, "");

test("credential envelopes bind community and provider and randomize every write", async () => {
  const vault = await makeTelegramCredentialVault({ activeVersion: "v1", keys: { v1: key } });
  const first = await vault.seal("fixture-secret", "community:openrouter");
  const second = await vault.seal("fixture-secret", "community:openrouter");
  expect(first).not.toBe(second);
  expect(first).not.toContain("fixture-secret");
  expect(await vault.open(first, "community:openrouter")).toBe("fixture-secret");
  await expect(vault.open(first, "other:openrouter")).rejects.toThrow(
    "Credential envelope could not be opened",
  );
  await expect(vault.open(first, "community:elevenlabs")).rejects.toThrow(
    "Credential envelope could not be opened",
  );
});

test("rotation reads retained versions and rejects missing or damaged keys", async () => {
  const old = await makeTelegramCredentialVault({ activeVersion: "v1", keys: { v1: key } });
  const sealed = await old.seal("fixture-secret", "community:telegram:epoch");
  const rotated = await makeTelegramCredentialVault({
    activeVersion: "v2",
    keys: { v1: key, v2: key },
  });
  expect(await rotated.open(sealed, "community:telegram:epoch")).toBe("fixture-secret");
  expect(await rotated.seal("fixture-secret", "community:telegram:epoch")).toStartWith("v2.");
  const retired = await makeTelegramCredentialVault({ activeVersion: "v2", keys: { v2: key } });
  await expect(retired.open(sealed, "community:telegram:epoch")).rejects.toThrow();
  await expect(rotated.open(`${sealed}.extra`, "community:telegram:epoch")).rejects.toThrow();
  await expect(
    makeTelegramCredentialVault({ activeVersion: "v1", keys: { v1: "AAAA" } }),
  ).rejects.toThrow();
});
