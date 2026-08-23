import { describe, expect, test } from "bun:test";
import type { HnsEvidenceLeasePolicy } from "../namespace-ownership/hns-control-observer.ts";
import {
  buildHnsOwnerRecoveryEvidence,
  buildHnsOwnerRecoveryProviderPoll,
  buildHnsOwnerRecoveryProviderStart,
  classifyHnsOwnerRecoveryTargetResponse,
  decodeHnsOwnerRecoveryPollRequestBytes,
  decodeHnsOwnerRecoveryProviderPollBytes,
  decodeHnsOwnerRecoveryProviderStartBytes,
  decodeHnsOwnerRecoveryProviderStartResponseBytes,
  decodeHnsOwnerRecoveryStartRequestBytes,
  decodeHnsOwnerRecoveryTargetResponseBytes,
  encodeHnsOwnerRecoveryProviderPoll,
  encodeHnsOwnerRecoveryProviderPollRequest,
  encodeHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
  type HnsOwnerRecoveryPersistedSessionV1,
  type HnsOwnerRecoveryPollRequestV1,
  hnsOwnerRecoveryChallengeExpiresAt,
  hnsOwnerRecoveryDeadlineState,
  hnsOwnerRecoveryPollHash,
  hnsOwnerRecoveryPollResponse,
  hnsOwnerRecoveryProviderStartHash,
  hnsOwnerRecoveryPublicStartHash,
  hnsOwnerRecoveryRequirementHash,
  hnsOwnerRecoveryResultHash,
  planHnsOwnerRecoveryPoll,
} from "./owner-recovery.ts";

const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (value: string) => value as `${string}`;

const authority: HnsOwnerRecoveryAuthorityV1 = {
  actor_id: "user-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 13,
  recovery_authority_kind: "database_time_expiry_transition",
  recovery_authority_reference: "route_lifecycle_transition_01",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-observer-regtest",
    version: "hns-observer-config-v1",
    digest: "1".repeat(64),
  },
  protocol_version: "hns-owner-recovery-v1",
  environment: "test",
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};

const startRequest = {
  expected_generation: 13,
  idempotency_key: "recovery-start-01",
} as const;
const pollRequest: HnsOwnerRecoveryPollRequestV1 = {
  route_recovery_id: "hns_recovery_01",
  session_id: "hns_recovery_session_01",
  expected_generation: 13,
  idempotency_key: "recovery-poll-01",
  channel: "poll_result",
};
const policy: HnsEvidenceLeasePolicy = {
  expected_block_interval_seconds: 600,
  minimum_safe_remaining_blocks: 1,
  expiry_safety_blocks: 100,
  evidence_lease_seconds: 2_592_000,
};

function providerStartResponse(expiresAt = "2026-02-02T05:38:20.000Z") {
  return {
    upstream_session_ref: "nvs_recovery_01",
    expires_at: expiresAt,
    presentation: {
      kind: "embedded_sdk",
      session_id: "nvs_recovery_01",
      protocol: "hns-txt-challenge",
      version: "1",
      payload: {
        ownership_source: "hns_parent_chain_txt",
        challenge_name: "jazleeuw",
        challenge_value: "pirate-verification=nvs_recovery_01",
        expires_at: expiresAt,
      },
    },
  } as const;
}

const positiveResponse = {
  status: "verified",
  observation_contract_version: "pirate-hns-target-observation-v2",
  provider_evidence_ref:
    "hns-observer-v1:sha256:931744c296210c90f02bcc5b430323100a37075b066002331f3f09e0d99dae60:hns-observer:regtest:recovery-01",
  upstream_session_ref: "nvs_recovery_01",
  ownership_source: "hns_parent_chain_txt",
  challenge_name: "jazleeuw",
  challenge_value: "pirate-verification=nvs_recovery_01",
  expected_txt_value_sha256: "337d887d720d03a117b13d541e40cf3dbcf619974eeb47f874685706040d6b83",
  control_identity_digest: "f8b28365e0b9abe000b78f9196218db0ca7fc037bbc27e6297f2cf8a86f3e17b",
  chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
  observer_result_sha256: "931744c296210c90f02bcc5b430323100a37075b066002331f3f09e0d99dae60",
  root_exists: true,
  root_control_verified: true,
  expiry_horizon_sufficient: true,
  chain_network: "regtest",
  chain_anchor_height: 123550,
  chain_anchor_block_hash: "6".repeat(64),
  chain_anchor_median_time: 1770007100,
  expiry_height: 200000,
  observed_at: "2026-02-02T04:38:20.000Z",
  expires_at: "2026-03-04T04:38:20.000Z",
} as const;

