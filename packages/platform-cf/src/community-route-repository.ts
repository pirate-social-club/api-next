import {
  type CanonicalCommunityRouteDocument,
  CanonicalCommunityRouteRepositoryError,
  type CanonicalCommunityRouteRepositoryFailure,
  type CanonicalCommunityRouteStore,
  type CanonicalCommunityRouteStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
} from "@pirate/application";
import {
  decodeCanonicalCommunityRouteResolutionV1,
  decodeCommunityPathResolution,
} from "@pirate/contracts";
import { parseCommunityPathSegment, parseCommunityRoutePathSegment } from "@pirate/domain";
import { Effect, type Layer } from "effect";

const OPERATION = "resolve-canonical-route" as const;

type CanonicalCommunityRouteRow = Readonly<{
  readonly community_id: unknown;
  readonly authority_version?: unknown;
  readonly resource_href?: unknown;
  readonly persona_role_presentation?: unknown;
  readonly family: unknown;
  readonly root_label: unknown;
  readonly root_label_display: unknown;
  readonly path_segment: unknown;
  readonly href: unknown;
  readonly app_host: unknown;
}>;

export interface CanonicalCommunityRouteRepository {
  readonly resolveCanonicalRoute: (
    input: Parameters<CanonicalCommunityRouteStoreService["resolveCanonicalRoute"]>[0],
  ) => Effect.Effect<
    CanonicalCommunityRouteDocument | null,
    CanonicalCommunityRouteRepositoryFailure,
    ControlPlaneDb
  >;
}

const resolveCanonicalRouteStatement = (pathSegment: string) =>
  ({
    label: "community.routes.resolve-canonical",
    text: `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         SELECT route.community_id,
                route.family,
                route.root_label,
                route.root_label_display,
                route.path_segment,
                route.href,
                CASE
                  WHEN route.family = 'hns' AND health.health_status = 'healthy'
                    THEN route.path_segment
                  ELSE NULL
                END AS app_host
           FROM db_clock
           CROSS JOIN LATERAL effective_route_authority_v2(NULL, db_clock.now) AS route
           LEFT JOIN community_route_app_host_health AS health
             ON health.route_binding_id = route.route_binding_id
            AND health.family = 'hns'
            AND health.health_generation = route.binding_generation
          WHERE route.path_segment = $1`,
    values: [pathSegment],
    readonly: true,
  }) as const;

const resolveCommunityIdStatement = (communityId: string) =>
  ({
    label: "community.routes.resolve-community-id",
    text: `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         SELECT community.community_id,
                community.route_authority_version AS authority_version,
                '/c/' || community.community_id AS resource_href,
                jsonb_build_object(
                  'role', 'owner',
                  'persona', public_persona_projection(presentation.persona_id)
                ) AS persona_role_presentation,
                route.family,
                route.root_label,
                route.root_label_display,
                route.path_segment,
                route.href,
                CASE
                  WHEN route.family = 'hns' AND health.health_status = 'healthy'
                    THEN route.path_segment
                  ELSE NULL
                END AS app_host
           FROM db_clock
           JOIN communities AS community
             ON community.community_id = $1
            AND community.status = 'active'
            AND community.route_authority_version = 'optional_route_v2'
           JOIN persona_role_presentations AS presentation
             ON presentation.community_id = community.community_id
            AND presentation.account_id = community.created_by_user_id
           LEFT JOIN LATERAL effective_route_authority_v2(community.community_id, db_clock.now) AS route
             ON TRUE
           LEFT JOIN community_route_app_host_health AS health
             ON health.route_binding_id = route.route_binding_id
            AND health.family = 'hns'
            AND health.health_generation = route.binding_generation`,
    values: [communityId],
    readonly: true,
  }) as const;

const invalidPath = () =>
  new CanonicalCommunityRouteRepositoryError({ operation: OPERATION, reason: "invalid-path" });

const invalidRow = () =>
  new CanonicalCommunityRouteRepositoryError({ operation: OPERATION, reason: "invalid-row" });

const validString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !value.includes("\u0000");

