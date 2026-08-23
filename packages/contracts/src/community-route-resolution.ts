import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { CurrentCommunityResourceV2 } from "./community-creation.ts";
import {
  CommunityCanonicalRouteV1,
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

export const CanonicalCommunityRouteResolutionV1 = Schema.Struct({
  community_id: Schema.NonEmptyString,
  canonical_route: CommunityCanonicalRouteV1,
});
export type CanonicalCommunityRouteResolutionV1 = Schema.Schema.Type<
  typeof CanonicalCommunityRouteResolutionV1
>;

export const decodeCanonicalCommunityRouteResolutionV1 = Schema.decodeUnknownSync(
  CanonicalCommunityRouteResolutionV1,
  CommunityRouteContractParseOptions,
);

export const CommunityPathResolution = Schema.Union([
  CurrentCommunityResourceV2,
  CanonicalCommunityRouteResolutionV1,
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