async function fixtureSession(): Promise<HnsOwnerRecoveryPersistedSessionV1> {
  const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
  const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    idempotency_key: startRequest.idempotency_key,
    requirement_hash: requirementHash,
  });
  const providerStart = await buildHnsOwnerRecoveryProviderStart({
    route_recovery_id: "hns_recovery_01",
    session_id: "hns_recovery_session_01",
    authority,
    database_started_at: "2026-02-02T04:38:20.000Z",
  });
  const finalized = await finalizeHnsOwnerRecoveryProviderStart({
    provider_start: providerStart,
    public_start_hash: publicStartHash,
    start_request: startRequest,
    started_at: "2026-02-02T04:38:20.000Z",
    provider_response: providerStartResponse(),
  });
  if (finalized.kind !== "retained") throw new Error("fixture start was not retained");
  return finalized.session;
}

function persistedAuthority(session: HnsOwnerRecoveryPersistedSessionV1) {
  return {
    expected_route_recovery_id: session.route_recovery_id,
    expected_session_id: session.session_id,
    start_idempotency_key: startRequest.idempotency_key,
    expected_public_start_hash: session.public_start_hash,
    expected_upstream_session_ref: session.upstream_session_ref,
    expected_ownership_source: session.ownership_source,
    expected_challenge_expires_at: session.challenge_expires_at,
  } as const;
}

