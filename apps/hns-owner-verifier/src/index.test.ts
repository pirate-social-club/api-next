import { describe, expect, test } from "bun:test";
import {
  type HnsControlObservationRequestV1,
  hnsChainAuthorityDigest,
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
} from "@pirate/application/namespace-ownership";
import { app, type Env, handleRequest } from "./index.ts";
import type { HnsTargetObserverRuntime } from "./target-observer.ts";

const encoder = new TextEncoder();
const configurationDigest = "1".repeat(64);
const genesisHash = "2".repeat(64);
const anchorHash = "3".repeat(64);

const env: Env = {
  HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
  HNS_CHALLENGE_TTL_SECONDS: "3600",
  HNS_EVIDENCE_TTL_SECONDS: "2592000",
  HNS_PROVIDER_ENVIRONMENT: "staging",
  HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
};

const route = {
  family: "hns",
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
  href: "/c/app.jazleeuw",
  app_host: null,
} as const;

const creationStart = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  requirement_hash: "4".repeat(64),
  generation: 1,
  request_hash: "5".repeat(64),
  provider_binding_hash: "6".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

const systemRevalidationStart = {
  operation_kind: "route_revalidation",
  route_revalidation_id: "route-revalidation-1",
  revalidation_session_id: "revalidation-session-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 1,
  expected_verified_evidence_ref: null,
  principal_kind: "system",
  principal_id: "route-revalidation-scheduler",
  requirement_hash: "7".repeat(64),
  start_request_hash: "8".repeat(64),
  provider_binding_hash: "9".repeat(64),
  provider_configuration: creationStart.provider_configuration,
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

function request(path: string, body: unknown, accept: string, observationId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: accept,
    "Pirate-Namespace-Session-Id": "namespace-session-1",
  };
  if (observationId !== undefined) headers["Pirate-HNS-Observation-Id"] = observationId;
  return new Request(`https://hns-owner.internal${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function runtime(
  observe: HnsTargetObserverRuntime["observer"]["observe"],
  overrides: Partial<HnsTargetObserverRuntime["configuration"]> = {},
): HnsTargetObserverRuntime {
  return {
    configuration: {
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-owner-staging",
      provider_configuration_version: "hns-owner-config-v1",
      provider_configuration_digest: configurationDigest,
      environment: "staging",
      ownership_source: "hns_parent_chain_txt",
      observer_deadline_ms: 12_000,
      lease_policy: {
        expected_block_interval_seconds: 600,
        minimum_safe_remaining_blocks: 144,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
      ...overrides,
    },
    observer: { observe },
  };
}

async function innerResult(
  requestValue: HnsControlObservationRequestV1,
  status: "verified" | "pending" | "rejected" | "unavailable",
): Promise<Uint8Array> {
  const requestHash = await hnsControlObservationRequestHash(requestValue);
  const base = {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: requestValue.observation_id,
    request_sha256: requestHash,
  } as const;
  if (status === "unavailable") {
    return encoder.encode(
      JSON.stringify({
        ...base,
        status: "unavailable",
        reason_code: "chain_transport_unavailable",
        retry_after_seconds: 5,
        diagnostic_ref: "hns-observer:staging:creation-unavailable",
      }),
    );
  }
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: "regtest",
    chain_genesis_block_hash: genesisHash,
    root_label: requestValue.root_label,
    ownership_source: requestValue.ownership_source,
    authority_records: [],
  });
  const expectedTxtValueSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(requestValue.expected_txt_value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (status !== "verified") {
    return encoder.encode(
      JSON.stringify({
        ...base,
        status: "rejected",
        reason_code: status === "pending" ? "txt_absent" : "root_absent",
        provider_id: requestValue.provider_id,
        provider_configuration_reference: requestValue.provider_configuration_reference,
        provider_configuration_version: requestValue.provider_configuration_version,
        provider_configuration_digest: requestValue.provider_configuration_digest,
        environment: requestValue.environment,
        ownership_source: requestValue.ownership_source,
        root_label: requestValue.root_label,
        txt_name: requestValue.txt_name,
        expected_txt_value_sha256: expectedTxtValueSha256,
        observed_txt_values_digest: null,
        chain_authority_digest: chainAuthorityDigest,
        chain_network: "regtest",
        chain_genesis_block_hash: genesisHash,
        chain_anchor_height: 123_500,
        chain_anchor_block_hash: anchorHash,
        chain_anchor_median_time: 1_787_486_400,
        expiry_height: status === "pending" ? 200_000 : null,
        provider_evidence_ref: `hns-observer:regtest:creation-${status}`,
      }),
    );
  }
  const controlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: requestValue.ownership_source,
    txt_name: requestValue.txt_name,
    expected_txt_value: requestValue.expected_txt_value,
    root_label: requestValue.root_label,
    chain_authority_digest: chainAuthorityDigest,
  });
  return encoder.encode(
    JSON.stringify({
      ...base,
      status: "verified",
      provider_id: requestValue.provider_id,
      provider_configuration_reference: requestValue.provider_configuration_reference,
      provider_configuration_version: requestValue.provider_configuration_version,
      provider_configuration_digest: requestValue.provider_configuration_digest,
      environment: requestValue.environment,
      ownership_source: requestValue.ownership_source,
      root_label: requestValue.root_label,
      txt_name: requestValue.txt_name,
      expected_txt_value_sha256: expectedTxtValueSha256,
      control_identity_digest: controlIdentityDigest,
      chain_authority_digest: chainAuthorityDigest,
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_genesis_block_hash: genesisHash,
      chain_anchor_height: 123_500,
      chain_anchor_block_hash: anchorHash,
      chain_anchor_median_time: 1_787_486_400,
      expiry_height: 200_000,
      provider_evidence_ref: "hns-observer:regtest:creation-verified",
    }),
  );
}

async function start(targetObserver: HnsTargetObserverRuntime) {
  const response = await handleRequest(
    request("/internal/hns-owner/v1/start", creationStart, "application/json"),
    env,
    { targetObserver },
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as Record<string, unknown>;
  return {
    result,
    session: {
      actor_id: creationStart.actor_id,
      creation_intent_id: creationStart.creation_intent_id,
      ceremony_intent_id: creationStart.ceremony_intent_id,
      requirement_hash: creationStart.requirement_hash,
      generation: creationStart.generation,
      request_hash: creationStart.request_hash,
      provider_id: "hns.owner.v1",
      provider_binding_hash: creationStart.provider_binding_hash,
      provider_configuration: creationStart.provider_configuration,
      protocol_version: creationStart.protocol_version,
      environment: creationStart.environment,
      route: creationStart.route,
      upstream_session_ref: result.upstream_session_ref,
      expires_at: result.expires_at,
    },
  };
}

describe("HNS owner verifier target composition", () => {
  test("fails closed without target authority and has no public legacy graph", async () => {
    const response = await app.fetch(
      request("/internal/hns-owner/v1/start", creationStart, "application/json"),
      env,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_misconfigured" });

    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(source).not.toContain(["poll", "Legacy"].join(""));
    expect(source).not.toContain(["HNS", "LEGACY", "VERIFIER"].join("_"));
    expect(source).not.toContain(["globalThis", "fetch"].join("."));
    expect(source).not.toContain(["legacy", "ns1:"].join("-"));
  });

  test("starts target creation but disables historical system revalidation", async () => {
    const targetObserver = runtime(async () => {
      throw new Error("start must not observe");
    });
    const started = await start(targetObserver);
    expect((started.result.presentation as Record<string, unknown>).session_id).toBe(
      started.result.upstream_session_ref,
    );
    const disabled = await handleRequest(
      request("/internal/hns-owner/v1/start", systemRevalidationStart, "application/json"),
      env,
      { targetObserver },
    );
    expect(disabled.status).toBe(502);
  });

  test("derives creation observation authority and returns strict target-v2 bytes", async () => {
    let captured: HnsControlObservationRequestV1 | undefined;
    const targetObserver = runtime(async (input, options) => {
      captured = input.request;
      expect(options.deadline_ms).toBe(12_000);
      return innerResult(input.request, "verified");
    });
    const started = await start(targetObserver);
    const response = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { session: started.session, payload: {} },
        "application/octet-stream",
        "completion-attempt-1",
      ),
      env,
      { targetObserver },
    );
    expect(response.status).toBe(200);
    const output = (await response.json()) as Record<string, unknown>;
    expect(output.status).toBe("verified");
    expect(output.observation_contract_version).toBe("pirate-hns-target-observation-v2");
    expect(captured).toMatchObject({
      observation_id: "completion-attempt-1",
      provider_configuration_digest: configurationDigest,
      ownership_source: "hns_parent_chain_txt",
      root_label: "jazleeuw",
      txt_name: "jazleeuw",
      expected_txt_value: `pirate-verification=${started.result.upstream_session_ref}`,
    });
  });

  test("maps target pending, stable rejection, and unavailability without fallback", async () => {
    for (const [status, expectedHttp, expectedBodyStatus] of [
      ["pending", 200, "pending"],
      ["rejected", 422, undefined],
      ["unavailable", 503, undefined],
    ] as const) {
      const targetObserver = runtime(async (input) => innerResult(input.request, status));
      const started = await start(targetObserver);
      const response = await handleRequest(
        request(
          "/internal/hns-owner/v1/poll",
          { session: started.session, payload: {} },
          "application/octet-stream",
          `completion-attempt-${status}`,
        ),
        env,
        { targetObserver },
      );
      expect(response.status).toBe(expectedHttp);
      if (expectedBodyStatus !== undefined) {
        expect(((await response.json()) as Record<string, unknown>).status).toBe(
          expectedBodyStatus,
        );
      }
    }
  });

  test("requires persisted observation correlation and complete runtime authority", async () => {
    let calls = 0;
    const targetObserver = runtime(async (input) => {
      calls += 1;
      return innerResult(input.request, "verified");
    });
    const started = await start(targetObserver);
    const missing = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { session: started.session, payload: {} },
        "application/octet-stream",
      ),
      env,
      { targetObserver },
    );
    expect(missing.status).toBe(400);

    const drifted = runtime(targetObserver.observer.observe, {
      provider_configuration_version: "other",
    });
    const mismatch = await handleRequest(
      request("/internal/hns-owner/v1/start", creationStart, "application/json"),
      env,
      { targetObserver: drifted },
    );
    expect(mismatch.status).toBe(502);
    expect(calls).toBe(0);
  });

  test("rejects non-canonical JSON and unexpected observation headers on start", async () => {
    const targetObserver = runtime(async () => {
      throw new Error("not reached");
    });
    const base = request("/internal/hns-owner/v1/start", creationStart, "application/json");
    const nonCanonical = new Request(base, { body: `${JSON.stringify(creationStart)} ` });
    expect((await handleRequest(nonCanonical, env, { targetObserver })).status).toBe(400);
    expect(
      (
        await handleRequest(
          request(
            "/internal/hns-owner/v1/start",
            creationStart,
            "application/json",
            "not-valid-on-start",
          ),
          env,
          { targetObserver },
        )
      ).status,
    ).toBe(400);
  });
});
