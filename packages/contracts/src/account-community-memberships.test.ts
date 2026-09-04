import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ListMyCommunityMemberships } from "./v1.ts";

describe("account community membership contract", () => {
  test("is an authenticated account-scoped cursor read", () => {
    expect(ListMyCommunityMemberships).toMatchObject({
      method: "GET",
      path: "/users/me/community-memberships",
      auth: { policy: { kind: "userOrAdmin" } },
      successStatus: 200,
    });
  });

  test("bounds page size and keeps the selector projection closed", () => {
    const decodeQuery = Schema.decodeUnknownSync(ListMyCommunityMemberships.request.query, {
      onExcessProperty: "error",
    });
    expect(decodeQuery({ cursor: "opaque", limit: "100" })).toEqual({
      cursor: "opaque",
      limit: "100",
    });
    expect(() => decodeQuery({ limit: "0" })).toThrow();
    expect(() => decodeQuery({ limit: "101" })).toThrow();

    const decodeResponse = Schema.decodeUnknownSync(ListMyCommunityMemberships.response, {
      onExcessProperty: "error",
    });
    expect(
      decodeResponse({
        object: "account_community_membership_page",
        items: [
          {
            object: "account_community_membership",
            community_id: "community-a",
            display_name: "Community A",
            resource_href: "/c/community-a",
            canonical_route: null,
            membership_status: "member",
            can_post: true,
          },
        ],
        next_cursor: null,
      }),
    ).toMatchObject({ items: [{ community_id: "community-a", can_post: true }] });
    expect(
      decodeResponse({
        object: "account_community_membership_page",
        items: [
          {
            object: "account_community_membership",
            community_id: "legacy-community",
            display_name: "Legacy Community",
            resource_href: null,
            canonical_route: null,
            membership_status: "member",
            can_post: true,
          },
        ],
        next_cursor: null,
      }),
    ).toMatchObject({ items: [{ community_id: "legacy-community", resource_href: null }] });
    expect(() =>
      decodeResponse({
        object: "account_community_membership_page",
        items: [
          {
            object: "account_community_membership",
            community_id: "community-a",
            display_name: "Community A",
            resource_href: "/c/community-b",
            canonical_route: null,
            membership_status: "member",
            can_post: true,
          },
        ],
        next_cursor: null,
      }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        object: "account_community_membership_page",
        items: [],
        next_cursor: null,
        leaked_account_id: "account-a",
      }),
    ).toThrow();
  });
});
