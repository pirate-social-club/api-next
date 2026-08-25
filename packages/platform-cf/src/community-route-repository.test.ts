import { describe, expect, test } from "bun:test";
import {
  CanonicalCommunityRouteRepositoryError,
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { makeControlPlaneCanonicalCommunityRouteRepository } from "./community-route-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const hnsRow = (overrides: Row = {}): Row => ({
  community_id: "community-hns",
  family: "hns",
  root_label: "xn--mnchen-3ya",
  root_label_display: "münchen",
  path_segment: "xn--mnchen-3ya",
  href: "/c/xn--mnchen-3ya",
  app_host: null,
  ...overrides,
});

const spacesRow = (overrides: Row = {}): Row => ({
  community_id: "community-spaces",
  family: "spaces",
  root_label: "xn--4v8h",
  root_label_display: "🔥",
  path_segment: "@xn--4v8h",
  href: "/c/@xn--4v8h",
  app_host: null,
  ...overrides,
});

const optionalRouteRow = (overrides: Row = {}): Row => {
  const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
  return {
    community_id: communityId,
    authority_version: "optional_route_v2",
    resource_href: `/c/${communityId}`,
    persona_role_presentation: {
      role: "owner",
      persona: {
        persona_id: "persona_creator",
        object: "persona",
        display_name: "Community Creator",
        avatar_ref: null,
        primary_public_handle: null,
      },
    },
    family: null,
    root_label: null,
    root_label_display: null,
    path_segment: null,
    href: null,
    app_host: null,
    ...overrides,
  };
};

function fakeDb(rows: readonly Row[], calls: ControlPlaneStatement[]) {
  const execute = <R = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<R>, never> => {
    calls.push(statement);
    return Effect.succeed({ rows: rows as readonly R[], rowCount: rows.length });
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

const runWith = <A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  db: ControlPlaneDb["Service"],
) => Effect.runPromiseExit(Effect.provideService(effect, ControlPlaneDb, db));

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

describe("canonical community route Postgres repository", () => {
  test("resolves an active optional-route community without a binding", async () => {
    const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
    const calls: ControlPlaneStatement[] = [];
    const exit = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: communityId,
      }),
      fakeDb([optionalRouteRow()], calls),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({ community_id: communityId, canonical_route: null });
    }
    expect(calls[0]).toMatchObject({
      label: "community.routes.resolve-community-id",
      values: [communityId],
    });
    expect(calls[0]?.text).toContain("community.status = 'active'");
    expect(calls[0]?.text).toContain("LEFT JOIN LATERAL effective_public_community_route_v2");
  });

  test("resolves HNS IDN and Spaces emoji paths with one exact read", async () => {
    for (const [path_segment, row] of [
      ["xn--mnchen-3ya", hnsRow()],
      ["@xn--4v8h", spacesRow()],
    ] as const) {
      const calls: ControlPlaneStatement[] = [];
      const exit = await runWith(
        makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({ path_segment }),
        fakeDb([row], calls),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit) && exit.value !== null && exit.value.canonical_route !== null) {
        expect(exit.value.canonical_route.path_segment).toBe(path_segment);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        label: "community.routes.resolve-canonical",
        values: [path_segment],
        readonly: true,
      });
      expect(calls[0]?.text).toContain("effective_public_community_route_v2(NULL, db_clock.now)");
      expect(calls[0]?.text).not.toContain("evidence.expires_at");
    }
  });

  test("returns null for an inactive/expired result filtered by SQL", async () => {
    const calls: ControlPlaneStatement[] = [];
    const exit = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: "xn--mnchen-3ya",
      }),
      fakeDb([], calls),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBeNull();
  });

  test("rejects aliases before touching Postgres and rejects ambiguous rows", async () => {
    const invalidCalls: ControlPlaneStatement[] = [];
    const invalid = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: "münchen",
      }),
      fakeDb([hnsRow()], invalidCalls),
    );
    expect(failureOf(invalid)).toBeInstanceOf(CanonicalCommunityRouteRepositoryError);
    expect(failureOf(invalid)).toMatchObject({ reason: "invalid-path" });
    expect(invalidCalls).toEqual([]);

    const ambiguous = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: "xn--mnchen-3ya",
      }),
      fakeDb([hnsRow(), hnsRow({ community_id: "community-other" })], []),
    );
    expect(failureOf(ambiguous)).toMatchObject({ reason: "invalid-row" });
  });

  test("fails closed for a route-shape mismatch and permits only the HNS app host value", async () => {
    const mismatch = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: "xn--mnchen-3ya",
      }),
      fakeDb([hnsRow({ root_label_display: "wrong" })], []),
    );
    expect(failureOf(mismatch)).toMatchObject({ reason: "invalid-row" });

    const healthyCalls: ControlPlaneStatement[] = [];
    const healthy = await runWith(
      makeControlPlaneCanonicalCommunityRouteRepository().resolveCanonicalRoute({
        path_segment: "xn--mnchen-3ya",
      }),
      fakeDb([hnsRow({ app_host: "app.xn--mnchen-3ya" })], healthyCalls),
    );
    expect(Exit.isSuccess(healthy)).toBe(true);
    if (
      Exit.isSuccess(healthy) &&
      healthy.value !== null &&
      healthy.value.canonical_route !== null
    ) {
      expect(healthy.value.canonical_route.app_host).toBe("app.xn--mnchen-3ya");
    }
  });
});
