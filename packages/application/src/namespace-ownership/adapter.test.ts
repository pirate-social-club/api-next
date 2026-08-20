import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES,
  NamespaceOwnershipProviderCompleteResult,
  NamespaceOwnershipProviderManifest,
  NamespaceOwnershipProviderPlanInput,
  NamespaceOwnershipProviderStartInput,
  NamespaceOwnershipSession,
} from "./adapter.ts";

const route = {
  family: "hns" as const,
  root_label: "xn--4v8h",
  root_label_display: "🔥",
  path_segment: "app.xn--4v8h",
  href: "/c/app.xn--4v8h",
  app_host: null,
};

describe("namespace ownership provider boundary", () => {
  test("freezes a family-scoped provider manifest", () => {
    const manifest = Schema.decodeUnknownSync(NamespaceOwnershipProviderManifest)({
      provider_id: "test.hns-owner",
      manifest_version: "1",
      supported_families: ["hns"],
      protocol_versions: ["hns-owner-txt-v1"],
      environments: ["staging"],
      submission_channels: ["poll_result"],
      operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 15_000 },
    });

    expect(manifest.supported_families).toEqual(["hns"]);
    expect(manifest.provider_id).toBe("test.hns-owner");
  });

  test("binds starts to the actor, parent intent, generation, provider config, and route", () => {
    expect(
      Schema.decodeUnknownSync(NamespaceOwnershipProviderStartInput)({
        actor_id: "user-1",
        creation_intent_id: "creation-1",
        ceremony_intent_id: "ceremony-1",
        requirement_hash: "a".repeat(64),
        generation: 1,
        request_hash: "b".repeat(64),
        provider_binding_hash: "e".repeat(64),
        provider_configuration: { kind: "dynamic", reference: "hns-verifier", version: "1" },
        protocol_version: "hns-owner-txt-v1",
        environment: "staging",
        route,
      }),
    ).toMatchObject({ route, generation: 1 });
    expect(() =>
      Schema.decodeUnknownSync(NamespaceOwnershipProviderPlanInput)({
        environment: "staging",
        route: { ...route, app_host: route.path_segment },
      }),
    ).toThrow();
  });

  test("bounds the upstream session reference by UTF-8 bytes", () => {
    const base = {
      actor_id: "user-1",
      creation_intent_id: "creation-1",
      ceremony_intent_id: "ceremony-1",
      requirement_hash: "a".repeat(64),
      generation: 1,
      request_hash: "b".repeat(64),
      provider_id: "test.hns-owner",
      provider_binding_hash: "e".repeat(64),
      provider_configuration: { kind: "dynamic", reference: "hns-verifier", version: "1" },
      protocol_version: "hns-owner-txt-v1",
      environment: "staging",
      route,
      expires_at: "2026-08-20T13:00:00.000Z",
    };

    expect(
      Schema.is(NamespaceOwnershipSession)({
        ...base,
        upstream_session_ref: "r".repeat(NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES),
      }),
    ).toBeTrue();
    expect(
      Schema.is(NamespaceOwnershipSession)({
        ...base,
        upstream_session_ref: "🚀".repeat(NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES / 2),
      }),
    ).toBeFalse();
  });

  test("returns only pending or bounded raw verified evidence", () => {
    expect(
      Schema.decodeUnknownSync(NamespaceOwnershipProviderCompleteResult)({ status: "pending" }),
    ).toEqual({ status: "pending" });
    expect(
      Schema.decodeUnknownSync(NamespaceOwnershipProviderCompleteResult)({
        status: "verified",
        evidence_kind: "raw_provider_response_v1",
        provider_evidence_ref: "hns-observation-1",
        raw_response_bytes: new TextEncoder().encode('{"status":"verified"}'),
        observation: { status: "verified" },
        observed_at: "2026-08-20T12:00:00.000Z",
        expires_at: "2026-09-20T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "verified", evidence_kind: "raw_provider_response_v1" });
    expect(() =>
      Schema.decodeUnknownSync(NamespaceOwnershipProviderCompleteResult)({
        status: "verified",
        provider_evidence_ref: "provider-prose-only",
      }),
    ).toThrow();
  });
});
