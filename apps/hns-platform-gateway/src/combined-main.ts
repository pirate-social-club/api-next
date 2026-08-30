import { isAbsolute, join, resolve } from "node:path";
import {
  encodeHnsCommunityAppInteractiveGatewayProfileV2,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
  verifyHnsCommunityAppInteractiveGatewayProfileV2,
} from "@pirate/application/hns-community-app-gateway";
import {
  encodeHnsCommunityHandlePersonaGatewayProfileV1,
  HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE,
  HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_SHA256,
  verifyHnsCommunityHandlePersonaGatewayProfileV1,
} from "@pirate/application/hns-community-handle-gateway";
import {
  type HnsCommunityAppHandleGatewayPostgresAuthorityV1,
  makePostgresHnsCommunityAppHandleGatewayAuthorityV1,
} from "@pirate/platform-cf/hns-community-app-handle-gateway-authority-postgres";
import { makeHnsCommunityAppHandleGatewayComposition } from "./combined-composition.ts";
import { makeHnsCommunityAppGatewayComposition } from "./community-composition.ts";
import {
  HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES,
  HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS,
  HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS,
  HNS_COMMUNITY_APP_HANDLE_GATEWAY_DEPLOYMENT_SCHEMA,
  type HnsCommunityAppGatewayRuntimeConfigurationV1,
  loadHnsCommunityAppGatewayRuntimeConfigurationV1,
} from "./community-runtime-config.ts";
import { makeHnsCommunityHandleGatewayComposition } from "./handle-composition.ts";
import { startHnsCommunityAppHandleGatewayServer } from "./server.ts";

declare const __PIRATE_API_NEXT_SOURCE_COMMIT__: string;

type HnsCommunityAppHandleGatewayMode = "production" | "shadow";

export type HnsCommunityAppHandleGatewayArguments = Readonly<{
  mode: HnsCommunityAppHandleGatewayMode;
  manifest_path: string;
}>;

export type HnsCommunityAppHandleGatewayRuntimeFetch = (
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

export function parseHnsCommunityAppHandleGatewayArguments(
  arguments_: readonly string[],
): HnsCommunityAppHandleGatewayArguments {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--mode" ||
    (arguments_[1] !== "production" && arguments_[1] !== "shadow") ||
    arguments_[2] !== "--manifest" ||
    arguments_[3] === undefined ||
    !isAbsolute(arguments_[3]) ||
    arguments_[3] !== resolve(arguments_[3]) ||
    containsControlCharacter(arguments_[3])
  ) {
    throw new Error("HNS community app-handle gateway arguments are invalid");
  }
  return { mode: arguments_[1], manifest_path: arguments_[3] };
}

