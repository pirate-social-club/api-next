import {
  decodeHnsCommunityAppInteractiveGatewayProfileV2,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
} from "@pirate/application/hns-community-app-gateway";
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
  type HnsCommunityAppGatewayFetch,
  type HnsCommunityAppGatewayService,
  makeHnsCommunityAppGatewayService,
} from "./community-service.ts";

export type HnsCommunityAppGatewayComposition =
  | Readonly<{ enabled: false; service: null }>
  | Readonly<{ enabled: true; service: HnsCommunityAppGatewayService }>;

export type HnsCommunityAppGatewayCompositionDependencies = Readonly<{
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
  upstream_fetch?: HnsCommunityAppGatewayFetch;
}>;

const disabledComposition: HnsCommunityAppGatewayComposition = Object.freeze({
  enabled: false,
  service: null,
});
const deploymentReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const accessCredentialMaximumBytes = 4_096;
const encoder = new TextEncoder();

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

function validAccessCredential(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    encoder.encode(value).byteLength <= accessCredentialMaximumBytes &&
    !containsControlCharacter(value)
  );
}

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

export function makeHnsCommunityAppGatewayComposition(
  enabled: boolean,
  dependencies: HnsCommunityAppGatewayCompositionDependencies = {},
): HnsCommunityAppGatewayComposition {
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
    !validAccessCredential(solidAccessClientId) ||
    !validAccessCredential(solidAccessClientSecret) ||
    forwarderLimits.max_body_bytes !== HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11]
  ) {
    throw new Error("HNS community app gateway composition is incomplete or invalid");
  }
  try {
    decodeHnsCommunityAppInteractiveGatewayProfileV2(profileBytes);
  } catch {
    throw new Error("HNS community app gateway composition is incomplete or invalid");
  }
  const solidOrigin = exactHttpsOrigin(solidOriginValue);
  if (solidOrigin === null) {
    throw new Error("HNS community app gateway composition is incomplete or invalid");
  }

  const deploymentBoundAuthoritySource: HnsForwarderGatewayAuthoritySourceV1 = Object.freeze({
    resolve: (normalizedHost) =>
      authoritySource.resolve(normalizedHost).pipe(
        Effect.map((state) => {
          if (
            state === null ||
            state.variant !== "community_app_v1" ||
            state.activation_gateway_deployment_reference !== deploymentReference ||
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
    service: makeHnsCommunityAppGatewayService({
      signer,
      gateway_deployment_reference: deploymentReference,
      solid_origin: solidOrigin,
      solid_access_client_id: solidAccessClientId,
      solid_access_client_secret: solidAccessClientSecret,
      upstream_fetch: upstreamFetch,
    }),
  });
}

export const disabledProductionHnsCommunityAppGatewayComposition =
  makeHnsCommunityAppGatewayComposition(false);