const routeMatches = (
  row: CanonicalCommunityRouteRow,
  parsed: Extract<ReturnType<typeof parseCommunityRoutePathSegment>, { readonly kind: "accepted" }>,
): row is CanonicalCommunityRouteRow & {
  readonly community_id: string;
  readonly family: string;
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly href: string;
  readonly app_host: string | null;
} =>
  validString(row.community_id) &&
  row.family === parsed.value.family &&
  row.root_label === parsed.value.root_label &&
  row.root_label_display === parsed.value.root_label_display &&
  row.path_segment === parsed.value.path_segment &&
  row.href === parsed.value.href &&
  (row.app_host === null || row.app_host === parsed.value.path_segment);

export function makeControlPlaneCanonicalCommunityRouteRepository(): CanonicalCommunityRouteRepository {
  return {
    resolveCanonicalRoute: (input) =>
      Effect.gen(function* () {
        if (
          typeof input.path_segment !== "string" ||
          input.path_segment.length === 0 ||
          input.path_segment.length > 512 ||
          input.path_segment !== input.path_segment.trim() ||
          input.path_segment.includes("\u0000")
        ) {
          return yield* Effect.fail(invalidPath());
        }

        const parsed = parseCommunityPathSegment(input.path_segment);
        if (parsed.kind === "rejected") return yield* Effect.fail(invalidPath());

        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<CanonicalCommunityRouteRow>(
          parsed.value.kind === "community_id"
            ? resolveCommunityIdStatement(parsed.value.community_id)
            : resolveCanonicalRouteStatement(parsed.value.route.path_segment),
        );
        if (result.rows.length > 1) return yield* Effect.fail(invalidRow());
        const row = result.rows[0];
        if (row === undefined) return null;

        if (parsed.value.kind === "community_id") {
          if (
            row.community_id !== parsed.value.community_id ||
            row.authority_version !== "optional_route_v2" ||
            row.resource_href !== parsed.value.href
          ) {
            return yield* Effect.fail(invalidRow());
          }
          let canonicalRoute = null;
          if (row.path_segment !== null) {
            if (typeof row.path_segment !== "string") return yield* Effect.fail(invalidRow());
            const route = parseCommunityRoutePathSegment(row.path_segment);
            if (route.kind === "rejected" || !routeMatches(row, route)) {
              return yield* Effect.fail(invalidRow());
            }
            canonicalRoute = {
              family: row.family,
              root_label: row.root_label,
              root_label_display: row.root_label_display,
              path_segment: row.path_segment,
              href: row.href,
              app_host: row.app_host,
            };
          } else if (
            row.family !== null ||
            row.root_label !== null ||
            row.root_label_display !== null ||
            row.href !== null ||
            row.app_host !== null
          ) {
            return yield* Effect.fail(invalidRow());
          }
          try {
            return decodeCommunityPathResolution({
              authority_version: "optional_route_v2",
              community_id: row.community_id,
              href: row.resource_href,
              canonical_route: canonicalRoute,
              persona_role_presentation: row.persona_role_presentation,
            });
          } catch {
            return yield* Effect.fail(invalidRow());
          }
        }

        const routeTarget = { kind: "accepted" as const, value: parsed.value.route };
        if (!routeMatches(row, routeTarget)) return yield* Effect.fail(invalidRow());

        try {
          return decodeCanonicalCommunityRouteResolutionV1({
            community_id: row.community_id,
            canonical_route: {
              family: row.family,
              root_label: row.root_label,
              root_label_display: row.root_label_display,
              path_segment: row.path_segment,
              href: row.href,
              app_host: row.app_host,
            },
          });
        } catch {
          return yield* Effect.fail(invalidRow());
        }
      }),
  };
}

export function makeControlPlaneCanonicalCommunityRouteStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CanonicalCommunityRouteStore["Service"] {
  const repository = makeControlPlaneCanonicalCommunityRouteRepository();
  return {
    resolveCanonicalRoute: (input) =>
      Effect.provide(runtime)(repository.resolveCanonicalRoute(input)),
  };
}
