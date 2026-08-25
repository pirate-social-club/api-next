import { describe, expect, test } from "bun:test";
import {
  canonicalRouteView,
  communityNamespaceRequirementHash,
  communityNamespaceRequirementPreimage,
  deriveCommunityRoute,
  parseCommunityPathSegment,
  parseCommunityPublicRoutePathSegmentV2,
  parseCommunityRoutePathSegment,
  projectCommunityPublicRouteV2,
  validCommunityRouteRoot,
  validPublicCommunityRouteRootV2,
} from "./canonical-route.ts";

describe("canonical community routes", () => {
  test("derives exact HNS and Spaces route identities", () => {
    expect(deriveCommunityRoute({ family: "hns", root_label: "jazleeuw" })).toEqual({
      kind: "accepted",
      value: {
        family: "hns",
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
      },
    });
    expect(deriveCommunityRoute({ family: "spaces", root_label: "music" })).toEqual({
      kind: "accepted",
      value: {
        family: "spaces",
        root_label: "music",
        root_label_display: "music",
        path_segment: "@music",
        href: "/c/@music",
      },
    });
  });

  test("canonicalizes the pinned Unicode, compatibility, ACE, and emoji vectors", () => {
    for (const input of ["münchen", "MÜNCHEN", "münchen", "xn--mnchen-3ya"]) {
      expect(deriveCommunityRoute({ family: "hns", root_label: input }), input).toEqual({
        kind: "accepted",
        value: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "app.xn--mnchen-3ya",
          href: "/c/app.xn--mnchen-3ya",
        },
      });
    }

    for (const [input, root_label, root_label_display] of [
      ["🔥", "xn--4v8h", "🔥"],
      ["☠", "xn--h4h", "☠"],
      ["☠️", "xn--h4h", "☠"],
      ["🇵🇸", "xn--t77hga", "🇵🇸"],
      ["ｆｏｏ", "foo", "foo"],
      ["foo\u200bbar", "foobar", "foobar"],
    ] as const) {
      expect(deriveCommunityRoute({ family: "spaces", root_label: input }), input).toMatchObject({
        kind: "accepted",
        value: { root_label, root_label_display },
      });
    }
  });

  test("applies HNS and Spaces protocol rules independently after conversion", () => {
    expect(validCommunityRouteRoot("hns", "tame_impala")).toBe(true);
    expect(validCommunityRouteRoot("hns", "one--two")).toBe(true);
    expect(validCommunityRouteRoot("spaces", "tame_impala")).toBe(false);
    expect(validCommunityRouteRoot("spaces", "one--two")).toBe(false);
    expect(validCommunityRouteRoot("hns", "a".repeat(63))).toBe(true);
    expect(validCommunityRouteRoot("hns", "a".repeat(64))).toBe(false);
    expect(validCommunityRouteRoot("spaces", "a".repeat(62))).toBe(true);
    expect(validCommunityRouteRoot("spaces", "a".repeat(63))).toBe(false);

    for (const root of ["example", "invalid", "local", "localhost", "test"]) {
      expect(validCommunityRouteRoot("hns", root), root).toBe(false);
    }
  });

  test("rejects malformed ACE and unsupported or structural write input", () => {
    const invalid = [
      "",
      "@music",
      "app.jazleeuw",
      "jazleeuw.",
      " jazleeuw",
      "jazleeuw ",
      "slash/root",
      "back\\slash",
      "percent%2Eescape",
      "foo。bar",
      "foo．bar",
      "foo｡bar",
      "control\u0000value",
      "🏴‍☠️",
      "xn--",
      "xn--0",
      "xn--1",
      "xn--238746723487",
      "xn--123-pretty-valid-space-ok",
      "xn--e-xbb",
      "a".repeat(256),
      "🔥".repeat(64),
    ];
    for (const root of invalid) {
      expect(deriveCommunityRoute({ family: "hns", root_label: root }), root).toEqual({
        kind: "rejected",
        reason: "invalid_root_label",
      });
    }
    expect(deriveCommunityRoute({ family: "dns", root_label: "jazleeuw" })).toEqual({
      kind: "rejected",
      reason: "invalid_family",
    });
  });

  test("parses only exact canonical ACE public path segments", () => {
    expect(parseCommunityRoutePathSegment("app.xn--mnchen-3ya")).toEqual({
      kind: "accepted",
      value: {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
      },
    });
    expect(parseCommunityRoutePathSegment("@xn--4v8h")).toMatchObject({
      kind: "accepted",
      value: { family: "spaces", root_label: "xn--4v8h", root_label_display: "🔥" },
    });
    for (const candidate of [
      "jazleeuw",
      "",
      "app.",
      "@",
      "APP.jazleeuw",
      "app.MUSIC",
      "app.ｍｕｓｉｃ",
      "app.ⓜⓤⓢⓘⓒ",
      "app.münchen",
      "app.jazleeuw.extra",
      "app.jazleeuw/threads",
      "@Music",
      "@müsic",
      "%40music",
      "@%6Dusic",
      "@%256Dusic",
      "community_opaque_id",
    ]) {
      expect(parseCommunityRoutePathSegment(candidate), candidate).toEqual({
        kind: "rejected",
        reason: "invalid_path_segment",
      });
    }
  });

  test("projects bare HNS public routes without changing v1 authority identity", () => {
    expect(parseCommunityPublicRoutePathSegmentV2("xn--mnchen-3ya")).toEqual({
      kind: "accepted",
      value: {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "xn--mnchen-3ya",
        href: "/c/xn--mnchen-3ya",
      },
    });
    expect(parseCommunityPublicRoutePathSegmentV2("@xn--4v8h")).toMatchObject({
      kind: "accepted",
      value: { family: "spaces", root_label: "xn--4v8h", root_label_display: "🔥" },
    });
    expect(
      projectCommunityPublicRouteV2({ family: "hns", root_label: "tame_impala" }),
    ).toMatchObject({
      kind: "accepted",
      value: { path_segment: "tame_impala", href: "/c/tame_impala" },
    });
    expect(validCommunityRouteRoot("hns", "pirate")).toBe(true);
    expect(validPublicCommunityRouteRootV2("hns", "pirate")).toBe(false);
    expect(
      validPublicCommunityRouteRootV2("hns", "community_123e4567-e89b-42d3-a456-426614174000"),
    ).toBe(false);
    for (const candidate of [
      "app.jazleeuw",
      "pirate",
      "APP",
      "münchen",
      "%6Aazleeuw",
      "community_123e4567-e89b-42d3-a456-426614174000",
    ]) {
      expect(parseCommunityPublicRoutePathSegmentV2(candidate), candidate).toEqual({
        kind: "rejected",
        reason: expect.any(String),
      });
    }
  });

  test("reserves generated community identifiers as a disjoint public path family", () => {
    const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
    expect(parseCommunityPathSegment(communityId)).toEqual({
      kind: "accepted",
      value: { kind: "community_id", community_id: communityId, href: `/c/${communityId}` },
    });
    expect(parseCommunityPathSegment("jazleeuw")).toMatchObject({
      kind: "accepted",
      value: { kind: "namespace_route", route: { family: "hns" } },
    });
    expect(parseCommunityPathSegment("community_opaque_id")).toMatchObject({
      kind: "accepted",
      value: { kind: "namespace_route", route: { family: "hns" } },
    });
    for (const eligibleHnsRoot of [
      "community_123e4567-e89b-12d3-a456-426614174000",
      "community_123e4567-e89b-42d3-7456-426614174000",
    ]) {
      expect(parseCommunityPathSegment(eligibleHnsRoot)).toMatchObject({
        kind: "accepted",
        value: { kind: "namespace_route", route: { family: "hns" } },
      });
    }
    expect(parseCommunityPathSegment("app.jazleeuw")).toEqual({
      kind: "rejected",
      reason: "invalid_path_segment",
    });
  });

  test("keeps optional HNS host health out of canonical path identity", () => {
    const result = deriveCommunityRoute({ family: "hns", root_label: "technohippies" });
    if (result.kind !== "accepted") throw new Error("expected accepted HNS route");
    expect(canonicalRouteView(result.value, false).app_host).toBeNull();
    expect(canonicalRouteView(result.value, true).app_host).toBe("app.technohippies");

    const underscored = deriveCommunityRoute({ family: "hns", root_label: "tame_impala" });
    if (underscored.kind !== "accepted") throw new Error("expected accepted HNS route");
    expect(canonicalRouteView(underscored.value, false).app_host).toBeNull();

    const spaces = deriveCommunityRoute({ family: "spaces", root_label: "music" });
    if (spaces.kind !== "accepted") throw new Error("expected accepted Spaces route");
    expect(canonicalRouteView(spaces.value, true).app_host).toBeNull();
  });

  test("pins equivalent writes to one namespace requirement preimage and hash", () => {
    const unicode = { family: "hns", root_label: "münchen" } as const;
    const ace = { family: "hns", root_label: "xn--mnchen-3ya" } as const;
    const preimage = communityNamespaceRequirementPreimage(unicode);
    expect(preimage).toEqual(communityNamespaceRequirementPreimage(ace));
    expect(preimage).toEqual({
      kind: "accepted",
      value:
        '{"family":"hns","path_segment":"app.xn--mnchen-3ya","root_label":"xn--mnchen-3ya","route_label_codec_version":"route-label-codec-v1","version":"community-namespace-requirement-v1"}',
    });
    expect(communityNamespaceRequirementHash(unicode)).toEqual(
      communityNamespaceRequirementHash(ace),
    );
    expect(communityNamespaceRequirementHash(unicode)).toEqual({
      kind: "accepted",
      value: "d1ae3a838a17a59138cd8dee634a646b81b1e59c7987ea724aafaecf4379e284",
    });

    expect(
      communityNamespaceRequirementHash({ family: "hns", root_label: "technohippies" }),
    ).not.toEqual(communityNamespaceRequirementHash(unicode));
    expect(communityNamespaceRequirementHash({ family: "hns", root_label: "app.forged" })).toEqual({
      kind: "rejected",
      reason: "invalid_root_label",
    });
    expect(communityNamespaceRequirementHash({ family: "hns", root_label: "pirate" })).toEqual({
      kind: "rejected",
      reason: "invalid_root_label",
    });
  });
});
