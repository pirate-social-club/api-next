import { describe, expect, test } from "bun:test";
import {
  HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL,
  HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_SOURCE,
  HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_SCHEMA,
  HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL,
  HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_ID_CREDENTIAL,
  HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL,
  HNS_COMMUNITY_APP_GATEWAY_STAGING_DEPLOYMENT_SCHEMA,
  HNS_COMMUNITY_APP_GATEWAY_STAGING_INGRESS_CONTRACT,
  HNS_COMMUNITY_APP_GATEWAY_TLS_TERMINATOR_CONTRACT,
  type HnsCommunityAppGatewayDeploymentMode,
  loadHnsCommunityAppGatewayRuntimeConfigurationV1,
} from "./community-runtime-config.ts";

const encoder = new TextEncoder();
const sourceCommit = "1".repeat(40);
const bundleBytes = encoder.encode("exact community gateway bundle");
const keyReference = "hns-community-rehearsal";
const keyVersion = "2026-08-26-01";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function manifest(
  mode: HnsCommunityAppGatewayDeploymentMode = "production",
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const common = {
    profile_version: "pirate-hns-community-app-interactive-gateway-v2",
    profile_utf8_bytes: 622,
    profile_sha256: "f49ac37bd45da71bdf1e1cc65f184729d85f9d72ce811f0551a70f7785aa8d86",
    solid_origin: "https://hns-solid-staging.pirate.sc",
    solid_ingress_composition_reference: "solid-hns-ingress-staging-01",
    solid_access_application_audience: "solid-hns-staging-aud",
    solid_access_client_id_credential: HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_ID_CREDENTIAL,
    solid_access_client_secret_credential:
      HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL,
    authority_source: HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_SOURCE,
    authority_database_endpoint: "postgresql://db.example/api_next?sslmode=verify-full",
    authority_database_url_credential: HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL,
    forwarder_key_registry_reference: keyReference,
    forwarder_key_registry_version: keyVersion,
    forwarder_key_registry_credential: HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL,
    forwarder_freshness_window_seconds: 300,
    forwarder_future_clock_skew_seconds: 5,
    maximum_origin_form_target_bytes: 8192,
    maximum_request_field_count: 128,
    maximum_request_header_bytes: 32768,
    maximum_request_body_bytes: 1048576,
    maximum_sensitive_cookie_value_bytes: 16384,
    maximum_buffered_response_bytes: 16777216,
    gateway_upstream_deadline_milliseconds: 15000,
    maximum_private_authority_bytes: 4096,
    private_authority_deadline_milliseconds: 2000,
    api_next_source_commit: sourceCommit,
    bundle_sha256: await sha256(bundleBytes),
  };
  return JSON.stringify(
    mode === "staging-shadow"
      ? {
          schema: HNS_COMMUNITY_APP_GATEWAY_STAGING_DEPLOYMENT_SCHEMA,
          mode,
          staging_shadow_gateway_listener: "127.0.0.1:4269",
          staging_shadow_health_listener: "127.0.0.1:4271",
          ingress_contract: HNS_COMMUNITY_APP_GATEWAY_STAGING_INGRESS_CONTRACT,
          public_tls_termination: false,
          synthetic_certificate_spki_sha256: "b".repeat(64),
          ...common,
          ...overrides,
        }
      : {
          schema: HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_SCHEMA,
          production_gateway_listener: "127.0.0.1:4069",
          production_health_listener: "127.0.0.1:4071",
          shadow_gateway_listener: "127.0.0.1:4169",
          shadow_health_listener: "127.0.0.1:4171",
          tls_terminator_contract: HNS_COMMUNITY_APP_GATEWAY_TLS_TERMINATOR_CONTRACT,
          gateway_certificate_spki_sha256: "a".repeat(64),
          ...common,
          ...overrides,
        },
  );
}

function credentials(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const registry = JSON.stringify({
    schema: "pirate-hns-forwarder-v3-key-registry-v1",
    registry_reference: keyReference,
    registry_version: keyVersion,
    keys: [
      {
        key_id: "gateway-key-rehearsal",
        key_base64url: base64url(new Uint8Array(32).fill(9)),
        signing_enabled: true,
        verify_not_before: 1_760_000_000,
        verify_not_after: 1_780_000_000,
      },
    ],
  });
  return {
    [HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL]:
      "postgresql://gateway:private@db.example/api_next?sslmode=verify-full",
    [HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL]: registry,
    [HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_ID_CREDENTIAL]: "access-client-id",
    [HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL]: "access-client-secret",
    ...overrides,
  };
}

