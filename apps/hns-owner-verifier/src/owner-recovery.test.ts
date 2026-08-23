import { describe, expect, test } from "bun:test";
import {
  type HnsControlObservationRequestV1,
  hnsChainAuthorityDigest,
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
} from "@pirate/application/namespace-ownership";
import {
  buildHnsOwnerRecoveryProviderPoll,
  buildHnsOwnerRecoveryProviderStart,
  decodeHnsOwnerRecoveryProviderStartResponseBytes,
  encodeHnsOwnerRecoveryProviderPoll,
  encodeHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
  hnsOwnerRecoveryPublicStartHash,
} from "@pirate/application/route-revalidation";
import { type Env, handleRequest } from "./index.ts";
import type { HnsTargetObserverRuntime } from "./target-observer.ts";

const encoder = new TextEncoder();
const databaseStartedAt = "2026-02-02T03:04:05.000Z";
const configurationDigest = "1".repeat(64);
const genesisHash = "2".repeat(64);
const anchorHash = "3".repeat(64);
const startIdempotencyKey = "recovery-start-idempotency-1";

const env: Env = {
  HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
  HNS_CHALLENGE_TTL_SECONDS: "3600",
  HNS_EVIDENCE_TTL_SECONDS: "2592000",
  HNS_LEGACY_VERIFIER_URL: "https://verifier.pirate.sc/hns",
  HNS_LEGACY_VERIFIER_BEARER: "legacy-must-remain-unused",
  HNS_PROVIDER_ENVIRONMENT: "staging",
  HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
};

const authority: HnsOwnerRecoveryAuthorityV1 = {
  actor_id: "user-recovery-1",
  community_id: "community-recovery-1",
  route_binding_id: "route-binding-recovery-1",
  expected_binding_generation: 8,
  recovery_authority_kind: "database_time_expiry_transition",
  recovery_authority_reference: "route-transition-recovery-1",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
    digest: configurationDigest,
  },
  protocol_version: "hns-owner-recovery-v1",
  environment: "staging",
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};

