import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { CurrentCommunityResourceV2 } from "./community-creation.ts";
import {
  CommunityCanonicalRouteV2,
  CommunityRouteContractParseOptions,
} from "./community-routes.ts";
import { endpoint } from "./endpoint.ts";
import { BadRequest, InternalError, NotFound } from "./errors.ts";

export const CanonicalCommunityRoutePathV1 = Schema.Struct({
  path_segment: Schema.String,
});
export type CanonicalCommunityRoutePathV1 = Schema.Schema.Type<
  typeof CanonicalCommunityRoutePathV1
>;

export const CanonicalCommunityRouteResolutionV2 = Schema.Struct({
  community_id: Schema.NonEmptyString,
  canonical_route: CommunityCanonicalRouteV2,
});
export type CanonicalCommunityRouteResolutionV2 = Schema.Schema.Type<
  typeof CanonicalCommunityRouteResolutionV2
>;

export const decodeCanonicalCommunityRouteResolutionV2 = Schema.decodeUnknownSync(
  CanonicalCommunityRouteResolutionV2,
  CommunityRouteContractParseOptions,
);

export const CommunityPathResolution = Schema.Union([
  CurrentCommunityResourceV2,
  CanonicalCommunityRouteResolutionV2,
]);
export type CommunityPathResolution = Schema.Schema.Type<typeof CommunityPathResolution>;

export const decodeCommunityPathResolution = Schema.decodeUnknownSync(
  CommunityPathResolution,
  CommunityRouteContractParseOptions,
);

/** Resolve only the exact, server-issued canonical route path. */
export const GetCanonicalCommunityRoute = endpoint({
  method: "GET",
  path: "/c/:path_segment",
  auth: Auth.public(),
  request: {
    path: CanonicalCommunityRoutePathV1,
    exactRawPathParameters: ["path_segment"],
  },
  response: CommunityPathResolution,
  successStatus: 200,
  errors: [BadRequest, InternalError, NotFound],
} as const);