async function load(
  input: {
    mode?: HnsCommunityAppGatewayDeploymentMode;
    manifest_mode?: HnsCommunityAppGatewayDeploymentMode;
    manifest_overrides?: Readonly<Record<string, unknown>>;
    credential_overrides?: Readonly<Record<string, string>>;
    bundle_bytes?: Uint8Array;
  } = {},
) {
  const values = credentials(input.credential_overrides);
  const mode = input.mode ?? "production";
  return loadHnsCommunityAppGatewayRuntimeConfigurationV1({
    mode,
    manifest_bytes: encoder.encode(
      await manifest(input.manifest_mode ?? mode, input.manifest_overrides),
    ),
    bundle_bytes: input.bundle_bytes ?? bundleBytes,
    api_next_source_commit: sourceCommit,
    read_credential: (name) => {
      const value = values[name];
      if (value === undefined) throw new Error("missing test credential");
      return encoder.encode(value);
    },
  });
}

describe("community gateway deployment configuration", () => {
  test("binds exact manifest bytes, artifact, source, registry, and credential references", async () => {
    const manifestText = await manifest("production");
    const configuration = await load();
    expect(configuration.manifest.api_next_source_commit).toBe(sourceCommit);
    expect(configuration.manifest.bundle_sha256).toBe(await sha256(bundleBytes));
    expect(configuration.gateway_deployment_reference).toBe(
      `hns-community-app-gateway-sha256:${await sha256(encoder.encode(manifestText))}`,
    );
    expect(configuration.authority_database_url).toBe(
      "postgresql://gateway:private@db.example/api_next?sslmode=verify-full",
    );
    expect(configuration.key_registry.signingKey(1_770_000_000)?.key_id).toBe(
      "gateway-key-rehearsal",
    );
    expect(configuration.forwarder_limits).toEqual({
      max_body_bytes: 1_048_576,
      freshness_window_seconds: 300,
      future_clock_skew_seconds: 5,
    });
  });

  test("preserves production v1 decoding and binds the staging-only manifest to its mode", async () => {
    expect((await load({ mode: "shadow" })).manifest.schema).toBe(
      HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_SCHEMA,
    );
    const staging = await load({ mode: "staging-shadow" });
    expect(staging.manifest.schema).toBe(HNS_COMMUNITY_APP_GATEWAY_STAGING_DEPLOYMENT_SCHEMA);
    expect(staging.manifest).toMatchObject({
      mode: "staging-shadow",
      staging_shadow_gateway_listener: "127.0.0.1:4269",
      staging_shadow_health_listener: "127.0.0.1:4271",
      public_tls_termination: false,
      synthetic_certificate_spki_sha256: "b".repeat(64),
    });
    await expect(load({ mode: "staging-shadow", manifest_mode: "production" })).rejects.toThrow(
      "configuration is incomplete or invalid",
    );
    await expect(load({ mode: "production", manifest_mode: "staging-shadow" })).rejects.toThrow(
      "configuration is incomplete or invalid",
    );
    for (const manifest_overrides of [
      { staging_shadow_gateway_listener: "127.0.0.1:4169" },
      { staging_shadow_health_listener: "127.0.0.1:4171" },
      { public_tls_termination: true },
      { synthetic_certificate_spki_sha256: "c".repeat(63) },
      { production_gateway_listener: "127.0.0.1:4069" },
    ]) {
      await expect(load({ mode: "staging-shadow", manifest_overrides })).rejects.toThrow(
        "configuration is incomplete or invalid",
      );
    }
  });

  test("rejects artifact, source, profile, origin, and exact-member substitution", async () => {
    await expect(load({ bundle_bytes: encoder.encode("other") })).rejects.toThrow(
      "configuration is incomplete or invalid",
    );
    await expect(
      load({ manifest_overrides: { api_next_source_commit: "2".repeat(40) } }),
    ).rejects.toThrow("configuration is incomplete or invalid");
    for (const manifest_overrides of [
      { profile_utf8_bytes: 621 },
      { solid_origin: "http://hns-solid-staging.pirate.sc" },
      { production_gateway_listener: "127.0.0.1:4049" },
      { authority_source: "api-private-wire-v2" },
      {
        authority_database_endpoint: "postgresql://another-db.example/api_next?sslmode=verify-full",
      },
      { unexpected: true },
    ]) {
      await expect(load({ manifest_overrides })).rejects.toThrow(
        "configuration is incomplete or invalid",
      );
    }
  });

  test("rejects broad or malformed credentials without disclosing their bytes", async () => {
    const secret = "must-never-appear";
    for (const credential_overrides of [
      {
        [HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL]:
          "postgresql://broad:private@db.example/api_next?sslmode=require",
      },
      {
        [HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_DATABASE_CREDENTIAL]:
          "postgresql://gateway:private@another-db.example/api_next?sslmode=verify-full",
      },
      { [HNS_COMMUNITY_APP_GATEWAY_SOLID_ACCESS_CLIENT_SECRET_CREDENTIAL]: `${secret}\n` },
      { [HNS_COMMUNITY_APP_GATEWAY_FORWARDER_KEY_REGISTRY_CREDENTIAL]: "{}" },
    ]) {
      try {
        await load({ credential_overrides });
        throw new Error("expected configuration rejection");
      } catch (error) {
        expect(String(error)).toContain("configuration is incomplete or invalid");
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("broad:private");
      }
    }
  });
});
