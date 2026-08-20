import {
  HNS_ROUTE_ROOT_MAX_BYTES,
  normalizeRouteLabelV1,
  parseCanonicalRouteLabelV1,
  ROUTE_LABEL_CODEC_VERSION,
  ROUTE_LABEL_INPUT_MAX_BYTES,
  SPACES_ROUTE_ROOT_MAX_BYTES,
} from "@pirate/route-label-codec";
import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

export const COMMUNITY_NAMESPACE_REQUIREMENT_VERSION =
  "community-namespace-requirement-v1" as const;
export const COMMUNITY_ROUTE_LABEL_CODEC_VERSION = ROUTE_LABEL_CODEC_VERSION;
export const COMMUNITY_ROUTE_INPUT_MAX_BYTES = ROUTE_LABEL_INPUT_MAX_BYTES;
export const COMMUNITY_HNS_ROUTE_ROOT_MAX_BYTES = HNS_ROUTE_ROOT_MAX_BYTES;
export const COMMUNITY_SPACES_ROUTE_ROOT_MAX_BYTES = SPACES_ROUTE_ROOT_MAX_BYTES;

export type CommunityRouteFamily = "hns" | "spaces";

export type CommunityRouteRequest = Readonly<{
  readonly family: CommunityRouteFamily;
  readonly root_label: string;
}>;

export type CommunityRouteIdentity = Readonly<{
  readonly family: CommunityRouteFamily;
  readonly root_label: string;
  readonly root_label_display: string;
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

function canonicalIdentityFromAce(
  family: CommunityRouteFamily,
  rootLabel: string,
): CommunityRouteResult<CommunityRouteIdentity> {
  const canonical = parseCanonicalRouteLabelV1(family, rootLabel);
  if (canonical.kind === "rejected") return rejected(canonical.reason);

  const pathSegment = family === "hns" ? `app.${rootLabel}` : `@${rootLabel}`;
  return accepted({
    family,
    root_label: rootLabel,
    root_label_display: canonical.value.root_label_display,
    path_segment: pathSegment,
    href: `/c/${pathSegment}`,
  });
}

/** Validates the exact canonical ACE authority used by storage and reads. */
export function validCommunityRouteRoot(family: CommunityRouteFamily, value: string): boolean {
  return parseCanonicalRouteLabelV1(family, value).kind === "accepted";
}

/** Canonicalizes a mutation/preflight request through route-label-codec-v1. */
export function deriveCommunityRoute(
  input: Readonly<{ readonly family: unknown; readonly root_label: unknown }>,
): CommunityRouteResult<CommunityRouteIdentity> {
  if (input.family !== "hns" && input.family !== "spaces") {
    return rejected("invalid_family");
  }
  if (typeof input.root_label !== "string") {
    return rejected("invalid_root_label");
  }

  const canonical = normalizeRouteLabelV1(input.family, input.root_label);
  return canonical.kind === "rejected"
    ? rejected(canonical.reason)
    : canonicalIdentityFromAce(input.family, canonical.value.root_label);
}

/** Parses an already-canonical public path without applying write normalization. */
export function parseCommunityRoutePathSegment(
  pathSegment: string,
): CommunityRouteResult<CommunityRouteIdentity> {
  if (pathSegment.startsWith("app.")) {
    const route = canonicalIdentityFromAce("hns", pathSegment.slice(4));
    return route.kind === "accepted" && route.value.path_segment === pathSegment
      ? route
      : rejected("invalid_path_segment");
  }
  if (pathSegment.startsWith("@")) {
    const route = canonicalIdentityFromAce("spaces", pathSegment.slice(1));
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
      route_label_codec_version: COMMUNITY_ROUTE_LABEL_CODEC_VERSION,
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
