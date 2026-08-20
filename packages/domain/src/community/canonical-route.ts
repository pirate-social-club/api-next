import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

export const COMMUNITY_NAMESPACE_REQUIREMENT_VERSION =
  "community-namespace-requirement-v1" as const;
export const COMMUNITY_ROUTE_ROOT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const COMMUNITY_ROUTE_ROOT_MAX_BYTES = 63;

export type CommunityRouteFamily = "hns" | "spaces";

export type CommunityRouteRequest = Readonly<{
  readonly family: CommunityRouteFamily;
  readonly root_label: string;
}>;

export type CommunityRouteIdentity = Readonly<{
  readonly family: CommunityRouteFamily;
  readonly root_label: string;
  readonly path_segment: string;
  readonly href: string;
}>;

export type CommunityCanonicalRoute =
  | Readonly<CommunityRouteIdentity & { readonly family: "hns"; readonly app_host: string | null }>
  | Readonly<CommunityRouteIdentity & { readonly family: "spaces"; readonly app_host: null }>;

export type CommunityRouteRejection =
  | "invalid_family"
  | "invalid_root_label"
  | "invalid_path_segment";

export type CommunityRouteResult<T> =
  | Readonly<{ readonly kind: "accepted"; readonly value: T }>
  | Readonly<{ readonly kind: "rejected"; readonly reason: CommunityRouteRejection }>;

function accepted<T>(value: T): CommunityRouteResult<T> {
  return { kind: "accepted", value };
}

function rejected<T>(reason: CommunityRouteRejection): CommunityRouteResult<T> {
  return { kind: "rejected", reason };
}

export function validCommunityRouteRoot(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= COMMUNITY_ROUTE_ROOT_MAX_BYTES &&
    COMMUNITY_ROUTE_ROOT_PATTERN.test(value)
  );
}

export function deriveCommunityRoute(
  input: Readonly<{ readonly family: unknown; readonly root_label: unknown }>,
): CommunityRouteResult<CommunityRouteIdentity> {
  if (input.family !== "hns" && input.family !== "spaces") {
    return rejected("invalid_family");
  }
  if (typeof input.root_label !== "string" || !validCommunityRouteRoot(input.root_label)) {
    return rejected("invalid_root_label");
  }
  const pathSegment = input.family === "hns" ? `app.${input.root_label}` : `@${input.root_label}`;
  return accepted({
    family: input.family,
    root_label: input.root_label,
    path_segment: pathSegment,
    href: `/c/${pathSegment}`,
  });
}

export function parseCommunityRoutePathSegment(
  pathSegment: string,
): CommunityRouteResult<CommunityRouteIdentity> {
  if (pathSegment.startsWith("app.")) {
    const root = pathSegment.slice(4);
    const route = deriveCommunityRoute({ family: "hns", root_label: root });
    return route.kind === "accepted" && route.value.path_segment === pathSegment
      ? route
      : rejected("invalid_path_segment");
  }
  if (pathSegment.startsWith("@")) {
    const root = pathSegment.slice(1);
    const route = deriveCommunityRoute({ family: "spaces", root_label: root });
    return route.kind === "accepted" && route.value.path_segment === pathSegment
      ? route
      : rejected("invalid_path_segment");
  }
  return rejected("invalid_path_segment");
}

export function canonicalRouteView(
  route: CommunityRouteIdentity,
  hnsAppHostEnabled: boolean,
): CommunityCanonicalRoute {
  return route.family === "hns"
    ? { ...route, family: "hns", app_host: hnsAppHostEnabled ? route.path_segment : null }
    : { ...route, family: "spaces", app_host: null };
}

export function communityNamespaceRequirementPreimage(
  request: CommunityRouteRequest,
): CommunityRouteResult<string> {
  const result = deriveCommunityRoute(request);
  if (result.kind === "rejected") return result;
  return accepted(
    canonicalJson({
      family: result.value.family,
      path_segment: result.value.path_segment,
      root_label: result.value.root_label,
      version: COMMUNITY_NAMESPACE_REQUIREMENT_VERSION,
    }),
  );
}

export function communityNamespaceRequirementHash(
  request: CommunityRouteRequest,
): CommunityRouteResult<string> {
  const preimage = communityNamespaceRequirementPreimage(request);
  return preimage.kind === "accepted" ? accepted(sha256Hex(preimage.value)) : preimage;
}
