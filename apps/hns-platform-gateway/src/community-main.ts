import { isAbsolute, join, resolve } from "node:path";
import {
  encodeHnsCommunityAppInteractiveGatewayProfileV2,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
  verifyHnsCommunityAppInteractiveGatewayProfileV2,
} from "@pirate/application/hns-community-app-gateway";
import {
  type HnsCommunityAppGatewayPostgresAuthorityV1,
  makePostgresHnsCommunityAppGatewayAuthorityV1,
} from "@pirate/platform-cf/hns-community-app-gateway-authority-postgres";
import { makeHnsCommunityAppGatewayComposition } from "./community-composition.ts";
import {
  HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES,
  HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS,
  HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS,
  HNS_COMMUNITY_APP_GATEWAY_STAGING_SHADOW_LISTENERS,
  type HnsCommunityAppGatewayDeploymentMode,
  type HnsCommunityAppGatewayRuntimeConfigurationV1,
  loadHnsCommunityAppGatewayRuntimeConfigurationV1,
} from "./community-runtime-config.ts";
import { startHnsCommunityAppGatewayServer } from "./server.ts";

declare const __PIRATE_API_NEXT_SOURCE_COMMIT__: string;

export type HnsCommunityAppGatewayMode = HnsCommunityAppGatewayDeploymentMode;

export type HnsCommunityAppGatewayArguments = Readonly<{
  mode: HnsCommunityAppGatewayMode;
  manifest_path: string;
}>;

export type HnsCommunityAppGatewayRuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> | Response;

const sourceCommitPattern = /^[0-9a-f]{40}$/u;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

export function parseHnsCommunityAppGatewayArguments(
  arguments_: readonly string[],
): HnsCommunityAppGatewayArguments {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--mode" ||
    (arguments_[1] !== "production" &&
      arguments_[1] !== "shadow" &&
      arguments_[1] !== "staging-shadow") ||
    arguments_[2] !== "--manifest" ||
    arguments_[3] === undefined ||
    !isAbsolute(arguments_[3]) ||
    arguments_[3] !== resolve(arguments_[3]) ||
    containsControlCharacter(arguments_[3])
  ) {
    throw new Error("HNS community app gateway arguments are invalid");
  }
  return { mode: arguments_[1], manifest_path: arguments_[3] };
}

export function embeddedApiNextSourceCommit(): string {
  if (
    typeof __PIRATE_API_NEXT_SOURCE_COMMIT__ !== "string" ||
    !sourceCommitPattern.test(__PIRATE_API_NEXT_SOURCE_COMMIT__)
  ) {
    throw new Error("HNS community app gateway build provenance is invalid");
  }
  return __PIRATE_API_NEXT_SOURCE_COMMIT__;
}

export function listenersForMode(mode: HnsCommunityAppGatewayMode) {
  if (mode === "production") return HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS;
  if (mode === "shadow") return HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS;
  return HNS_COMMUNITY_APP_GATEWAY_STAGING_SHADOW_LISTENERS;
}

function cryptographicNonceSource() {
  return Object.freeze({
    next: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  });
}

async function authorityReady(
  authority: HnsCommunityAppGatewayPostgresAuthorityV1,
  deadlineMilliseconds: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMilliseconds);
  try {
    return await authority.ready(controller.signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function solidReady(
  configuration: HnsCommunityAppGatewayRuntimeConfigurationV1,
  fetchImpl: HnsCommunityAppGatewayRuntimeFetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    configuration.manifest.private_authority_deadline_milliseconds,
  );
  try {
    const response = await fetchImpl(`${configuration.manifest.solid_origin}/`, {
      method: "HEAD",
      headers: {
        "cf-access-client-id": configuration.solid_access_client_id,
        "cf-access-client-secret": configuration.solid_access_client_secret,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return (
      response.status >= 200 &&
      response.status < 500 &&
      response.status !== 401 &&
      response.status !== 403 &&
      (response.status < 300 || response.status >= 400)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function assembleHnsCommunityAppGatewayRuntime(input: {
  configuration: HnsCommunityAppGatewayRuntimeConfigurationV1;
  fetch_impl?: HnsCommunityAppGatewayRuntimeFetch;
  authority_factory?: (databaseUrl: string) => HnsCommunityAppGatewayPostgresAuthorityV1;
}) {
  const fetchImpl = input.fetch_impl ?? ((request, init) => fetch(request, init));
  const authority = (input.authority_factory ?? makePostgresHnsCommunityAppGatewayAuthorityV1)(
    input.configuration.authority_database_url,
  );
  const composition = makeHnsCommunityAppGatewayComposition(true, {
    profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV2(),
    gateway_deployment_reference: input.configuration.gateway_deployment_reference,
    solid_origin: input.configuration.manifest.solid_origin,
    solid_access_client_id: input.configuration.solid_access_client_id,
    solid_access_client_secret: input.configuration.solid_access_client_secret,
    authority_source: authority.authority_source,
    key_registry: input.configuration.key_registry,
    clock: Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) }),
    nonce_source: cryptographicNonceSource(),
    forwarder_limits: input.configuration.forwarder_limits,
    upstream_fetch: (request) => fetchImpl(request),
  });
  return Object.freeze({
    composition,
    ready: async () =>
      (await authorityReady(
        authority,
        input.configuration.manifest.private_authority_deadline_milliseconds,
      )) && (await solidReady(input.configuration, fetchImpl)),
  });
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size === 0 || file.size > maximumBytes) {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
  return new Uint8Array(await file.arrayBuffer());
}

function credentialReader(directory: string) {
  if (!isAbsolute(directory) || directory !== resolve(directory)) {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
  return async (name: string) => {
    const path = join(directory, name);
    if (resolve(path) !== path) {
      throw new Error("HNS community app gateway configuration is incomplete or invalid");
    }
    return readBoundedFile(path, 65_536);
  };
}

async function runHnsCommunityAppGateway(arguments_: readonly string[]): Promise<void> {
  const argumentsValue = parseHnsCommunityAppGatewayArguments(arguments_);
  await verifyHnsCommunityAppInteractiveGatewayProfileV2();
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (credentialsDirectory === undefined) {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
  const configuration = await loadHnsCommunityAppGatewayRuntimeConfigurationV1({
    mode: argumentsValue.mode,
    manifest_bytes: await readBoundedFile(
      argumentsValue.manifest_path,
      HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES,
    ),
    bundle_bytes: await readBoundedFile(import.meta.path, 16_777_216),
    api_next_source_commit: embeddedApiNextSourceCommit(),
    read_credential: credentialReader(credentialsDirectory),
  });
  const runtime = assembleHnsCommunityAppGatewayRuntime({ configuration });
  const server = await startHnsCommunityAppGatewayServer({
    composition: runtime.composition,
    ...listenersForMode(argumentsValue.mode),
    ready: runtime.ready,
  });

  console.log(
    JSON.stringify({
      event: "hns_community_app_gateway_started",
      mode: argumentsValue.mode,
      profile_sha256: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
      gateway_deployment_reference: configuration.gateway_deployment_reference,
      gateway_listener: server.gateway_address,
      health_listener: server.health_address,
    }),
  );

  await new Promise<void>((resolveSignal) => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
  await server.stop();
}

if (import.meta.main) {
  runHnsCommunityAppGateway(process.argv.slice(2)).catch(() => {
    console.error(
      JSON.stringify({
        event: "hns_community_app_gateway_start_failed",
        reason: "configuration_or_listener_failure",
      }),
    );
    process.exitCode = 1;
  });
}
