import { describe, expect, test } from "bun:test";
import { privyUserLookupUrl } from "./session-proof";

describe("Privy server API routing", () => {
  test("uses the current v1 user lookup path", () => {
    expect(privyUserLookupUrl("https://api.privy.io", "did:privy:test/user")).toBe(
      "https://api.privy.io/v1/users/did%3Aprivy%3Atest%2Fuser",
    );
  });
});