function body(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function request(path: string, bytes: Uint8Array, sessionId: string, accept: string): Request {
  return new Request(`https://hns-owner.internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      "Pirate-Namespace-Session-Id": sessionId,
    },
    body: body(bytes),
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
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
      ...overrides,
    },
    observer: { observe },
    ids: { observation: () => "observer-recovery-01" },
  };
}

async function startRecovery(targetObserver: HnsTargetObserverRuntime) {
  const providerStart = await buildHnsOwnerRecoveryProviderStart({
    route_recovery_id: "route-recovery-1",
    session_id: "recovery-session-1",
    authority,
    database_started_at: databaseStartedAt,
  });
  const response = await handleRequest(
    request(
      "/internal/hns-owner/v1/start",
      await encodeHnsOwnerRecoveryProviderStart(providerStart),
      providerStart.session_id,
      "application/json",
    ),
    env,
    { targetObserver },
  );
  expect(response.status).toBe(200);
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  const providerResponse = decodeHnsOwnerRecoveryProviderStartResponseBytes(responseBytes);
  const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    idempotency_key: startIdempotencyKey,
    requirement_hash: providerStart.requirement_hash,
  });
  const retained = await finalizeHnsOwnerRecoveryProviderStart({
    provider_start: providerStart,
    public_start_hash: publicStartHash,
    start_request: {
      expected_generation: authority.expected_binding_generation,
      idempotency_key: startIdempotencyKey,
    },
    started_at: databaseStartedAt,
    provider_response: providerResponse,
  });
  return { providerStart, providerResponse, session: retained.session };
}

async function pollRequest(session: Awaited<ReturnType<typeof startRecovery>>["session"]) {
  const sessionAuthority = {
    expected_route_recovery_id: session.route_recovery_id,
    expected_session_id: session.session_id,
    start_idempotency_key: startIdempotencyKey,
    expected_public_start_hash: session.public_start_hash,
    expected_upstream_session_ref: session.upstream_session_ref,
    expected_ownership_source: session.ownership_source,
    expected_challenge_expires_at: session.challenge_expires_at,
  } as const;
  const poll = await buildHnsOwnerRecoveryProviderPoll(session, sessionAuthority);
  return request(
    "/internal/hns-owner/v1/poll",
    await encodeHnsOwnerRecoveryProviderPoll(poll, sessionAuthority),
    session.session_id,
    "application/octet-stream",
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function observerResult(
  requestValue: HnsControlObservationRequestV1,
  status: "verified" | "txt_absent" | "root_absent" | "unavailable",
): Promise<Uint8Array> {
  const requestHash = await hnsControlObservationRequestHash(requestValue);
  if (status === "unavailable") {
    return encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: requestValue.observation_id,
        request_sha256: requestHash,
        status: "unavailable",
        reason_code: "chain_transport_unavailable",
        retry_after_seconds: 5,
        diagnostic_ref: "hns-observer-diagnostic:recovery-01",
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
  const expectedTxtValueSha256 = await sha256(requestValue.expected_txt_value);
  const base = {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: requestValue.observation_id,
    request_sha256: requestHash,
  } as const;
  if (status !== "verified") {
    return encoder.encode(
      JSON.stringify({
        ...base,
        status: "rejected",
        reason_code: status,
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
        chain_anchor_median_time: 1_770_003_500,
        expiry_height: status === "root_absent" ? null : 200_000,
        provider_evidence_ref: `hns-observer:regtest:${status}`,
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
      chain_anchor_median_time: 1_770_003_500,
      expiry_height: 200_000,
      provider_evidence_ref: "hns-observer:regtest:recovery-verified",
    }),
  );
}

describe("HNS owner verifier recovery target-observer seam", () => {
  test("echoes the database-authorized recovery deadline and never falls back to legacy", async () => {
    let legacyCalls = 0;
    const targetObserver = runtime(async () => {
      throw new Error("start must not observe");
    });
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "route-recovery-1",
      session_id: "recovery-session-1",
      authority,
      database_started_at: databaseStartedAt,
    });
    const startBytes = await encodeHnsOwnerRecoveryProviderStart(providerStart);
    const missing = await handleRequest(
      request(
        "/internal/hns-owner/v1/start",
        startBytes,
        providerStart.session_id,
        "application/json",
      ),
      env,
      {
        fetcher: async () => {
          legacyCalls += 1;
          throw new Error("legacy fetch forbidden");
        },
      },
    );
    expect(missing.status).toBe(502);
    const started = await startRecovery(targetObserver);
    expect(started.providerResponse.expires_at).toBe(providerStart.challenge_expires_at);
    expect(started.providerResponse.presentation.payload.expires_at).toBe(
      providerStart.challenge_expires_at,
    );
    expect(legacyCalls).toBe(0);
  });

  test("derives the exact observer request from the persisted recovery session", async () => {
    let captured: HnsControlObservationRequestV1 | null = null;
    let capturedBytes: Uint8Array | null = null;
    const targetObserver = runtime(async (input, options) => {
      captured = input.request;
      capturedBytes = input.request_bytes;
      expect(options.deadline_ms).toBe(12_000);
      expect(options.signal.aborted).toBe(false);
      return observerResult(input.request, "verified");
    });
    const started = await startRecovery(targetObserver);
    const response = await handleRequest(await pollRequest(started.session), env, {
      targetObserver,
      fetcher: async () => {
        throw new Error("legacy fetch forbidden");
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const output = JSON.parse(await response.text()) as Record<string, unknown>;
    expect(output.status).toBe("verified");
    expect(output.observation_contract_version).toBe("pirate-hns-target-observation-v2");
    expect(output.upstream_session_ref).toBe(started.session.upstream_session_ref);
    const expectedRequest: HnsControlObservationRequestV1 = {
      version: "pirate-hns-control-observation-request-v1",
      observation_id: "observer-recovery-01",
      provider_id: started.session.provider_id,
      provider_configuration_reference: started.session.provider_configuration.reference,
      provider_configuration_version: started.session.provider_configuration.version,
      provider_configuration_digest: started.session.provider_configuration.digest,
      environment: started.session.environment,
      ownership_source: started.session.ownership_source,
      root_label: started.session.route.root_label,
      txt_name: started.session.challenge_name,
      expected_txt_value: started.session.challenge_value,
    };
    expect(JSON.stringify(captured)).toBe(JSON.stringify(expectedRequest));
    expect(new TextDecoder().decode(capturedBytes ?? new Uint8Array())).toBe(
      JSON.stringify(captured),
    );
  });

  test("maps strict pending, rejected, and unavailable observer outcomes", async () => {
    for (const [inner, outer] of [
      ["txt_absent", "pending"],
      ["root_absent", "rejected"],
      ["unavailable", "unavailable"],
    ] as const) {
      const targetObserver = runtime((input) => observerResult(input.request, inner));
      const started = await startRecovery(targetObserver);
      const response = await handleRequest(await pollRequest(started.session), env, {
        targetObserver,
      });
      expect(response.status).toBe(200);
      expect((JSON.parse(await response.text()) as { status: string }).status).toBe(outer);
    }
  });

  test("fails closed on configuration drift before observer work", async () => {
    let observerCalls = 0;
    const ready = runtime(async (input) => observerResult(input.request, "verified"));
    const started = await startRecovery(ready);
    const drifted = runtime(
      async (input) => {
        observerCalls += 1;
        return observerResult(input.request, "verified");
      },
      { provider_configuration_digest: "f".repeat(64) },
    );
    const response = await handleRequest(await pollRequest(started.session), env, {
      targetObserver: drifted,
    });
    expect(response.status).toBe(502);
    expect(observerCalls).toBe(0);
  });

  test("maps observer transport failure separately from invalid inner bytes", async () => {
    const unavailable = runtime(async () => {
      throw new Error("observer unavailable");
    });
    const started = await startRecovery(unavailable);
    expect(
      (
        await handleRequest(await pollRequest(started.session), env, {
          targetObserver: unavailable,
        })
      ).status,
    ).toBe(503);

    const invalid = runtime(async () => encoder.encode('{"status":"verified"}'));
    expect(
      (await handleRequest(await pollRequest(started.session), env, { targetObserver: invalid }))
        .status,
    ).toBe(502);

    let aborted = false;
    const timedOut = runtime(
      (_input, options) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Uint8Array>(() => undefined);
      },
      { observer_deadline_ms: 10 },
    );
    expect(
      (await handleRequest(await pollRequest(started.session), env, { targetObserver: timedOut }))
        .status,
    ).toBe(503);
    expect(aborted).toBe(true);

    const brokenRuntime: HnsTargetObserverRuntime = {
      ...unavailable,
      ids: {
        observation() {
          throw new Error("observation id unavailable");
        },
      },
    };
    expect(
      (
        await handleRequest(await pollRequest(started.session), env, {
          targetObserver: brokenRuntime,
        })
      ).status,
    ).toBe(502);
  });
});
