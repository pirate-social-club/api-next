import {
  decodeHnsCommunityHandlePersonaGatewayProfileV1,
  HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE,
} from "@pirate/application/hns-community-handle-gateway";
import type { HnsForwarderGatewayAuthoritySourceV1 } from "@pirate/application/hns-host-serving";
import {
  type HnsForwarderClockV1,
  type HnsForwarderKeyRegistryV1,
  type HnsForwarderNonceSourceV1,
  type HnsForwarderRuntimeLimitsV1,
  makeHnsForwarderV3Gateway,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  type HnsCommunityHandleGatewayFetch,
  type HnsCommunityHandleGatewayService,
  makeHnsCommunityHandleGatewayService,
} from "./handle-service.ts";

export type HnsCommunityHandleGatewayComposition =
  | Readonly<{ enabled: false; service: null }>
  | Readonly<{ enabled: true; service: HnsCommunityHandleGatewayService }>;

export type HnsCommunityHandleGatewayCompositionDependencies = Readonly<{
  profile_bytes?: Uint8Array;
  gateway_deployment_reference?: string;
  solid_origin?: string;
  solid_access_client_id?: string;
  solid_access_client_secret?: string;
  authority_source?: HnsForwarderGatewayAuthoritySourceV1;
  key_registry?: HnsForwarderKeyRegistryV1;
  clock?: HnsForwarderClockV1;
  nonce_source?: HnsForwarderNonceSourceV1;
  forwarder_limits?: HnsForwarderRuntimeLimitsV1;
  upstream_fetch?: HnsCommunityHandleGatewayFetch;
}>;

const disabledComposition: HnsCommunityHandleGatewayComposition = Object.freeze({
  enabled: false,
  service: null,
});
const deploymentReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const accessCredentialPattern = /^[\x21-\x7e]{1,4096}$/u;

function exactHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      value !== parsed.origin
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function makeHnsCommunityHandleGatewayComposition(
  enabled: boolean,
  dependencies: HnsCommunityHandleGatewayCompositionDependencies = {},
): HnsCommunityHandleGatewayComposition {
  if (!enabled) return disabledComposition;
  const {
    profile_bytes: profileBytes,
    gateway_deployment_reference: deploymentReference,
    solid_origin: solidOriginValue,
    solid_access_client_id: solidAccessClientId,
    solid_access_client_secret: solidAccessClientSecret,
    authority_source: authoritySource,
    key_registry: keyRegistry,
    clock,
    nonce_source: nonceSource,
    forwarder_limits: forwarderLimits,
    upstream_fetch: upstreamFetch,
  } = dependencies;
  if (
    profileBytes === undefined ||
    deploymentReference === undefined ||
    solidOriginValue === undefined ||
    solidAccessClientId === undefined ||
    solidAccessClientSecret === undefined ||
    authoritySource === undefined ||
    keyRegistry === undefined ||
    clock === undefined ||
    nonceSource === undefined ||
    forwarderLimits === undefined ||
    upstreamFetch === undefined ||
    !deploymentReferencePattern.test(deploymentReference) ||
    !accessCredentialPattern.test(solidAccessClientId) ||
    !accessCredentialPattern.test(solidAccessClientSecret) ||
    forwarderLimits.max_body_bytes !== HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[12]
  ) {
    throw new Error("HNS community handle gateway composition is incomplete or invalid");
  }
  try {
    decodeHnsCommunityHandlePersonaGatewayProfileV1(profileBytes);
  } catch {
    throw new Error("HNS community handle gateway composition is incomplete or invalid");
  }
  const solidOrigin = exactHttpsOrigin(solidOriginValue);
  if (solidOrigin === null) {
    throw new Error("HNS community handle gateway composition is incomplete or invalid");
  }
  const deploymentBoundAuthoritySource: HnsForwarderGatewayAuthoritySourceV1 = Object.freeze({
    resolve: (normalizedHost) =>
      authoritySource.resolve(normalizedHost).pipe(
        Effect.map((state) => {
          if (
            state === null ||
            state.variant !== "handle_persona_v1" ||
            state.fulfillment_kind !== "hosted_persona_v1" ||
            state.sale_namespace_gateway_deployment_reference !== deploymentReference ||
            state.dns_zone.gateway_deployment_reference !== deploymentReference
          ) {
            return null;
          }
          return state;
        }),
      ),
  });
  const signer = makeHnsForwarderV3Gateway({
    authority_source: deploymentBoundAuthoritySource,
    key_registry: keyRegistry,
    clock,
    nonce_source: nonceSource,
    limits: forwarderLimits,
  });
  return Object.freeze({
    enabled: true,
    service: makeHnsCommunityHandleGatewayService({
      signer,
      gateway_deployment_reference: deploymentReference,
      solid_origin: solidOrigin,
      solid_access_client_id: solidAccessClientId,
      solid_access_client_secret: solidAccessClientSecret,
      upstream_fetch: upstreamFetch,
    }),
  });
}

export const disabledProductionHnsCommunityHandleGatewayComposition =
  makeHnsCommunityHandleGatewayComposition(false);
