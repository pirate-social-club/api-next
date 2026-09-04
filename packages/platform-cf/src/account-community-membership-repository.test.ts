import { describe, expect, test } from "bun:test";
import {
  type CommunityRepositoryError,
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Effect } from "effect";
import { makeControlPlaneCommunityRepository } from "./community-repository.ts";

const asOf = "2026-09-04T08:00:00.123456Z";
const createdA = "2026-09-01T10:00:00.123001Z";
const createdB = "2026-09-01T10:00:00.123002Z";

const row = (
  communityId: string,
  displayName: string,
  createdAt: string,
  route: null | "hns" = null,
  authority: "legacy_slug_v1" | "route_v1" | "optional_route_v2" = "optional_route_v2",
) => ({
  community_id: communityId,
  display_name: displayName,
  route_authority_version: authority,
  membership_status: "member",
  membership_created_at: createdAt,
  cursor_as_of: asOf,
  cursor_created_at: createdAt,
  route_family: route,
  route_root_label: route === null ? null : "alpha",
  route_root_label_display: route === null ? null : "alpha",
  route_path_segment: route === null ? null : "alpha",
  route_href: route === null ? null : "/c/alpha",
  route_app_host: null,
});

const run = <A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  execute: ControlPlaneDb["Service"]["execute"],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(ControlPlaneDb, {
        execute,
        withTransaction: (use) => use({ execute }),
      }),
    ),
  );

describe("account community membership repository", () => {
  test("paginates deterministically with an account-bound opaque cursor", async () => {
    const statements: ControlPlaneStatement[] = [];
    let call = 0;
    const execute = <Row = unknown>(statement: ControlPlaneStatement) => {
      statements.push(statement);
      const rows =
        call++ === 0
          ? [row("community-a", "A", createdA), row("community-b", "B", createdB)]
          : [row("community-b", "B", createdB, "hns", "route_v1")];
      return Effect.succeed({ rows: rows as unknown as readonly Row[], rowCount: rows.length });
    };
    const repository = makeControlPlaneCommunityRepository();
    const first = await run(
      repository.listAccountMemberships({ userId: "user-a", query: { limit: "1" } }),
      execute,
    );
    expect(first).toMatchObject({
      object: "account_community_membership_page",
      items: [
        {
          community_id: "community-a",
          resource_href: "/c/community-a",
          canonical_route: null,
          membership_status: "member",
          can_post: true,
        },
      ],
    });
    expect(first.next_cursor).toStartWith("acm1.");
    const encodedPayload = first.next_cursor?.slice("acm1.".length) ?? "";
    const paddedPayload = encodedPayload
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    expect(atob(paddedPayload)).not.toContain("user-a");
    const second = await run(
      repository.listAccountMemberships({
        userId: "user-a",
        query: { cursor: first.next_cursor ?? undefined, limit: "1" },
      }),
      execute,
    );
    expect(second).toEqual({
      object: "account_community_membership_page",
      items: [
        {
          object: "account_community_membership",
          community_id: "community-b",
          display_name: "B",
          resource_href: null,
          canonical_route: {
            family: "hns",
            root_label: "alpha",
            root_label_display: "alpha",
            path_segment: "alpha",
            href: "/c/alpha",
            app_host: null,
          },
          membership_status: "member",
          can_post: true,
        },
      ],
      next_cursor: null,
    });
    expect(statements[0]?.text).toContain("membership.user_id = $1");
    expect(statements[0]?.text).toContain("membership.status = 'member'");
    expect(statements[0]?.text).toContain("community.status = 'active'");
    expect(statements[0]?.text).toContain('community.community_id COLLATE "C"');
    expect(statements[1]?.values).toEqual(["user-a", asOf, createdA, "community-a", 2]);
    await expect(
      run(
        repository.listAccountMemberships({
          userId: "user-b",
          query: { cursor: first.next_cursor ?? undefined, limit: "1" },
        }),
        execute,
      ),
    ).rejects.toMatchObject({ reason: "invalid-cursor" });
    expect(statements).toHaveLength(2);
  });

  test("rejects malformed cursors without touching storage", async () => {
    let calls = 0;
    const repository = makeControlPlaneCommunityRepository();
    const execute = <Row = unknown>(): Effect.Effect<ControlPlaneResult<Row>> => {
      calls += 1;
      return Effect.succeed({ rows: [], rowCount: 0 });
    };
    await expect(
      run(
        repository.listAccountMemberships({
          userId: "user-a",
          query: { cursor: "acm1.not-base64" },
        }),
        execute,
      ),
    ).rejects.toMatchObject({
      _tag: "CommunityRepositoryError",
      reason: "invalid-cursor",
    } satisfies Partial<CommunityRepositoryError>);
    expect(calls).toBe(0);
  });
});
