import { describe, expect, test } from "bun:test";
import {
  canonicalRouteLabelMatchesV1,
  normalizeRouteLabelV1,
  parseCanonicalRouteLabelV1,
} from "./index.ts";

describe("route-label-codec-v1", () => {
  test("normalizes equivalent Unicode and ACE inputs to one identity", () => {
    const expected = {
      kind: "accepted",
      value: { root_label: "xn--mnchen-3ya", root_label_display: "münchen" },
    } as const;
    for (const input of ["münchen", "MÜNCHEN", "münchen", "xn--mnchen-3ya"]) {
      expect(normalizeRouteLabelV1("hns", input), input).toEqual(expected);
    }
  });

  test("fails malformed ACE and forged display pairs closed", () => {
    for (const input of ["xn--0", "xn--1", "xn--123-pretty-valid-space-ok", "xn--e-xbb"]) {
      expect(parseCanonicalRouteLabelV1("hns", input), input).toEqual({
        kind: "rejected",
        reason: "invalid_root_label",
      });
    }
    expect(canonicalRouteLabelMatchesV1("hns", "xn--mnchen-3ya", "wrong")).toBe(false);
    expect(canonicalRouteLabelMatchesV1("hns", "xn--mnchen-3ya", "münchen")).toBe(true);
  });

  test("preserves canonical NFC display casing from TR46", () => {
    expect(normalizeRouteLabelV1("hns", "Ꭰ")).toEqual({
      kind: "accepted",
      value: { root_label: "xn--58d", root_label_display: "Ꭰ" },
    });
    expect(canonicalRouteLabelMatchesV1("hns", "xn--58d", "Ꭰ")).toBe(true);
    expect(canonicalRouteLabelMatchesV1("hns", "xn--58d", "ꭰ")).toBe(false);
  });
});
