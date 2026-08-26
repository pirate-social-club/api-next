import type { CloudflareAccessJwtValidatorV1 } from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HnsForwarderWorkerAuthoritySourceV1 } from "@pirate/platform-cf/hns-handle-host-api";

export type HnsHandleHostApiComposition =
  | Readonly<{ enabled: false; access_validator: null; authority_source: null }>
  | Readonly<{
      enabled: true;
      access_validator: CloudflareAccessJwtValidatorV1;
      authority_source: HnsForwarderWorkerAuthoritySourceV1;
    }>;

export type HnsHandleHostApiCompositionDependencies = Readonly<{
  access_validator?: CloudflareAccessJwtValidatorV1;
  authority_source?: HnsForwarderWorkerAuthoritySourceV1;
}>;

const disabledComposition: HnsHandleHostApiComposition = Object.freeze({
  enabled: false,
  access_validator: null,
  authority_source: null,
});

export function makeHnsHandleHostApiComposition(
  enabled: boolean,
  dependencies: HnsHandleHostApiCompositionDependencies = {},
): HnsHandleHostApiComposition {
  if (!enabled) return disabledComposition;
  const { access_validator: accessValidator, authority_source: authoritySource } = dependencies;
  if (accessValidator === undefined || authoritySource === undefined) {
    throw new Error("HNS handle-host API composition is incomplete or invalid");
  }
  return Object.freeze({
    enabled: true,
    access_validator: accessValidator,
    authority_source: authoritySource,
  });
}

export const disabledProductionHnsHandleHostApiComposition = makeHnsHandleHostApiComposition(false);
