import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { makeHandleRecipientTokenVault } from "./handle-recipient-token-vault.ts";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

describe("handle recipient-token vault", () => {
  it("mints an exact 256-bit token and round-trips independent envelope material", async () => {
    const vault = makeHandleRecipientTokenVault({
      hmacKeys: `h2:${key(1)},h1:${key(2)}`,
      envelopeKeys: `e2:${key(3)},e1:${key(4)}`,
    });
    const token = await Effect.runPromise(vault.mint);
    expect(token).toMatch(/^hgrt_[A-Za-z0-9_-]{43}$/u);
    const lookups = await Effect.runPromise(vault.lookupCandidates(token));
    expect(lookups.map(({ keyVersion }) => keyVersion)).toEqual(["h2", "h1"]);
    expect(lookups[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(lookups[0]?.digest).not.toBe(lookups[1]?.digest);

    const sealed = await Effect.runPromise(vault.seal(token, "account/community/action"));
    expect(sealed.keyVersion).toBe("e2");
    expect(sealed.ciphertext).not.toContain(token);
    expect(await Effect.runPromise(vault.reveal(sealed, "account/community/action"))).toBe(token);
  });

  it("fails closed for altered associated data and missing key configuration", async () => {
    const vault = makeHandleRecipientTokenVault({
      hmacKeys: `h1:${key(5)}`,
      envelopeKeys: `e1:${key(6)}`,
    });
    const token = await Effect.runPromise(vault.mint);
    const sealed = await Effect.runPromise(vault.seal(token, "correct"));
    const altered = await Effect.runPromiseExit(vault.reveal(sealed, "altered"));
    expect(altered._tag).toBe("Failure");

    const unavailable = makeHandleRecipientTokenVault({ hmacKeys: "", envelopeKeys: "" });
    expect((await Effect.runPromiseExit(unavailable.mint))._tag).toBe("Failure");
  });
});
