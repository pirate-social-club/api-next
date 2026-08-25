import { describe, expect, test } from "bun:test";
import {
  decodeCanonicalCommunityRouteResolutionV2,
  decodeCommunityPathResolution,
  GetCanonicalCommunityRoute,
} from "./community-route-resolution.ts";

const ownerPresentation = {
  role: "owner" as const,
  persona: {
    persona_id: "persona-community-owner",
    object: "persona" as const,
    display_name: null,
    avatar_ref: null,
    primary_public_handle: null,
  },
};

describe("canonical community route resolution contract", () => {
  test("freezes the raw path parameter and public route shape", () => {
    expect(GetCanonicalCommunityRoute.path).toBe("/c/:path_segment");
    expect(GetCanonicalCommunityRoute.request?.exactRawPathParameters).toEqual(["path_segment"]);
    expect(GetCanonicalCommunityRoute.auth.policy.kind).toBe("public");
    expect(
      decodeCanonicalCommunityRouteResolutionV2({
        community_id: "community-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "xn--mnchen-3ya",
          href: "/c/xn--mnchen-3ya",
          app_host: null,
        },
      }),
    ).toMatchObject({ community_id: "community-hns" });
  });

  test("rejects an opaque-id or legacy-slug-shaped response", () => {
    expect(() =>
      decodeCanonicalCommunityRouteResolutionV2({
        community_id: "community-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "xn--mnchen-3ya",
          href: "/c/xn--mnchen-3ya",
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
        persona_role_presentation: ownerPresentation,
      }),
    ).toMatchObject({ community_id: communityId, canonical_route: null });
    expect(() =>
      decodeCommunityPathResolution({
        authority_version: "optional_route_v2",
        community_id: communityId,
        href: "/c/app.jazleeuw",
        canonical_route: null,
        persona_role_presentation: ownerPresentation,
      }),
    ).toThrow();
  });
});