export function embeddedCombinedApiNextSourceCommit(): string {
  if (
    typeof __PIRATE_API_NEXT_SOURCE_COMMIT__ !== "string" ||
    !sourceCommitPattern.test(__PIRATE_API_NEXT_SOURCE_COMMIT__)
  ) {
    throw new Error("HNS community app-handle gateway build provenance is invalid");
  }
  return __PIRATE_API_NEXT_SOURCE_COMMIT__;
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
  authority: HnsCommunityAppHandleGatewayPostgresAuthorityV1,
  deadlineMilliseconds: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMilliseconds);
  try {
    return await authority.ready(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function solidReady(
  configuration: HnsCommunityAppGatewayRuntimeConfigurationV1,
  fetchImpl: HnsCommunityAppHandleGatewayRuntimeFetch,
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

export function assembleHnsCommunityAppHandleGatewayRuntime(input: {
  configuration: HnsCommunityAppGatewayRuntimeConfigurationV1;
  fetch_impl?: HnsCommunityAppHandleGatewayRuntimeFetch;
  authority_factory?: typeof makePostgresHnsCommunityAppHandleGatewayAuthorityV1;
}) {
  if (input.configuration.manifest.schema !== HNS_COMMUNITY_APP_HANDLE_GATEWAY_DEPLOYMENT_SCHEMA) {
    throw new Error("HNS community app-handle gateway configuration is incomplete or invalid");
  }
  const fetchImpl = input.fetch_impl ?? ((request, init) => fetch(request, init));
  const authority = (
    input.authority_factory ?? makePostgresHnsCommunityAppHandleGatewayAuthorityV1
  )(input.configuration.authority_database_url);
  const common = {
    gateway_deployment_reference: input.configuration.gateway_deployment_reference,
    solid_origin: input.configuration.manifest.solid_origin,
    solid_access_client_id: input.configuration.solid_access_client_id,
    solid_access_client_secret: input.configuration.solid_access_client_secret,
    key_registry: input.configuration.key_registry,
    clock: Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) }),
    nonce_source: cryptographicNonceSource(),
    upstream_fetch: (request: Request) => fetchImpl(request),
  } as const;
  const communityApp = makeHnsCommunityAppGatewayComposition(true, {
    ...common,
    profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV2(),
    authority_source: authority.community_authority_source,
    forwarder_limits: input.configuration.forwarder_limits,
  });
  const handleHost = makeHnsCommunityHandleGatewayComposition(true, {
    ...common,
    profile_bytes: encodeHnsCommunityHandlePersonaGatewayProfileV1(),
    authority_source: authority.handle_authority_source,
    forwarder_limits: Object.freeze({
      ...input.configuration.forwarder_limits,
      max_body_bytes: HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[12],
    }),
  });
  return Object.freeze({
    composition: makeHnsCommunityAppHandleGatewayComposition(true, {
      community_app: communityApp,
      handle_host: handleHost,
    }),
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
    throw new Error("HNS community app-handle gateway configuration is incomplete or invalid");
  }
  return new Uint8Array(await file.arrayBuffer());
}

function credentialReader(directory: string) {
  if (!isAbsolute(directory) || directory !== resolve(directory)) {
    throw new Error("HNS community app-handle gateway configuration is incomplete or invalid");
  }
  return async (name: string) => {
    const path = join(directory, name);
    if (resolve(path) !== path) {
      throw new Error("HNS community app-handle gateway configuration is incomplete or invalid");
    }
    return readBoundedFile(path, 65_536);
  };
}

async function runHnsCommunityAppHandleGateway(arguments_: readonly string[]): Promise<void> {
  const argumentsValue = parseHnsCommunityAppHandleGatewayArguments(arguments_);
  await Promise.all([
    verifyHnsCommunityAppInteractiveGatewayProfileV2(),
    verifyHnsCommunityHandlePersonaGatewayProfileV1(),
  ]);
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (credentialsDirectory === undefined) {
    throw new Error("HNS community app-handle gateway configuration is incomplete or invalid");
  }
  const configuration = await loadHnsCommunityAppGatewayRuntimeConfigurationV1({
    mode: argumentsValue.mode,
    manifest_bytes: await readBoundedFile(
      argumentsValue.manifest_path,
      HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES,
    ),
    bundle_bytes: await readBoundedFile(import.meta.path, 16_777_216),
    api_next_source_commit: embeddedCombinedApiNextSourceCommit(),
    read_credential: credentialReader(credentialsDirectory),
  });
  const runtime = assembleHnsCommunityAppHandleGatewayRuntime({ configuration });
  const listeners =
    argumentsValue.mode === "production"
      ? HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS
      : HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS;
  const server = await startHnsCommunityAppHandleGatewayServer({
    composition: runtime.composition,
    ...listeners,
    ready: runtime.ready,
  });

  console.log(
    JSON.stringify({
      event: "hns_community_app_handle_gateway_started",
      mode: argumentsValue.mode,
      community_profile_sha256: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
      handle_profile_sha256: HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_SHA256,
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
  runHnsCommunityAppHandleGateway(process.argv.slice(2)).catch(() => {
    console.error(
      JSON.stringify({
        event: "hns_community_app_handle_gateway_start_failed",
        reason: "configuration_or_listener_failure",
      }),
    );
    process.exitCode = 1;
  });
}
