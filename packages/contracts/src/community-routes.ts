import { Schema } from "effect";

export const CommunityRouteFamilyV1 = Schema.Literals(["hns", "spaces"]);
export type CommunityRouteFamilyV1 = Schema.Schema.Type<typeof CommunityRouteFamilyV1>;

export const CommunityRouteRootLabelV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length >= 1 && value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical lowercase ASCII namespace root of 1–63 bytes",
  ),
);
export type CommunityRouteRootLabelV1 = Schema.Schema.Type<typeof CommunityRouteRootLabelV1>;

export const CommunityRouteRequestV1 = Schema.Struct({
  family: CommunityRouteFamilyV1,
  root_label: CommunityRouteRootLabelV1,
});
export type CommunityRouteRequestV1 = Schema.Schema.Type<typeof CommunityRouteRequestV1>;

const SameOriginCommunityHref = Schema.String.check(
  Schema.makeFilter((value) =>
    value.startsWith("/c/") ? undefined : "Expected a same-origin canonical community path",
  ),
);

const HnsCanonicalRouteV1 = Schema.Struct({
  family: Schema.Literal("hns"),
  root_label: CommunityRouteRootLabelV1,
  path_segment: Schema.String,
  href: SameOriginCommunityHref,
  app_host: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((route) => {
    const expected = `app.${route.root_label}`;
    return route.path_segment === expected &&
      route.href === `/c/${expected}` &&
      (route.app_host === null || route.app_host === expected)
      ? undefined
      : "HNS canonical route fields must be server-derived from the root";
  }),
);

const SpacesCanonicalRouteV1 = Schema.Struct({
  family: Schema.Literal("spaces"),
  root_label: CommunityRouteRootLabelV1,
  path_segment: Schema.String,
  href: SameOriginCommunityHref,
  app_host: Schema.Null,
}).check(
  Schema.makeFilter((route) => {
    const expected = `@${route.root_label}`;
    return route.path_segment === expected && route.href === `/c/${expected}`
      ? undefined
      : "Spaces canonical route fields must be server-derived from the root";
  }),
);

export const CommunityCanonicalRouteV1 = Schema.Union([
  HnsCanonicalRouteV1,
  SpacesCanonicalRouteV1,
]);
export type CommunityCanonicalRouteV1 = Schema.Schema.Type<typeof CommunityCanonicalRouteV1>;

/** Effect Struct strips excess keys by default; wire decoders must use this strict boundary. */
export const CommunityRouteContractParseOptions = { onExcessProperty: "error" } as const;

export const decodeCommunityRouteRequestV1 = Schema.decodeUnknownSync(
  CommunityRouteRequestV1,
  CommunityRouteContractParseOptions,
);

export const decodeCommunityCanonicalRouteV1 = Schema.decodeUnknownSync(
  CommunityCanonicalRouteV1,
  CommunityRouteContractParseOptions,
);

export const CommunityRouteLifecycleStatusV1 = Schema.Literals(["active", "suspended"]);
export type CommunityRouteLifecycleStatusV1 = Schema.Schema.Type<
  typeof CommunityRouteLifecycleStatusV1
>;
