import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./sha256.ts";

describe("gates-v2 synchronous SHA-256", () => {
  test("matches the NIST empty, short, and multi-block vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  test("matches WebCrypto for UTF-8 and policy-sized inputs", async () => {
    for (const input of ["🏴‍☠️", "policy:".repeat(80)]) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      const expected = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256Hex(input)).toBe(expected);
    }
  });
});
