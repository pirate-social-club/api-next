import { describe, expect, test } from "bun:test";
import { hnsEdgeAlertBearerMatches, isHnsEdgeAlertTokenConfigured } from "./hns-edge-alert-auth.ts";

const token = "a".repeat(48);

describe("HNS edge alert shared-secret authentication", () => {
  test("accepts only the exact bounded bearer token", async () => {
    expect(isHnsEdgeAlertTokenConfigured(token)).toBe(true);
    expect(await hnsEdgeAlertBearerMatches(`Bearer ${token}`, token)).toBe(true);

    for (const authorization of [
      undefined,
      token,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token} `,
      `Bearer ${"b".repeat(48)}`,
    ]) {
      expect(await hnsEdgeAlertBearerMatches(authorization, token)).toBe(false);
    }
  });

  test("refuses missing, whitespace-padded, short, and oversized configuration", () => {
    expect(isHnsEdgeAlertTokenConfigured("")).toBe(false);
    expect(isHnsEdgeAlertTokenConfigured(` ${token}`)).toBe(false);
    expect(isHnsEdgeAlertTokenConfigured("a".repeat(31))).toBe(false);
    expect(isHnsEdgeAlertTokenConfigured("a".repeat(513))).toBe(false);
  });
});
