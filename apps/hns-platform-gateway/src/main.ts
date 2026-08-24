import {
  HNS_PLATFORM_CANONICAL_ORIGIN,
  HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256,
  verifyHnsStaticPlatformAppGatewayProfileV1,
} from "@pirate/application/hns-static-platform-app-gateway";
import { makeHnsStaticPlatformGatewayComposition } from "./composition.ts";
import { startHnsStaticPlatformGatewayServer } from "./server.ts";

export type HnsStaticPlatformGatewayMode = "production" | "shadow";

export const HNS_STATIC_PLATFORM_GATEWAY_PRODUCTION_LISTENERS = Object.freeze({
  gateway_host: "127.0.0.1",
  gateway_port: 4049,
  health_host: "127.0.0.1",
  health_port: 4051,
});

export const HNS_STATIC_PLATFORM_GATEWAY_SHADOW_LISTENERS = Object.freeze({
  gateway_host: "127.0.0.1",
  gateway_port: 4149,
  health_host: "127.0.0.1",
  health_port: 4151,
});

export function parseHnsStaticPlatformGatewayMode(
  arguments_: readonly string[],
): HnsStaticPlatformGatewayMode {
  if (arguments_.length !== 2 || arguments_[0] !== "--mode") {
    throw new Error("Expected exactly --mode production or --mode shadow");
  }
  const mode = arguments_[1];
  if (mode !== "production" && mode !== "shadow") {
    throw new Error("Expected exactly --mode production or --mode shadow");
  }
  return mode;
}

function listenersForMode(mode: HnsStaticPlatformGatewayMode) {
  return mode === "production"
    ? HNS_STATIC_PLATFORM_GATEWAY_PRODUCTION_LISTENERS
    : HNS_STATIC_PLATFORM_GATEWAY_SHADOW_LISTENERS;
}

async function originReady(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${HNS_PLATFORM_CANONICAL_ORIGIN}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runHnsStaticPlatformGateway(arguments_: readonly string[]): Promise<void> {
  const mode = parseHnsStaticPlatformGatewayMode(arguments_);
  await verifyHnsStaticPlatformAppGatewayProfileV1();
  const composition = makeHnsStaticPlatformGatewayComposition(true, {
    upstream_fetch: (request) => fetch(request),
  });
  const server = await startHnsStaticPlatformGatewayServer({
    composition,
    ...listenersForMode(mode),
    ready: originReady,
  });

  console.log(
    JSON.stringify({
      event: "hns_static_platform_gateway_started",
      mode,
      profile_sha256: HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256,
      gateway_listener: server.gateway_address,
      health_listener: server.health_address,
    }),
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop();
}

if (import.meta.main) {
  runHnsStaticPlatformGateway(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "hns_static_platform_gateway_start_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    process.exitCode = 1;
  });
}
