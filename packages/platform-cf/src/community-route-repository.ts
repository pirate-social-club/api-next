import {
  type CanonicalCommunityRouteDocument,
  CanonicalCommunityRouteRepositoryError,
  type CanonicalCommunityRouteRepositoryFailure,
  type CanonicalCommunityRouteStore,
  type CanonicalCommunityRouteStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
} from "@pirate/application";
import { decodeCanonicalCommunityRouteResolutionV1 } from "@pirate/contracts";
import { parseCommunityRoutePathSegment } from "@pirate/domain";
import { Effect, type Layer } from "effect";

const OPERATION = "resolve-canonical-route" as const;

type CanonicalCommunityRouteRow = Readonly<{
  readonly community_id: unknown;
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
           CROSS JOIN LATERAL effective_active_route(NULL, db_clock.now) AS route
           LEFT JOIN community_route_app_host_health AS health
             ON health.route_binding_id = route.route_binding_id
            AND health.family = 'hns'
            AND health.health_generation = route.binding_generation
          WHERE route.path_segment = $1`,
    values: [pathSegment],
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

        const parsed = parseCommunityRoutePathSegment(input.path_segment);
        if (parsed.kind === "rejected") return yield* Effect.fail(invalidPath());

        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<CanonicalCommunityRouteRow>(
          resolveCanonicalRouteStatement(input.path_segment),
        );
        if (result.rows.length > 1) return yield* Effect.fail(invalidRow());
        const row = result.rows[0];
        if (row === undefined) return null;
        if (!routeMatches(row, parsed)) return yield* Effect.fail(invalidRow());

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
