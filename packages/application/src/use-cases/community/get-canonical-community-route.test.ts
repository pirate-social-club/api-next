import { describe, expect, test } from "bun:test";
import { InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import { getCanonicalCommunityRoute } from "./get-canonical-community-route.ts";

const hns = {
  family: "hns" as const,
  root_label: "xn--mnchen-3ya",
  root_label_display: "münchen",
  path_segment: "app.xn--mnchen-3ya",
  href: "/c/app.xn--mnchen-3ya",
  app_host: null,
};

const spaces = {
  family: "spaces" as const,
  root_label: "xn--4v8h",
  root_label_display: "🔥",
  path_segment: "@xn--4v8h",
  href: "/c/@xn--4v8h",
  app_host: null,
};

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

const service = (response: unknown, calls: string[]) => ({
  canonicalCommunityRouteStore: {
    resolveCanonicalRoute: ({ path_segment }: { readonly path_segment: string }) => {
      calls.push(path_segment);
      return Effect.succeed(response as never);
    },
  },
});

describe("getCanonicalCommunityRoute", () => {
  test("resolves an active community by permanent id without namespace authority", async () => {
    const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
    const calls: string[] = [];
    await expect(
      Effect.runPromise(
        getCanonicalCommunityRoute(
          { path_segment: communityId },
          service(
            {
              authority_version: "optional_route_v2",
              community_id: communityId,
              href: `/c/${communityId}`,
              canonical_route: null,
              persona_role_presentation: ownerPresentation,
            },
            calls,
          ),
        ),
      ),
    ).resolves.toMatchObject({ community_id: communityId, canonical_route: null });
    expect(calls).toEqual([communityId]);
  });

  test("resolves exact ACE HNS and Spaces paths without normalization", async () => {
    const hnsCalls: string[] = [];
    await expect(
      Effect.runPromise(
        getCanonicalCommunityRoute(
          { path_segment: hns.path_segment },
          service({ community_id: "community-hns", canonical_route: hns }, hnsCalls),
        ),
      ),
    ).resolves.toMatchObject({ community_id: "community-hns", canonical_route: hns });
    expect(hnsCalls).toEqual([hns.path_segment]);

    const spacesCalls: string[] = [];
    await expect(
      Effect.runPromise(
        getCanonicalCommunityRoute(
          { path_segment: spaces.path_segment },
          service({ community_id: "community-spaces", canonical_route: spaces }, spacesCalls),
        ),
      ),
    ).resolves.toMatchObject({ community_id: "community-spaces", canonical_route: spaces });
    expect(spacesCalls).toEqual([spaces.path_segment]);
  });

  test("rejects Unicode, case, and encoded-style aliases before storage", async () => {
    const calls: string[] = [];
    for (const path_segment of ["app.münchen", "APP.XN--MNCHEN-3YA", "app.xn--mnchen%2D3ya"]) {
      await expect(
        Effect.runPromise(
          getCanonicalCommunityRoute(
            { path_segment },
            service({ community_id: "unexpected", canonical_route: hns }, calls),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "BadRequest" });
    }
    expect(calls).toEqual([]);
  });

  test("maps absence to NotFound and malformed storage to InternalError", async () => {
    await expect(
      Effect.runPromise(
        getCanonicalCommunityRoute({ path_segment: hns.path_segment }, service(null, [])),
      ),
    ).rejects.toBeInstanceOf(NotFound);

    await expect(
      Effect.runPromise(
        getCanonicalCommunityRoute(
          { path_segment: hns.path_segment },
          service(
            { community_id: "community-hns", canonical_route: { ...hns, href: "/c/wrong" } },
            [],
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });
});
