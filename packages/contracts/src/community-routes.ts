import {
  canonicalRouteLabelMatchesV1,
  parseCanonicalRouteLabelV1,
  validRouteLabelDisplayV1,
  validRouteLabelInputV1,
} from "@pirate/route-label-codec";
import { Schema } from "effect";

export const CommunityRouteFamilyV1 = Schema.Literals(["hns", "spaces"]);
export type CommunityRouteFamilyV1 = Schema.Schema.Type<typeof CommunityRouteFamilyV1>;

export const CommunityRouteRootLabelV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    validRouteLabelInputV1(value)
      ? undefined
      : "Expected a bounded route-root input without route syntax or edge whitespace",
  ),
);
export type CommunityRouteRootLabelV1 = Schema.Schema.Type<typeof CommunityRouteRootLabelV1>;

export const CommunityRouteRequestV1 = Schema.Struct({
  family: CommunityRouteFamilyV1,
  root_label: CommunityRouteRootLabelV1,
});
export type CommunityRouteRequestV1 = Schema.Schema.Type<typeof CommunityRouteRequestV1>;

const HnsCanonicalRootLabelV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    parseCanonicalRouteLabelV1("hns", value).kind === "accepted"
      ? undefined
      : "Expected a canonical HNS ASCII root within 63 bytes",
  ),
);

const SpacesCanonicalRootLabelV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    parseCanonicalRouteLabelV1("spaces", value).kind === "accepted"
      ? undefined
      : "Expected a canonical Spaces ASCII root within 62 bytes",
  ),
);

const CommunityRouteRootLabelDisplayV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    validRouteLabelDisplayV1(value) ? undefined : "Expected a bounded NFC route-root display value",
  ),
);

const SameOriginCommunityHref = Schema.String.check(
  Schema.makeFilter((value) =>
    value.startsWith("/c/") ? undefined : "Expected a same-origin canonical community path",
  ),
);

const HnsCanonicalRouteV1 = Schema.Struct({
  family: Schema.Literal("hns"),
  root_label: HnsCanonicalRootLabelV1,
  root_label_display: CommunityRouteRootLabelDisplayV1,
  path_segment: Schema.String,
  href: SameOriginCommunityHref,
  app_host: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((route) => {
    const expected = `app.${route.root_label}`;
    return canonicalRouteLabelMatchesV1("hns", route.root_label, route.root_label_display) &&
      route.path_segment === expected &&
      route.href === `/c/${expected}` &&
      (route.app_host === null || route.app_host === expected)
      ? undefined
      : "HNS canonical route fields must be server-derived from the root";
  }),
);

const HnsCanonicalRouteV2 = Schema.Struct({
  family: Schema.Literal("hns"),
  root_label: HnsCanonicalRootLabelV1,
  root_label_display: CommunityRouteRootLabelDisplayV1,
  path_segment: Schema.String,
  href: SameOriginCommunityHref,
  app_host: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((route) => {
    const expectedHost = `app.${route.root_label}`;
    return canonicalRouteLabelMatchesV1("hns", route.root_label, route.root_label_display) &&
      route.root_label !== "pirate" &&
      !/^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        route.root_label,
      ) &&
      route.path_segment === route.root_label &&
      route.href === `/c/${route.root_label}` &&
      (route.app_host === null || route.app_host === expectedHost)
      ? undefined
      : "HNS public route v2 fields must be server-derived from an eligible root";
  }),
);

const SpacesCanonicalRouteV1 = Schema.Struct({
  family: Schema.Literal("spaces"),
  root_label: SpacesCanonicalRootLabelV1,
  root_label_display: CommunityRouteRootLabelDisplayV1,
  path_segment: Schema.String,
  href: SameOriginCommunityHref,
  app_host: Schema.Null,
}).check(
  Schema.makeFilter((route) => {
    const expected = `@${route.root_label}`;
    return canonicalRouteLabelMatchesV1("spaces", route.root_label, route.root_label_display) &&
      route.path_segment === expected &&
      route.href === `/c/${expected}`
      ? undefined
      : "Spaces canonical route fields must be server-derived from the root";
  }),
);

export const CommunityCanonicalRouteV1 = Schema.Union([
  HnsCanonicalRouteV1,
  SpacesCanonicalRouteV1,
]);
export type CommunityCanonicalRouteV1 = Schema.Schema.Type<typeof CommunityCanonicalRouteV1>;

export const CommunityCanonicalRouteV2 = Schema.Union([
  HnsCanonicalRouteV2,
  SpacesCanonicalRouteV1,
]);
export type CommunityCanonicalRouteV2 = Schema.Schema.Type<typeof CommunityCanonicalRouteV2>;

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

export const decodeCommunityCanonicalRouteV2 = Schema.decodeUnknownSync(
  CommunityCanonicalRouteV2,
  CommunityRouteContractParseOptions,
);

export const CommunityRouteLifecycleStatusV1 = Schema.Literals(["active", "suspended"]);
export type CommunityRouteLifecycleStatusV1 = Schema.Schema.Type<
  typeof CommunityRouteLifecycleStatusV1
>;
