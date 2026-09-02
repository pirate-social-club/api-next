import { describe, expect, test } from "bun:test";
import {
  credentialTombstonePreimage,
  makeCredentialTombstoneDigester,
} from "./credential-tombstone-digest.ts";

const key = (fill: number) => new Uint8Array(32).fill(fill);

describe("credential tombstone digest", () => {
  test("uses the first key for writes and every accepted key for verification", async () => {
    const digester = makeCredentialTombstoneDigester([
      { version: "h2", bytes: key(2) },
      { version: "h1", bytes: key(1) },
    ]);
    const identity = { provider: "privy", application: "app-1", subject: "did:privy:one" };

    const current = await digester.current(identity);
    const candidates = await digester.candidates(identity);

    expect(candidates[0]).toEqual(current);
    expect(candidates.map(({ keyVersion }) => keyVersion)).toEqual(["h2", "h1"]);
    expect(candidates.every(({ digest }) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    expect(candidates[0]?.digest).not.toBe(candidates[1]?.digest);
  });

  test("matches the frozen v1 digest vector", async () => {
    const digester = makeCredentialTombstoneDigester([{ version: "h1", bytes: key(7) }]);

    await expect(
      digester.current({ provider: "privy", application: "app-1", subject: "did:privy:one" }),
    ).resolves.toEqual({
      keyVersion: "h1",
      digest: "867b6818a456d711c34dac7b4c496e1cef2f20e16fc2562a4edfec9d2629896c",
    });
  });

  test("length framing prevents ambiguous tuples from sharing a preimage", () => {
    const first = credentialTombstonePreimage({
      provider: "privy",
      application: "ab",
      subject: "c",
    });
    const second = credentialTombstonePreimage({
      provider: "privy",
      application: "a",
      subject: "bc",
    });

    expect(first).not.toEqual(second);
  });

  test("binds the provider and application namespace", async () => {
    const digester = makeCredentialTombstoneDigester([{ version: "h1", bytes: key(7) }]);
    const base = { provider: "privy", application: "app-1", subject: "did:privy:one" };

    const expected = await digester.current(base);
    const otherApplication = await digester.current({ ...base, application: "app-2" });
    const otherProvider = await digester.current({ ...base, provider: "other" });

    expect(expected.digest).not.toBe(otherApplication.digest);
    expect(expected.digest).not.toBe(otherProvider.digest);
  });

  test("rejects missing, duplicate, short, or noncanonical keys", () => {
    expect(() => makeCredentialTombstoneDigester([])).toThrow("empty");
    expect(() =>
      makeCredentialTombstoneDigester([
        { version: "h1", bytes: key(1) },
        { version: "h1", bytes: key(2) },
      ]),
    ).toThrow("invalid");
    expect(() =>
      makeCredentialTombstoneDigester([{ version: "h1", bytes: new Uint8Array(31) }]),
    ).toThrow("invalid");
    expect(() => makeCredentialTombstoneDigester([{ version: " h1", bytes: key(1) }])).toThrow(
      "invalid",
    );
  });
});
