import { describe, expect, test } from "bun:test";
import {
  canonicalRouteView,
  communityNamespaceRequirementHash,
  communityNamespaceRequirementPreimage,
  deriveCommunityRoute,
  parseCommunityRoutePathSegment,
  validCommunityRouteRoot,
} from "./canonical-route.ts";

describe("canonical community routes", () => {
  test("derives exact HNS and Spaces route identities", () => {
    expect(deriveCommunityRoute({ family: "hns", root_label: "jazleeuw" })).toEqual({
      kind: "accepted",
      value: {
        family: "hns",
        root_label: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
      },
    });
    expect(deriveCommunityRoute({ family: "spaces", root_label: "music" })).toEqual({
      kind: "accepted",
      value: {
        family: "spaces",
        root_label: "music",
        path_segment: "@music",
        href: "/c/@music",
      },
    });
  });

  test("rejects rather than normalizes non-canonical roots", () => {
    for (const root of ["a", "alpha-2", "a".repeat(63)]) {
      expect(validCommunityRouteRoot(root), root).toBe(true);
    }
    const invalid = [
      "",
      "Jazleeuw",
      "@music",
      "app.jazleeuw",
      "jazleeuw.",
      " jazleeuw",
      "jazleeuw ",
      "two--hyphens",
      "-leading",
      "trailing-",
      "slash/root",
      "back\\slash",
      "percent%2Eescape",
      "müsic",
      "a".repeat(64),
    ];
    for (const root of invalid) {
      expect(validCommunityRouteRoot(root), root).toBe(false);
      expect(deriveCommunityRoute({ family: "hns", root_label: root })).toEqual({
        kind: "rejected",
        reason: "invalid_root_label",
      });
    }
    expect(deriveCommunityRoute({ family: "dns", root_label: "jazleeuw" })).toEqual({
      kind: "rejected",
      reason: "invalid_family",
    });
  });

  test("parses only exact canonical public path segments", () => {
    expect(parseCommunityRoutePathSegment("app.jazleeuw")).toMatchObject({
      kind: "accepted",
      value: { family: "hns", root_label: "jazleeuw" },
    });
    expect(parseCommunityRoutePathSegment("@music")).toMatchObject({
      kind: "accepted",
      value: { family: "spaces", root_label: "music" },
    });
    for (const candidate of [
      "jazleeuw",
      "",
      "app.",
      "@",
      "APP.jazleeuw",
      "app.jazleeuw.extra",
      "app.jazleeuw/threads",
      "@Music",
      "@müsic",
      "%40music",
      "community_opaque_id",
    ]) {
      expect(parseCommunityRoutePathSegment(candidate), candidate).toEqual({
        kind: "rejected",
        reason: "invalid_path_segment",
      });
    }
  });

  test("keeps optional HNS host health out of canonical path identity", () => {
    const result = deriveCommunityRoute({ family: "hns", root_label: "technohippies" });
    if (result.kind !== "accepted") throw new Error("expected accepted HNS route");
    expect(canonicalRouteView(result.value, false).app_host).toBeNull();
    expect(canonicalRouteView(result.value, true).app_host).toBe("app.technohippies");

    const spaces = deriveCommunityRoute({ family: "spaces", root_label: "music" });
    if (spaces.kind !== "accepted") throw new Error("expected accepted Spaces route");
    expect(canonicalRouteView(spaces.value, true).app_host).toBeNull();
  });

  test("pins the namespace requirement preimage and hash to route identity only", () => {
    const request = { family: "hns", root_label: "jazleeuw" } as const;
    expect(communityNamespaceRequirementPreimage(request)).toEqual({
      kind: "accepted",
      value:
        '{"family":"hns","path_segment":"app.jazleeuw","root_label":"jazleeuw","version":"community-namespace-requirement-v1"}',
    });
    expect(communityNamespaceRequirementHash(request)).toEqual({
      kind: "accepted",
      value: "30ecf317e335f95b655217a3f5825457f507be668e09d3d9f6c376098129ae96",
    });

    expect(
      communityNamespaceRequirementHash({ family: "hns", root_label: "technohippies" }),
    ).not.toEqual(communityNamespaceRequirementHash(request));
    expect(communityNamespaceRequirementHash({ family: "hns", root_label: "app.forged" })).toEqual({
      kind: "rejected",
      reason: "invalid_root_label",
    });
  });
});