describe("HNS owner-initiated recovery protocol kernel", () => {
  test("reproduces the frozen requirement, start, provider-start, and poll domains", async () => {
    const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
    expect(requirementHash).toBe(
      "5b50ed9992c7182d3e925120cc3a2fee8fc34930bb55a60a9e477d9f1519d020",
    );
    expect(
      await hnsOwnerRecoveryPublicStartHash({
        actor_id: authority.actor_id,
        community_id: authority.community_id,
        route_binding_id: authority.route_binding_id,
        expected_binding_generation: authority.expected_binding_generation,
        idempotency_key: startRequest.idempotency_key,
        requirement_hash: requirementHash,
      }),
    ).toBe("6a29f6a03b0447428980a3ceae2ded11eb5b867af9cdd548abd487808b0cfaed");
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "hns_recovery_01",
      session_id: "hns_recovery_session_01",
      authority,
      database_started_at: "2026-02-02T04:38:20.000Z",
    });
    expect(providerStart.provider_start_hash).toBe(
      "340f02c5fc20d9db9686fbb6b7917b9ef11e24d46b2ae8159c95e7ccc5f2a02d",
    );
    expect(await hnsOwnerRecoveryProviderStartHash(providerStart)).toBe(
      providerStart.provider_start_hash,
    );
    expect(await hnsOwnerRecoveryPollHash(pollRequest)).toBe(
      "cdb7c8239bc15c43986d749d72aea475c1662a4690d8119899ff1b746e192447",
    );
    expect(
      (await encodeHnsOwnerRecoveryProviderStart(providerStart)).byteLength,
    ).toBeLessThanOrEqual(8192);
    expect(hnsOwnerRecoveryChallengeExpiresAt("2026-02-02T04:38:20.000Z")).toBe(
      "2026-02-02T05:38:20.000Z",
    );
    expect(
      hnsOwnerRecoveryDeadlineState({
        database_now: "2026-02-02T05:38:19.999Z",
        challenge_expires_at: "2026-02-02T05:38:20.000Z",
      }),
    ).toBe("live");
    expect(
      hnsOwnerRecoveryDeadlineState({
        database_now: "2026-02-02T05:38:20.000Z",
        challenge_expires_at: "2026-02-02T05:38:20.000Z",
      }),
    ).toBe("expired");
  });

  test("strict-decodes only owner request authority and rejects browser-supplied facts", () => {
    expect(decodeHnsOwnerRecoveryStartRequestBytes(utf8(startRequest))).toEqual(startRequest);
    expect(decodeHnsOwnerRecoveryPollRequestBytes(utf8(pollRequest))).toEqual(pollRequest);
    expect(() =>
      decodeHnsOwnerRecoveryStartRequestBytes(utf8({ ...startRequest, root_label: "attacker" })),
    ).toThrow();
    expect(() =>
      decodeHnsOwnerRecoveryStartRequestBytes(
        utf8({ idempotency_key: startRequest.idempotency_key, expected_generation: 13 }),
      ),
    ).toThrow();
    expect(() =>
      decodeHnsOwnerRecoveryPollRequestBytes(
        utf8({ ...pollRequest, operation_mode: "route_revalidation" }),
      ),
    ).toThrow();
  });

  test("retains only a successful database-deadline-bound provider start", async () => {
    const session = await fixtureSession();
    const poll = await buildHnsOwnerRecoveryProviderPoll(session, persistedAuthority(session));
    expect(poll.operation_kind).toBe("same_root_recovery");
    expect(poll.protocol_version).toBe("hns-owner-recovery-v1");
    expect(
      (await encodeHnsOwnerRecoveryProviderPoll(poll, persistedAuthority(session))).byteLength,
    ).toBeLessThanOrEqual(32_768);
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      authority,
      database_started_at: session.started_at,
    });
    await expect(
      finalizeHnsOwnerRecoveryProviderStart({
        provider_start: providerStart,
        public_start_hash: session.public_start_hash,
        start_request: startRequest,
        started_at: session.started_at,
        provider_response: {
          ...providerStartResponse(),
          presentation: {
            ...providerStartResponse().presentation,
            payload: {
              ...providerStartResponse().presentation.payload,
              expires_at: "2026-02-02T05:38:21.000Z",
            },
          },
        },
      }),
    ).rejects.toThrow();
  });

  test("owns exact private start decoding and authority-free poll transport encoding", async () => {
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "hns_recovery_01",
      session_id: "hns_recovery_session_01",
      authority,
      database_started_at: "2026-02-02T04:38:20.000Z",
    });
    const providerStartBytes = await encodeHnsOwnerRecoveryProviderStart(providerStart);
    expect(await decodeHnsOwnerRecoveryProviderStartBytes(providerStartBytes)).toEqual(
      providerStart,
    );
    const { route_recovery_id, session_id, ...providerStartRest } = providerStart;
    await expect(
      decodeHnsOwnerRecoveryProviderStartBytes(
        utf8({ session_id, route_recovery_id, ...providerStartRest }),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsOwnerRecoveryProviderStartBytes(
        utf8({ ...providerStart, provider_start_hash: "f".repeat(64) }),
      ),
    ).rejects.toThrow();

    const startResponse = providerStartResponse();
    expect(decodeHnsOwnerRecoveryProviderStartResponseBytes(utf8(startResponse))).toEqual(
      startResponse,
    );
    expect(() =>
      decodeHnsOwnerRecoveryProviderStartResponseBytes(
        utf8({
          expires_at: startResponse.expires_at,
          upstream_session_ref: startResponse.upstream_session_ref,
          presentation: startResponse.presentation,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeHnsOwnerRecoveryProviderStartResponseBytes(
        utf8({ ...startResponse, provider_diagnostic: "not-public" }),
      ),
    ).toThrow();
    const exactBytes = utf8(startResponse);
    const duplicateBytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(exactBytes)
        .replace(
          '{"upstream_session_ref":"nvs_recovery_01",',
          '{"upstream_session_ref":"nvs_recovery_01","upstream_session_ref":"nvs_recovery_01",',
        ),
    );
    expect(() => decodeHnsOwnerRecoveryProviderStartResponseBytes(duplicateBytes)).toThrow();
    expect(() =>
      decodeHnsOwnerRecoveryProviderStartResponseBytes(
        new Uint8Array([0xef, 0xbb, 0xbf, ...exactBytes]),
      ),
    ).toThrow();

    const session = await fixtureSession();
    const poll = await buildHnsOwnerRecoveryProviderPoll(session, persistedAuthority(session));
    const pollBytes = await encodeHnsOwnerRecoveryProviderPoll(poll, persistedAuthority(session));
    expect(encodeHnsOwnerRecoveryProviderPollRequest(poll)).toEqual(pollBytes);
    expect(await decodeHnsOwnerRecoveryProviderPollBytes(pollBytes)).toEqual(poll);
    await expect(
      decodeHnsOwnerRecoveryProviderPollBytes(
        utf8({
          protocol_version: poll.protocol_version,
          operation_kind: poll.operation_kind,
          session: poll.session,
          payload: poll.payload,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsOwnerRecoveryProviderPollBytes(
        utf8({
          ...poll,
          session: {
            ...poll.session,
            challenge_value: "pirate-verification=substituted-session",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(() =>
      encodeHnsOwnerRecoveryProviderPollRequest({
        protocol_version: poll.protocol_version,
        operation_kind: poll.operation_kind,
        session: poll.session,
        payload: poll.payload,
      }),
    ).toThrow();
  });

  test("reproduces the verified evidence and terminal result vectors", async () => {
    const session = await fixtureSession();
    const responseBytes = utf8(positiveResponse);
    expect(responseBytes.byteLength).toBe(1144);
    const decoded = await decodeHnsOwnerRecoveryTargetResponseBytes(responseBytes);
    expect(decoded.response_sha256).toBe(
      "b39ac18d5079502a8953ed55c32bbf3729b6161bf2932db889a34a0a2e647d49",
    );
    const evidence = await buildHnsOwnerRecoveryEvidence({
      session,
      session_authority: persistedAuthority(session),
      recovery_attempt_id: "hns_recovery_attempt_01",
      poll_request: pollRequest,
      response_bytes: responseBytes,
      policy,
      database_now: "2026-02-02T04:40:00.000Z",
      binding_generation: 14,
      evidence_ref: "route_evidence_14",
    });
    expect(evidence.provider_identity_digest).toBe(
      "92d4ed5353b11a0cdb73c5bb164250f221ee9c4a4f9bd1032179b324ba3e07ce",
    );
    expect(evidence.evidence_digest).toBe(
      "5a99e9edfa4e84b6c321eab23bacb915501c12bae2f9e95f1412d4202cd5932c",
    );
    const verifiedResult = {
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      recovery_attempt_id: "hns_recovery_attempt_01",
      route_binding_id: session.route_binding_id,
      expected_binding_generation: session.expected_binding_generation,
      idempotency_key: pollRequest.idempotency_key,
      poll_hash: evidence.poll_hash,
      outcome_status: "verified",
      evidence_ref_or_null: evidence.evidence_ref,
      evidence_digest_or_null: evidence.evidence_digest,
      provider_response_sha256_or_null: evidence.provider_response_sha256,
      ownership_status_or_null: "verified",
      route_lifecycle_status_or_null: "active",
    } as const;
    const resultHash = await hnsOwnerRecoveryResultHash(verifiedResult);
    expect(resultHash).toBe("13a3f05daa1301f69a83ffafdec54d65606d92b14f5f12c4852c3347c33cbaae");
    const response = await hnsOwnerRecoveryPollResponse({
      session,
      session_authority: persistedAuthority(session),
      outcome: {
        kind: "terminal",
        result: verifiedResult,
      },
    });
    expect(JSON.stringify(response).length).toBe(401);
    expect(response).toMatchObject({ status: "verified", generation: 14, replayed: false });
    expect(
      await hnsOwnerRecoveryPollResponse({
        session,
        session_authority: persistedAuthority(session),
        outcome: { kind: "terminal", result: verifiedResult },
        replayed: true,
      }),
    ).toMatchObject({
      status: "verified",
      generation: 14,
      replayed: true,
      result_hash: resultHash,
    });
  });

  test("reproduces negative and expiry hashes while advancing the generation once", async () => {
    const session = await fixtureSession();
    const pollHash = await hnsOwnerRecoveryPollHash(pollRequest);
    const negativeResult = {
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      recovery_attempt_id: "hns_recovery_attempt_01",
      route_binding_id: session.route_binding_id,
      expected_binding_generation: 13,
      idempotency_key: "recovery-poll-01",
      poll_hash: pollHash,
      outcome_status: "root_absent",
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null:
        "a029f40503343a9843c7a16fbc3139a7d3dc306be99fb043fdacf57a43b87629",
      ownership_status_or_null: "revoked",
      route_lifecycle_status_or_null: "suspended",
    } as const;
    const negativeHash = await hnsOwnerRecoveryResultHash(negativeResult);
    expect(negativeHash).toBe("c00bba1bcd348e7f606c9d5fce48ce47eabbfeebd8cc085bd67e21673d959454");
    expect(
      JSON.stringify(
        await hnsOwnerRecoveryPollResponse({
          session,
          session_authority: persistedAuthority(session),
          outcome: {
            kind: "terminal",
            result: negativeResult,
          },
        }),
      ),
    ).toBe(
      '{"route_recovery_id":"hns_recovery_01","session_id":"hns_recovery_session_01","generation":14,"status":"rejected","reason_code":"root_unavailable","replayed":false,"retry_after_seconds":null,"result_hash":"c00bba1bcd348e7f606c9d5fce48ce47eabbfeebd8cc085bd67e21673d959454"}',
    );
    const expiryResult = {
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      recovery_attempt_id: "hns_recovery_attempt_01",
      route_binding_id: session.route_binding_id,
      expected_binding_generation: 13,
      idempotency_key: "recovery-poll-01",
      poll_hash: pollHash,
      outcome_status: "session_expired",
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null: null,
      ownership_status_or_null: "expired",
      route_lifecycle_status_or_null: "suspended",
    } as const;
    const expiryHash = await hnsOwnerRecoveryResultHash(expiryResult);
    expect(expiryHash).toBe("813bd0cb5854298e2c52a7b8068d5875c9ab899e036c900d84a1ce1f7a6a065e");
    expect(
      JSON.stringify(
        await hnsOwnerRecoveryPollResponse({
          session,
          session_authority: persistedAuthority(session),
          outcome: {
            kind: "terminal",
            result: expiryResult,
          },
        }),
      ),
    ).toBe(
      '{"route_recovery_id":"hns_recovery_01","session_id":"hns_recovery_session_01","generation":14,"status":"expired","replayed":false,"retry_after_seconds":null,"result_hash":"813bd0cb5854298e2c52a7b8068d5875c9ab899e036c900d84a1ce1f7a6a065e"}',
    );
    expect(
      JSON.stringify(
        await hnsOwnerRecoveryPollResponse({
          session,
          session_authority: persistedAuthority(session),
          outcome: {
            kind: "terminal",
            result: {
              ...expiryResult,
              outcome_status: "verified",
              evidence_ref_or_null: "route_evidence_14",
              evidence_digest_or_null:
                "5a99e9edfa4e84b6c321eab23bacb915501c12bae2f9e95f1412d4202cd5932c",
              provider_response_sha256_or_null:
                "b39ac18d5079502a8953ed55c32bbf3729b6161bf2932db889a34a0a2e647d49",
              ownership_status_or_null: "verified",
              route_lifecycle_status_or_null: "active",
            },
          },
          replayed: true,
        }),
      ),
    ).toBe(
      '{"route_recovery_id":"hns_recovery_01","session_id":"hns_recovery_session_01","generation":14,"status":"verified","canonical_route":{"family":"hns","root_label":"jazleeuw","root_label_display":"jazleeuw","path_segment":"app.jazleeuw","href":"/c/app.jazleeuw","app_host":null},"replayed":true,"retry_after_seconds":null,"result_hash":"13a3f05daa1301f69a83ffafdec54d65606d92b14f5f12c4852c3347c33cbaae"}',
    );
  });

  test("maps pending and unavailable retries and rejects system-v1 or challenge substitution", async () => {
    const session = await fixtureSession();
    expect(
      await classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8({
          status: "pending",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "txt_absent",
          observer_result_sha256: "a".repeat(64),
          provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:pending-1`,
        }),
        policy,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).toEqual({ kind: "pending", retry_after_seconds: 5 });
    expect(
      await classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8({
          status: "unavailable",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "observer_capacity",
          retry_after_seconds: null,
          diagnostic_ref: "hns-observer-diagnostic:recovery-capacity-01",
        }),
        policy,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).toMatchObject({ kind: "unavailable", retry_after_seconds: 5 });
    await expect(
      decodeHnsOwnerRecoveryTargetResponseBytes(
        utf8({ status: "pending", protocol_version: "hns-txt-v1" }),
      ),
    ).rejects.toThrow();
    await expect(
      classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8({ ...positiveResponse, challenge_value: "pirate-verification=other" }),
        policy,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      encodeHnsOwnerRecoveryProviderPoll(
        {
          ...(await buildHnsOwnerRecoveryProviderPoll(session, persistedAuthority(session))),
          protocol_version: "hns-txt-v1",
        } as never,
        persistedAuthority(session),
      ),
    ).rejects.toThrow();
    expect(
      await planHnsOwnerRecoveryPoll({
        session,
        session_authority: persistedAuthority(session),
        database_now: session.challenge_expires_at,
      }),
    ).toEqual({ kind: "expired" });
    await expect(
      classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8(positiveResponse),
        policy,
        database_now: session.challenge_expires_at,
      }),
    ).rejects.toThrow();
  });

  test("rejects reordered target bytes, tampered control identity, stale evidence, and stored authority drift", async () => {
    const session = await fixtureSession();
    await expect(
      decodeHnsOwnerRecoveryTargetResponseBytes(
        utf8({
          observation_contract_version: "pirate-hns-target-observation-v2",
          status: "pending",
          reason_code: "txt_absent",
          observer_result_sha256: "a".repeat(64),
          provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:pending-1`,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8({ ...positiveResponse, control_identity_digest: "a".repeat(64) }),
        policy,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      classifyHnsOwnerRecoveryTargetResponse({
        session,
        session_authority: persistedAuthority(session),
        response_bytes: utf8({
          ...positiveResponse,
          expires_at: "2026-02-02T04:39:20.000Z",
        }),
        policy: { ...policy, evidence_lease_seconds: 60 },
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    const sessionAuthority = persistedAuthority(session);
    await expect(
      planHnsOwnerRecoveryPoll({
        session: { ...session, provider_start_hash: "a".repeat(64) },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      } as never),
    ).rejects.toThrow();
    await expect(
      planHnsOwnerRecoveryPoll({
        session: { ...session, challenge_value: "pirate-verification=substituted" },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      } as never),
    ).rejects.toThrow();
    await expect(
      planHnsOwnerRecoveryPoll({
        session: {
          ...session,
          upstream_session_ref: "nvs_recovery_substituted",
          challenge_value: "pirate-verification=nvs_recovery_substituted",
        },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      planHnsOwnerRecoveryPoll({
        session: {
          ...session,
          ownership_source: "owner_authoritative_dns_txt",
          challenge_name: `_pirate.${session.route.root_label}`,
        },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      planHnsOwnerRecoveryPoll({
        session: { ...session, public_start_hash: "a".repeat(64) },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      } as never),
    ).rejects.toThrow();
    const changedActorAuthority = { ...authority, actor_id: "user-2" } as const;
    const changedActorProviderStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      authority: changedActorAuthority,
      database_started_at: session.started_at,
    });
    await expect(
      planHnsOwnerRecoveryPoll({
        session: {
          ...session,
          actor_id: changedActorAuthority.actor_id,
          requirement_hash: await hnsOwnerRecoveryRequirementHash(changedActorAuthority),
          provider_start_hash: changedActorProviderStart.provider_start_hash,
        },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    for (const changedIds of [
      { route_recovery_id: "hns_recovery_other", session_id: session.session_id },
      { route_recovery_id: session.route_recovery_id, session_id: "hns_recovery_session_other" },
    ] as const) {
      const changedIdProviderStart = await buildHnsOwnerRecoveryProviderStart({
        ...changedIds,
        authority,
        database_started_at: session.started_at,
      });
      await expect(
        planHnsOwnerRecoveryPoll({
          session: {
            ...session,
            ...changedIds,
            provider_start_hash: changedIdProviderStart.provider_start_hash,
          },
          session_authority: sessionAuthority,
          database_now: "2026-02-02T04:40:00.000Z",
        }),
      ).rejects.toThrow();
    }
    const changedStart = "2026-02-02T04:39:20.000Z";
    const changedDeadlineProviderStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      authority,
      database_started_at: changedStart,
    });
    await expect(
      planHnsOwnerRecoveryPoll({
        session: {
          ...session,
          started_at: changedStart,
          challenge_expires_at: changedDeadlineProviderStart.challenge_expires_at,
          provider_start_hash: changedDeadlineProviderStart.provider_start_hash,
        },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    const changedRouteAuthority = {
      ...authority,
      route: {
        ...authority.route,
        root_label: "other",
        root_label_display: "other",
        path_segment: "app.other",
        href: "/c/app.other",
      },
    } as const;
    const changedRouteProviderStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      authority: changedRouteAuthority,
      database_started_at: session.started_at,
    });
    await expect(
      planHnsOwnerRecoveryPoll({
        session: {
          ...session,
          route: changedRouteAuthority.route,
          requirement_hash: await hnsOwnerRecoveryRequirementHash(changedRouteAuthority),
          provider_start_hash: changedRouteProviderStart.provider_start_hash,
        },
        session_authority: sessionAuthority,
        database_now: "2026-02-02T04:40:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      decodeHnsOwnerRecoveryTargetResponseBytes(
        utf8({
          status: "pending",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "txt_absent",
          observer_result_sha256: "a".repeat(64),
          provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:`,
        }),
      ),
    ).rejects.toThrow();
  });

  test("accepts canonical internationalized display roots and runtime-rejects fake start outcomes", async () => {
    const internationalAuthority: HnsOwnerRecoveryAuthorityV1 = {
      ...authority,
      route: {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
        app_host: null,
      },
    };
    const internationalStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "hns_recovery_idn_01",
      session_id: "hns_recovery_idn_session_01",
      authority: internationalAuthority,
      database_started_at: "2026-02-02T04:38:20.000Z",
    });
    expect(internationalStart.route.root_label_display).toBe("münchen");

    const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
    const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
      actor_id: authority.actor_id,
      community_id: authority.community_id,
      route_binding_id: authority.route_binding_id,
      expected_binding_generation: authority.expected_binding_generation,
      idempotency_key: startRequest.idempotency_key,
      requirement_hash: requirementHash,
    });
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "hns_recovery_01",
      session_id: "hns_recovery_session_01",
      authority,
      database_started_at: "2026-02-02T04:38:20.000Z",
    });
    await expect(
      finalizeHnsOwnerRecoveryProviderStart({
        provider_start: providerStart,
        public_start_hash: publicStartHash,
        start_request: startRequest,
        started_at: "2026-02-02T04:38:20.000Z",
        provider_response: {
          ...providerStartResponse(),
          presentation: {
            ...providerStartResponse().presentation,
            protocol: "wrong-protocol",
          },
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("rejects terminal matrix substitution and caller-supplied result hashes", async () => {
    expect(() =>
      hnsOwnerRecoveryResultHash({
        route_recovery_id: "hns_recovery_01",
        session_id: "hns_recovery_session_01",
        recovery_attempt_id: "hns_recovery_attempt_01",
        route_binding_id: "route-binding-1",
        expected_binding_generation: 13,
        idempotency_key: "recovery-poll-01",
        poll_hash: sha("cdb7c8239bc15c43986d749d72aea475c1662a4690d8119899ff1b746e192447"),
        outcome_status: "session_expired",
        evidence_ref_or_null: null,
        evidence_digest_or_null: null,
        provider_response_sha256_or_null: "a".repeat(64) as never,
        ownership_status_or_null: "expired",
        route_lifecycle_status_or_null: "suspended",
      }),
    ).toThrow();

    const session = await fixtureSession();
    await expect(
      hnsOwnerRecoveryPollResponse({
        session,
        session_authority: persistedAuthority(session),
        outcome: {
          kind: "terminal",
          result_hash: "a".repeat(64),
          outcome_status: "verified",
        } as never,
      }),
    ).rejects.toThrow();
  });
});
