import {
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_VERSION,
} from "@pirate/application/hns-community-app-gateway";
import {
  type HnsForwarderKeyRegistryV1,
  parseHnsForwarderV3KeyRegistry,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Schema } from "effect";

export const HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_SCHEMA =
  "pirate-hns-community-app-gateway-deployment-v1" as const;
export const HNS_COMMUNITY_APP_GATEWAY_TLS_TERMINATOR_CONTRACT =
  "pirate-hns-community-app-caddy-boundary-v1" as const;
export const HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_SOURCE = "postgres-readonly-v1" as const;
export const HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES = 65_536 as const;

export const HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL =
  "hns-community-authority-database-url" as const;
export const HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL =
  "hns-community-forwarder-key-registry" as const;
export const HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_ID_CREDENTIAL =
  "hns-community-solid-access-client-id" as const;
export const HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL =
  "hns-community-solid-access-client-secret" as const;

export const HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS = Object.freeze({
  gateway_host: "127.0.0.1",
  gateway_port: 4069,
  health_host: "127.0.0.1",
  health_port: 4071,
});

export const HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS = Object.freeze({
  gateway_host: "127.0.0.1",
  gateway_port: 4169,
  health_host: "127.0.0.1",
  health_port: 4171,
});

const Identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
);
const Sha256 = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[0-9a-f]{64}$/u),
);
const Commit = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]{40}$/u),
);
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

const DeploymentManifest = Schema.Struct({
  schema: Schema.Literal(HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_SCHEMA),
  profile_version: Schema.Literal(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_VERSION),
  profile_utf8_bytes: Schema.Literal(622),
  profile_sha256: Schema.Literal(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256),
  production_gateway_listener: Schema.Literal("127.0.0.1:4069"),
  production_health_listener: Schema.Literal("127.0.0.1:4071"),
  shadow_gateway_listener: Schema.Literal("127.0.0.1:4169"),
  shadow_health_listener: Schema.Literal("127.0.0.1:4171"),
  tls_terminator_contract: Schema.Literal(HNS_COMMUNITY_APP_GATEWAY_TLS_TERMINATOR_CONTRACT),
  solid_origin: Schema.String,
  solid_ingress_composition_reference: Identity,
  solid_access_application_audience: Identity,
  solid_access_client_id_credential: Schema.Literal(
    HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_ID_CREDENTIAL,
  ),
  solid_access_client_secret_credential: Schema.Literal(
    HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL,
  ),
  authority_source: Schema.Literal(HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_SOURCE),
  authority_database_endpoint: Schema.String,
  authority_database_url_credential: Schema.Literal(
    HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL,
  ),
  forwarder_key_registry_reference: Identity,
  forwarder_key_registry_version: Identity,
  forwarder_key_registry_credential: Schema.Literal(
    HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL,
  ),
  forwarder_freshness_window_seconds: PositiveInteger,
  forwarder_future_clock_skew_seconds: NonNegativeInteger,
  maximum_origin_form_target_bytes: Schema.Literal(8_192),
  maximum_request_field_count: Schema.Literal(128),
  maximum_request_header_bytes: Schema.Literal(32_768),
  maximum_request_body_bytes: Schema.Literal(1_048_576),
  maximum_sensitive_cookie_value_bytes: Schema.Literal(16_384),
  maximum_buffered_response_bytes: Schema.Literal(16_777_216),
  gateway_upstream_deadline_milliseconds: Schema.Literal(15_000),
  maximum_private_authority_bytes: Schema.Literal(4_096),
  private_authority_deadline_milliseconds: Schema.Literal(2_000),
  gateway_certificate_spki_sha256: Sha256,
  api_next_source_commit: Commit,
  bundle_sha256: Sha256,
});

export type HnsCommunityAppGatewayDeploymentManifestV1 = Schema.Schema.Type<
  typeof DeploymentManifest
>;

export type HnsCommunityAppGatewayRuntimeConfigurationV1 = Readonly<{
  manifest: HnsCommunityAppGatewayDeploymentManifestV1;
  gateway_deployment_reference: string;
  authority_database_url: string;
  solid_access_client_id: string;
  solid_access_client_secret: string;
  key_registry: HnsForwarderKeyRegistryV1;
  forwarder_limits: Readonly<{
    max_body_bytes: number;
    freshness_window_seconds: number;
    future_clock_skew_seconds: number;
  }>;
}>;

const manifestKeys = Object.freeze([
  "schema",
  "profile_version",
  "profile_utf8_bytes",
  "profile_sha256",
  "production_gateway_listener",
  "production_health_listener",
  "shadow_gateway_listener",
  "shadow_health_listener",
  "tls_terminator_contract",
  "solid_origin",
  "solid_ingress_composition_reference",
  "solid_access_application_audience",
  "solid_access_client_id_credential",
  "solid_access_client_secret_credential",
  "authority_source",
  "authority_database_endpoint",
  "authority_database_url_credential",
  "forwarder_key_registry_reference",
  "forwarder_key_registry_version",
  "forwarder_key_registry_credential",
  "forwarder_freshness_window_seconds",
  "forwarder_future_clock_skew_seconds",
  "maximum_origin_form_target_bytes",
  "maximum_request_field_count",
  "maximum_request_header_bytes",
  "maximum_request_body_bytes",
  "maximum_sensitive_cookie_value_bytes",
  "maximum_buffered_response_bytes",
  "gateway_upstream_deadline_milliseconds",
  "maximum_private_authority_bytes",
  "private_authority_deadline_milliseconds",
  "gateway_certificate_spki_sha256",
  "api_next_source_commit",
  "bundle_sha256",
] as const);

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

