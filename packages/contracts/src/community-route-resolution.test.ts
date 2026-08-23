import { describe, expect, test } from "bun:test";
import {
  decodeCanonicalCommunityRouteResolutionV1,
  decodeCommunityPathResolution,
  GetCanonicalCommunityRoute,
} from "./community-route-resolution.ts";

describe("canonical community route resolution contract", () => {
  test("freezes the raw path parameter and public route shape", () => {
    expect(GetCanonicalCommunityRoute.path).toBe("/c/:path_segment");
    expect(GetCanonicalCommunityRoute.request?.exactRawPathParameters).toEqual(["path_segment"]);
    expect(GetCanonicalCommunityRoute.auth.policy.kind).toBe("public");
    expect(
      decodeCanonicalCommunityRouteResolutionV1({
        community_id: "community-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "app.xn--mnchen-3ya",
          href: "/c/app.xn--mnchen-3ya",
          app_host: null,
        },
      }),
    ).toMatchObject({ community_id: "community-hns" });
  });

  test("rejects an opaque-id or legacy-slug-shaped response", () => {
    expect(() =>
      decodeCanonicalCommunityRouteResolutionV1({
        community_id: "community-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "app.xn--mnchen-3ya",
          href: "/c/app.xn--mnchen-3ya",
          app_host: null,
          route_slug: "legacy",
        },
      }),
    ).toThrow();
  });

  test("accepts a permanent V2 id route with optional current namespace metadata", () => {
    const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
    expect(
      decodeCommunityPathResolution({
        authority_version: "optional_route_v2",
        community_id: communityId,
        href: `/c/${communityId}`,
        canonical_route: null,
      }),
    ).toMatchObject({ community_id: communityId, canonical_route: null });
    expect(() =>
      decodeCommunityPathResolution({
        authority_version: "optional_route_v2",
        community_id: communityId,
        href: "/c/app.jazleeuw",
        canonical_route: null,
      }),
    ).toThrow();
  });
});
