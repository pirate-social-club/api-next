import {
  BadRequest,
  decodeCommunityPathResolution,
  type GetCanonicalCommunityRoute,
  InternalError,
  NotFound,
} from "@pirate/contracts";
import { parseCommunityPathSegment } from "@pirate/domain";
import { Effect, type Schema } from "effect";
import {
  CanonicalCommunityRouteRepositoryError,
  type CanonicalCommunityRouteStoreService,
} from "../../ports.ts";

export type GetCanonicalCommunityRouteInput = Readonly<{
  readonly path_segment: string;
}>;

export type GetCanonicalCommunityRouteDocument = Schema.Schema.Type<
  typeof GetCanonicalCommunityRoute.response
>;

export type GetCanonicalCommunityRouteServices = Readonly<{
  readonly canonicalCommunityRouteStore: CanonicalCommunityRouteStoreService;
}>;

const validPathInput = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");

export const getCanonicalCommunityRoute = Effect.fn("getCanonicalCommunityRoute")(function* (
  input: GetCanonicalCommunityRouteInput,
  services: GetCanonicalCommunityRouteServices,
): Effect.fn.Return<GetCanonicalCommunityRouteDocument, BadRequest | InternalError | NotFound> {
  if (!validPathInput(input.path_segment)) {
    return yield* new BadRequest({ message: "Invalid canonical community route" });
  }

  const parsed = parseCommunityPathSegment(input.path_segment);
  if (parsed.kind === "rejected") {
    return yield* new BadRequest({ message: "Invalid canonical community route" });
  }

  const resolved = yield* services.canonicalCommunityRouteStore
    .resolveCanonicalRoute({ path_segment: input.path_segment })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CanonicalCommunityRouteRepositoryError && error.reason === "invalid-path"
          ? new BadRequest({ message: "Invalid canonical community route" })
          : new InternalError({ message: "Canonical community route lookup failed" }),
      ),
    );
  if (resolved === null) return yield* new NotFound({ message: "Community not found" });

  let document: GetCanonicalCommunityRouteDocument;
  try {
    document = decodeCommunityPathResolution(resolved);
  } catch {
    return yield* new InternalError({ message: "Canonical community route lookup failed" });
  }

  if (parsed.value.kind === "community_id") {
    if (
      !("authority_version" in document) ||
      document.authority_version !== "optional_route_v2" ||
      document.community_id !== parsed.value.community_id ||
      document.href !== parsed.value.href
    ) {
      return yield* new InternalError({ message: "Canonical community route lookup failed" });
    }
    return document;
  }
  if ("authority_version" in document) {
    return yield* new InternalError({ message: "Canonical community route lookup failed" });
  }
  const route = document.canonical_route;
  if (
    route.family !== parsed.value.route.family ||
    route.root_label !== parsed.value.route.root_label ||
    route.root_label_display !== parsed.value.route.root_label_display ||
    route.path_segment !== parsed.value.route.path_segment ||
    route.href !== parsed.value.route.href ||
    (route.family === "spaces" && route.app_host !== null) ||
    (route.family === "hns" &&
      route.app_host !== null &&
      route.app_host !== `app.${route.root_label}`)
  ) {
    return yield* new InternalError({ message: "Canonical community route lookup failed" });
  }

  return document;
});
