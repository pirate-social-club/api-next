import type { HnsCommunityAppGatewayComposition } from "./community-composition.ts";
import type { HnsCommunityAppGatewayService } from "./community-service.ts";
import type { HnsCommunityHandleGatewayComposition } from "./handle-composition.ts";
import type { HnsCommunityHandleGatewayService } from "./handle-service.ts";
import type { HnsStaticPlatformGatewayRequest } from "./request.ts";

export type HnsCommunityAppHandleGatewayService = Readonly<{
  handle: (request: HnsStaticPlatformGatewayRequest) => Promise<Response>;
}>;

export type HnsCommunityAppHandleGatewayComposition =
  | Readonly<{ enabled: false; service: null }>
  | Readonly<{ enabled: true; service: HnsCommunityAppHandleGatewayService }>;

const disabledComposition: HnsCommunityAppHandleGatewayComposition = Object.freeze({
  enabled: false,
  service: null,
});

function singleHeader(
  fields: HnsStaticPlatformGatewayRequest["header_fields"],
  name: string,
): string | null {
  const values = fields
    .filter(([candidate]) => candidate.toLowerCase() === name)
    .map(([, value]) => value);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function selectsCommunityApp(request: HnsStaticPlatformGatewayRequest): boolean {
  const authority = singleHeader(request.header_fields, "host");
  if (authority === null || authority.length === 0 || authority !== authority.toLowerCase()) {
    return false;
  }
  const withoutPort = authority.endsWith(":443") ? authority.slice(0, -4) : authority;
  const labels = withoutPort.split(".");
  return labels.length === 2 && labels[0] === "app";
}

export function makeHnsCommunityAppHandleGatewayComposition(
  enabled: boolean,
  dependencies: Readonly<{
    community_app?: HnsCommunityAppGatewayComposition;
    handle_host?: HnsCommunityHandleGatewayComposition;
  }> = {},
): HnsCommunityAppHandleGatewayComposition {
  if (!enabled) return disabledComposition;
  if (!dependencies.community_app?.enabled || !dependencies.handle_host?.enabled) {
    throw new Error("HNS community app-handle gateway composition is incomplete or invalid");
  }
  const communityService: HnsCommunityAppGatewayService = dependencies.community_app.service;
  const handleService: HnsCommunityHandleGatewayService = dependencies.handle_host.service;
  return Object.freeze({
    enabled: true,
    service: Object.freeze({
      handle: (request: HnsStaticPlatformGatewayRequest) =>
        (selectsCommunityApp(request) ? communityService : handleService).handle(request),
    }),
  });
}