function strictCredentialText(bytes: Uint8Array, maximumBytes: number): string {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error("invalid size");
    const value = decoder.decode(bytes);
    if (value !== value.trim() || containsControlCharacter(value)) {
      throw new Error("invalid value");
    }
    return value;
  } catch {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
}

function exactAuthorityDatabaseEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "postgresql:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname === "" ||
      parsed.pathname.length <= 1 ||
      parsed.hash !== "" ||
      parsed.searchParams.size !== 1 ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      parsed.toString() !== value
    ) {
      throw new Error("invalid database URL");
    }
    return value;
  } catch {
    return null;
  }
}

function strictAuthorityDatabaseUrl(value: string, expectedEndpoint: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "postgresql:" ||
      parsed.username === "" ||
      parsed.password === "" ||
      parsed.hostname === "" ||
      parsed.pathname.length <= 1 ||
      parsed.hash !== "" ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      parsed.searchParams.has("options")
    ) {
      throw new Error("invalid database URL");
    }
    parsed.username = "";
    parsed.password = "";
    if (parsed.toString() !== expectedEndpoint) throw new Error("database endpoint mismatch");
    return value;
  } catch {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeManifest(bytes: Uint8Array): HnsCommunityAppGatewayDeploymentManifestV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > HNS_COMMUNITY_APP_GATEWAY_MANIFEST_MAX_BYTES) {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
  try {
    const text = decoder.decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (!exactObjectKeys(raw, manifestKeys) || JSON.stringify(raw) !== text) {
      throw new Error("noncanonical manifest");
    }
    const manifest = Schema.decodeUnknownSync(DeploymentManifest)(raw);
    if (
      !exactHttpsOrigin(manifest.solid_origin) ||
      exactAuthorityDatabaseEndpoint(manifest.authority_database_endpoint) === null
    ) {
      throw new Error("invalid source-closed endpoint");
    }
    return manifest;
  } catch {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }
}

export async function loadHnsCommunityAppGatewayRuntimeConfigurationV1(input: {
  manifest_bytes: Uint8Array;
  bundle_bytes: Uint8Array;
  api_next_source_commit: string;
  read_credential: (name: string) => Promise<Uint8Array> | Uint8Array;
}): Promise<HnsCommunityAppGatewayRuntimeConfigurationV1> {
  const manifest = decodeManifest(input.manifest_bytes);
  if (
    manifest.api_next_source_commit !== input.api_next_source_commit ||
    manifest.bundle_sha256 !== (await sha256(input.bundle_bytes)) ||
    encoder.encode(JSON.stringify(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE)).byteLength !==
      manifest.profile_utf8_bytes
  ) {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  }

  let databaseBytes: Uint8Array | undefined;
  let registryBytes: Uint8Array | undefined;
  let accessIdBytes: Uint8Array | undefined;
  let accessSecretBytes: Uint8Array | undefined;
  try {
    [databaseBytes, registryBytes, accessIdBytes, accessSecretBytes] = await Promise.all([
      input.read_credential(manifest.authority_database_url_credential),
      input.read_credential(manifest.forwarder_key_registry_credential),
      input.read_credential(manifest.solid_access_client_id_credential),
      input.read_credential(manifest.solid_access_client_secret_credential),
    ]);
    const authorityDatabaseUrl = strictAuthorityDatabaseUrl(
      strictCredentialText(databaseBytes, 4_096),
      manifest.authority_database_endpoint,
    );
    const registrySource = strictCredentialText(registryBytes, 65_536);
    const solidAccessClientId = strictCredentialText(accessIdBytes, 4_096);
    const solidAccessClientSecret = strictCredentialText(accessSecretBytes, 4_096);
    const keyRegistry = parseHnsForwarderV3KeyRegistry(
      registrySource,
      manifest.forwarder_key_registry_reference,
      manifest.forwarder_key_registry_version,
    );
    const gatewayDeploymentReference = `hns-community-app-gateway-sha256:${await sha256(
      input.manifest_bytes,
    )}`;
    return Object.freeze({
      manifest,
      gateway_deployment_reference: gatewayDeploymentReference,
      authority_database_url: authorityDatabaseUrl,
      solid_access_client_id: solidAccessClientId,
      solid_access_client_secret: solidAccessClientSecret,
      key_registry: keyRegistry,
      forwarder_limits: Object.freeze({
        max_body_bytes: manifest.maximum_request_body_bytes,
        freshness_window_seconds: manifest.forwarder_freshness_window_seconds,
        future_clock_skew_seconds: manifest.forwarder_future_clock_skew_seconds,
      }),
    });
  } catch {
    throw new Error("HNS community app gateway configuration is incomplete or invalid");
  } finally {
    databaseBytes?.fill(0);
    registryBytes?.fill(0);
    accessIdBytes?.fill(0);
    accessSecretBytes?.fill(0);
  }
}
