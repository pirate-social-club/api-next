import { describe, expect, test } from "bun:test";
import { decodeActiveSongCursor, encodeActiveSongCursor } from "./active-song-cursor.ts";

describe("active song recovery cursor", () => {
  const cursor = { createdAt: "2026-09-21T00:00:00.123456Z", submissionId: "submission-fixture" };
  test("retains microseconds and binds pagination to account and community", () => {
    const encoded = encodeActiveSongCursor("account-one", "community-one", cursor);
    expect(decodeActiveSongCursor(encoded, "account-one", "community-one")).toEqual(cursor);
    expect(() => decodeActiveSongCursor(encoded, "account-two", "community-one")).toThrow();
    expect(() => decodeActiveSongCursor(encoded, "account-one", "community-two")).toThrow();
    expect(decodeActiveSongCursor(undefined, "account-one", "community-one")).toBeNull();
  });
  test("rejects invalid encodings, normalized invalid dates and excess fields", () => {
    for (const value of [
      "",
      "asm1.!",
      "asm1." + "a".repeat(1024),
      encodeActiveSongCursor("account-one", "community-one", {
        ...cursor,
        createdAt: "2026-02-30T00:00:00.123456Z",
      }),
    ])
      expect(() => decodeActiveSongCursor(value, "account-one", "community-one")).toThrow();
    const encoded = encodeActiveSongCursor("account-one", "community-one", cursor);
    const payload = JSON.parse(Buffer.from(encoded.slice(5), "base64url").toString("utf8"));
    const excess =
      "asm1." + Buffer.from(JSON.stringify({ ...payload, extra: true })).toString("base64url");
    expect(() => decodeActiveSongCursor(excess, "account-one", "community-one")).toThrow();
  });
});
