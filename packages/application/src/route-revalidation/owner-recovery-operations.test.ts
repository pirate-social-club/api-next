import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { HnsEvidenceLeasePolicy } from "../namespace-ownership/hns-control-observer.ts";
import {
  buildHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
  type HnsOwnerRecoveryPersistedSessionAuthority,
  type HnsOwnerRecoveryPersistedSessionV1,
  hnsOwnerRecoveryPollHash,
  hnsOwnerRecoveryPublicStartHash,
  hnsOwnerRecoveryRequirementHash,
  hnsOwnerRecoveryTerminalResultHash,
} from "./owner-recovery.ts";
import {
  HNS_OWNER_RECOVERY_POLL_LEASE_MS,
  HNS_OWNER_RECOVERY_POLL_PROVIDER_DEADLINE_MS,
  HnsOwnerRecoveryPollRejected,
  type HnsOwnerRecoveryPollServices,
  HnsOwnerRecoveryPollStorageFailed,
  type HnsOwnerRecoveryStoredPoll,
  pollHnsOwnerRecovery,
} from "./owner-recovery-poll.ts";
import {
  HNS_OWNER_RECOVERY_START_LEASE_MS,
  HNS_OWNER_RECOVERY_START_PROVIDER_DEADLINE_MS,
  HnsOwnerRecoveryProviderFailed,
  HnsOwnerRecoveryStartRejected,
  type HnsOwnerRecoveryStartServices,
  HnsOwnerRecoveryStartStorageFailed,
  type HnsOwnerRecoveryStoredStart,
  startHnsOwnerRecovery,
} from "./owner-recovery-start.ts";

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
const startInput = {
  actor_id: "user-1",
  community_id: "community-1",
  expected_generation: 13,
  idempotency_key: "recovery-start-01",
} as const;
const pollInput = {
  actor_id: "user-1",
  community_id: "community-1",
  route_recovery_id: "hns_recovery_01",
  session_id: "hns_recovery_session_01",
  expected_generation: 13,
  idempotency_key: "recovery-poll-01",
  channel: "poll_result",
} as const;
const policy: HnsEvidenceLeasePolicy = {
  expected_block_interval_seconds: 600,
  minimum_safe_remaining_blocks: 1,
  expiry_safety_blocks: 100,
  evidence_lease_seconds: 2_592_000,
};
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
  chain_anchor_height: 123_550,
  chain_anchor_block_hash: "6".repeat(64),
  chain_anchor_median_time: 1_770_007_100,
  expiry_height: 200_000,
  observed_at: "2026-02-02T04:38:20.000Z",
  expires_at: "2026-03-04T04:38:20.000Z",
} as const;

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

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

function sessionAuthority(
  session: HnsOwnerRecoveryPersistedSessionV1,
): HnsOwnerRecoveryPersistedSessionAuthority {
  return {
    expected_route_recovery_id: session.route_recovery_id,
    expected_session_id: session.session_id,
    start_idempotency_key: startInput.idempotency_key,
    expected_public_start_hash: session.public_start_hash,
    expected_upstream_session_ref: session.upstream_session_ref,
    expected_ownership_source: session.ownership_source,
    expected_challenge_expires_at: session.challenge_expires_at,
  };
}

async function storedStart(): Promise<HnsOwnerRecoveryStoredStart> {
  const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
  const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    idempotency_key: startInput.idempotency_key,
    requirement_hash: requirementHash,
  });
  const providerStart = await buildHnsOwnerRecoveryProviderStart({
    route_recovery_id: pollInput.route_recovery_id,
    session_id: pollInput.session_id,
    authority,
    database_started_at: "2026-02-02T04:38:20.000Z",
  });
  const finalized = await finalizeHnsOwnerRecoveryProviderStart({
    provider_start: providerStart,
    public_start_hash: publicStartHash,
    start_request: {
      expected_generation: startInput.expected_generation,
      idempotency_key: startInput.idempotency_key,
    },
    started_at: "2026-02-02T04:38:20.000Z",
    provider_response: providerStartResponse(),
  });
  if (finalized.kind !== "retained") throw new Error("recovery fixture was not retained");
  return { session: finalized.session, session_authority: sessionAuthority(finalized.session) };
}

function startServices(
  options: Readonly<{
    readonly replay?: HnsOwnerRecoveryStoredStart;
    readonly reservedAuthority?: HnsOwnerRecoveryAuthorityV1;
    readonly providerFailure?: HnsOwnerRecoveryProviderFailed;
    readonly providerDefect?: "die" | "throw";
    readonly providerResponse?: unknown;
    readonly finalizeFailure?: "die" | "fail" | "throw";
    readonly leaseExpiresAt?: string;
  }> = {},
) {
  const sequence: string[] = [];
  let finalized: HnsOwnerRecoveryStoredStart | undefined;
  let reservedLeaseMs: number | undefined;
  let providerDeadlineMs: number | undefined;
  const services: HnsOwnerRecoveryStartServices = {
    authority: {
      resolve: (input) => {
        sequence.push("resolve");
        return Effect.succeed(input.actor_id === authority.actor_id ? authority : null);
      },
    },
    store: {
      replay: () => {
        sequence.push("replay");
        return Effect.succeed(
          options.replay === undefined
            ? ({ kind: "none" } as const)
            : ({ kind: "replay", stored: options.replay } as const),
        );
      },
      reserve: (input) => {
        sequence.push("reserve");
        reservedLeaseMs = input.lease_ms;
        return Effect.succeed({
          kind: "acquired",
          reservation: {
            reservation_id: "reservation-1",
            route_recovery_id: pollInput.route_recovery_id,
            session_id: pollInput.session_id,
            fence_token: 1,
            database_started_at: "2026-02-02T04:38:20.000Z",
            lease_expires_at: options.leaseExpiresAt ?? "2026-02-02T04:39:20.000Z",
            authority: options.reservedAuthority ?? authority,
          },
        });
      },
      finalize: (input) => {
        sequence.push("finalize");
        if (options.finalizeFailure === "throw") throw new Error("start finalize defect");
        if (options.finalizeFailure === "die") return Effect.die("start finalize defect");
        if (options.finalizeFailure === "fail") {
          return Effect.fail(new HnsOwnerRecoveryStartStorageFailed());
        }
        finalized = { session: input.session, session_authority: input.session_authority };
        return Effect.succeed({ kind: "created" } as const);
      },
      release: () => {
        sequence.push("release");
        return Effect.succeed(undefined);
      },
    },
    provider: {
      start: (request, providerOptions) => {
        sequence.push("provider");
        providerDeadlineMs = providerOptions.deadline_ms;
        if (options.providerDefect === "throw") throw new Error("provider start defect");
        if (options.providerDefect === "die") return Effect.die("provider start defect");
        return options.providerFailure === undefined
          ? Effect.succeed(
              (options.providerResponse ??
                providerStartResponse(request.challenge_expires_at)) as never,
            )
          : Effect.fail(options.providerFailure);
      },
    },
    ids: {
      reservation: () => "reservation-1",
      recovery: () => pollInput.route_recovery_id,
      session: () => pollInput.session_id,
    },
  };
  return {
    services,
    sequence,
    finalized: () => finalized,
    reservedLeaseMs: () => reservedLeaseMs,
    providerDeadlineMs: () => providerDeadlineMs,
  };
}

function pollServices(
  initial: HnsOwnerRecoveryStoredPoll,
  responseBytes: Uint8Array,
  databaseNow = "2026-02-02T04:40:00.000Z",
  options: Readonly<{
    readonly providerDefect?: "die" | "throw";
    readonly leaseExpiresAt?: string;
    readonly finalizeFailure?: "die" | "fail" | "throw";
    readonly finalizeOutcome?: "lease_lost";
    readonly mutateProviderBufferBeforeFinalize?: boolean;
  }> = {},
) {
  const sequence: string[] = [];
  let state = initial;
  let providerCalls = 0;
  let attemptProposalNumber = 0;
  let evidenceProposalNumber = 0;
  let observationProposalNumber = 0;
  let durableAttemptId: string | undefined;
  let durableEvidenceRef: string | undefined;
  let durableObservationId: string | undefined;
  let reservedLeaseMs: number | undefined;
  let providerDeadlineMs: number | undefined;
  let finalizedProviderResponseBytes: Uint8Array | null | undefined;
  const proposedAttemptIds: string[] = [];
  const attemptIds: string[] = [];
  const proposedEvidenceRefs: string[] = [];
  const attemptEvidenceRefs: string[] = [];
  const proposedObservationIds: string[] = [];
  const attemptObservationIds: string[] = [];
  const providerObservationIds: string[] = [];
  const services: HnsOwnerRecoveryPollServices = {
    policy,
    store: {
      load: (input) => {
        sequence.push("load");
        return Effect.succeed(input.actor_id === state.session.actor_id ? state : null);
      },
      reserve: (input) => {
        sequence.push("reserve");
        reservedLeaseMs = input.lease_ms;
        proposedAttemptIds.push(input.recovery_attempt_id);
        proposedEvidenceRefs.push(input.evidence_ref);
        proposedObservationIds.push(input.observation_id);
        durableAttemptId ??= input.recovery_attempt_id;
        durableEvidenceRef ??= input.evidence_ref;
        durableObservationId ??= input.observation_id;
        attemptIds.push(durableAttemptId);
        attemptEvidenceRefs.push(durableEvidenceRef);
        attemptObservationIds.push(durableObservationId);
        return Effect.succeed({
          kind: "acquired",
          attempt: {
            recovery_attempt_id: durableAttemptId,
            evidence_ref: durableEvidenceRef,
            observation_id: durableObservationId,
            fence_token: 1,
            database_now: databaseNow,
            lease_expires_at: options.leaseExpiresAt ?? "2026-02-02T04:41:00.000Z",
          },
          stored: state,
        });
      },
      release: () => {
        sequence.push("release");
        return Effect.succeed({ kind: "released" } as const);
      },
      finalize: (input) => {
        sequence.push("finalize");
        if (options.mutateProviderBufferBeforeFinalize) responseBytes.fill(0);
        finalizedProviderResponseBytes =
          input.provider_response_bytes === null
            ? null
            : new Uint8Array(input.provider_response_bytes);
        if (options.finalizeFailure === "throw") throw new Error("poll finalize defect");
        if (options.finalizeFailure === "die") return Effect.die("poll finalize defect");
        if (options.finalizeFailure === "fail") {
          return Effect.fail(new HnsOwnerRecoveryPollStorageFailed());
        }
        if (options.finalizeOutcome === "lease_lost") {
          return Effect.succeed({ kind: "lease_lost" } as const);
        }
        return Effect.tryPromise({
          try: async () => {
            state = {
              ...state,
              terminal: {
                idempotency_key: input.request.idempotency_key,
                poll_hash: input.poll_hash,
                result_hash: await hnsOwnerRecoveryTerminalResultHash(input.result),
                result: input.result,
              },
            };
            return { kind: "committed", stored: state } as const;
          },
          catch: () => new HnsOwnerRecoveryPollStorageFailed(),
        });
      },
    },
    provider: {
      poll: (_request, providerOptions) => {
        sequence.push("provider");
        providerCalls += 1;
        providerDeadlineMs = providerOptions.deadline_ms;
        providerObservationIds.push(providerOptions.observation_id);
        if (options.providerDefect === "throw") throw new Error("provider poll defect");
        if (options.providerDefect === "die") return Effect.die("provider poll defect");
        return Effect.succeed(responseBytes);
      },
    },
    ids: {
      attempt: () => {
        attemptProposalNumber += 1;
        return attemptProposalNumber === 1
          ? "hns_recovery_attempt_01"
          : `hns_recovery_attempt_proposed_${attemptProposalNumber}`;
      },
      evidence: () => {
        evidenceProposalNumber += 1;
        return evidenceProposalNumber === 1
          ? "route_evidence_14"
          : `route_evidence_proposed_${evidenceProposalNumber}`;
      },
      observation: () => {
        observationProposalNumber += 1;
        return observationProposalNumber === 1
          ? "hns_observation_01"
          : `hns_observation_proposed_${observationProposalNumber}`;
      },
    },
  };
  return {
    services,
    sequence,
    state: () => state,
    providerCalls: () => providerCalls,
    reservedLeaseMs: () => reservedLeaseMs,
    providerDeadlineMs: () => providerDeadlineMs,
    finalizedProviderResponseBytes: () => finalizedProviderResponseBytes,
    proposedAttemptIds,
    attemptIds,
    proposedEvidenceRefs,
    attemptEvidenceRefs,
    proposedObservationIds,
    attemptObservationIds,
    providerObservationIds,
  };
}

describe("HNS owner-recovery application orchestration", () => {
  test("reserves and revalidates authority before calling the provider and finalizing", async () => {
    const fixture = startServices();
    const response = await Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services));
    expect(response).toMatchObject({
      status: "pending",
      replayed: false,
      route_recovery_id: pollInput.route_recovery_id,
      session_id: pollInput.session_id,
      generation: 13,
    });
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "provider", "finalize"]);
    expect(fixture.finalized()?.session.challenge_expires_at).toBe("2026-02-02T05:38:20.000Z");
    expect(fixture.reservedLeaseMs()).toBe(HNS_OWNER_RECOVERY_START_LEASE_MS);
    expect(fixture.providerDeadlineMs()).toBe(HNS_OWNER_RECOVERY_START_PROVIDER_DEADLINE_MS);
  });

  test("replays before authority resolution or provider work", async () => {
    const stored = await storedStart();
    const fixture = startServices({ replay: stored });
    const response = await Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services));
    expect(response).toMatchObject({ status: "pending", replayed: true });
    expect(fixture.sequence).toEqual(["replay"]);
  });

  test("releases a changed reservation authority without calling the provider", async () => {
    const fixture = startServices({
      reservedAuthority: { ...authority, recovery_authority_reference: "changed-transition" },
    });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryStartRejected);
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "release"]);
  });

  test("provider start failure releases the fence and retains no session", async () => {
    const fixture = startServices({
      providerFailure: new HnsOwnerRecoveryProviderFailed({ reason: "unavailable" }),
    });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryProviderFailed", reason: "unavailable" });
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "provider", "release"]);
    expect(fixture.finalized()).toBeUndefined();
  });

  test("normalizes a synchronous provider start defect and releases the fence", async () => {
    const fixture = startServices({ providerDefect: "throw" });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toMatchObject({
      _tag: "HnsOwnerRecoveryProviderFailed",
      reason: "invalid_response",
    });
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "provider", "release"]);
    expect(fixture.finalized()).toBeUndefined();
  });

  test("rejects a provider presentation whose payload deadline differs from the outer response", async () => {
    const valid = providerStartResponse();
    const fixture = startServices({
      providerResponse: {
        ...valid,
        presentation: {
          ...valid.presentation,
          payload: { ...valid.presentation.payload, expires_at: "2026-02-02T05:38:21.000Z" },
        },
      },
    });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toMatchObject({
      _tag: "HnsOwnerRecoveryProviderFailed",
      reason: "invalid_response",
    });
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "provider", "release"]);
    expect(fixture.finalized()).toBeUndefined();
  });

  test("releases the start fence when session finalization fails", async () => {
    const fixture = startServices({ finalizeFailure: "fail" });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryStartStorageFailed);
    expect(fixture.sequence).toEqual([
      "replay",
      "resolve",
      "reserve",
      "provider",
      "finalize",
      "release",
    ]);
    expect(fixture.finalized()).toBeUndefined();
  });

  test("rejects a short start lease before provider work", async () => {
    const fixture = startServices({ leaseExpiresAt: "2026-02-02T04:38:27.999Z" });
    await expect(
      Effect.runPromise(startHnsOwnerRecovery(startInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryStartStorageFailed);
    expect(fixture.sequence).toEqual(["replay", "resolve", "reserve", "release"]);
    expect(fixture.providerDeadlineMs()).toBeUndefined();
  });

  test("returns enumeration-safe absence for a noncreator start", async () => {
    const fixture = startServices();
    await expect(
      Effect.runPromise(
        startHnsOwnerRecovery({ ...startInput, actor_id: "user-2" }, fixture.services),
      ),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryStartRejected", reason: "not_found" });
    expect(fixture.sequence).toEqual(["replay", "resolve"]);
  });

  test("releases a pending provider poll and returns the bounded retry", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(
      stored,
      bytes({
        status: "pending",
        observation_contract_version: "pirate-hns-target-observation-v2",
        reason_code: "txt_absent",
        observer_result_sha256: "a".repeat(64),
        provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:pending-1`,
      }),
    );
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({ status: "pending", retry_after_seconds: 5, replayed: false });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "release"]);
    expect(fixture.reservedLeaseMs()).toBe(HNS_OWNER_RECOVERY_POLL_LEASE_MS);
    expect(fixture.providerDeadlineMs()).toBe(HNS_OWNER_RECOVERY_POLL_PROVIDER_DEADLINE_MS);
  });

  test("reuses the same attempt and evidence reservation on a same-key pending retry", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(
      stored,
      bytes({
        status: "pending",
        observation_contract_version: "pirate-hns-target-observation-v2",
        reason_code: "txt_absent",
        observer_result_sha256: "a".repeat(64),
        provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:pending-1`,
      }),
    );
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(fixture.proposedAttemptIds).toEqual([
      "hns_recovery_attempt_01",
      "hns_recovery_attempt_proposed_2",
    ]);
    expect(fixture.attemptIds).toEqual(["hns_recovery_attempt_01", "hns_recovery_attempt_01"]);
    expect(fixture.proposedEvidenceRefs).toEqual([
      "route_evidence_14",
      "route_evidence_proposed_2",
    ]);
    expect(fixture.attemptEvidenceRefs).toEqual(["route_evidence_14", "route_evidence_14"]);
    expect(fixture.proposedObservationIds).toEqual([
      "hns_observation_01",
      "hns_observation_proposed_2",
    ]);
    expect(fixture.attemptObservationIds).toEqual(["hns_observation_01", "hns_observation_01"]);
    expect(fixture.providerObservationIds).toEqual(["hns_observation_01", "hns_observation_01"]);
    expect(fixture.sequence).toEqual([
      "load",
      "reserve",
      "provider",
      "release",
      "load",
      "reserve",
      "provider",
      "release",
    ]);
  });

  test("releases an exact provider-unavailable response with its bounded retry", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(
      stored,
      bytes({
        status: "unavailable",
        observation_contract_version: "pirate-hns-target-observation-v2",
        reason_code: "chain_transport_unavailable",
        retry_after_seconds: 17,
        diagnostic_ref: "hns-observer-diagnostic:recovery-unavailable-01",
      }),
    );
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({
      status: "unavailable",
      retry_after_seconds: 17,
      result_hash: null,
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "release"]);
    expect(fixture.state().terminal).toBeNull();
  });

  test("commits an exact stable-negative provider response", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const observerHash = "a".repeat(64);
    const fixture = pollServices(
      stored,
      bytes({
        status: "rejected",
        observation_contract_version: "pirate-hns-target-observation-v2",
        reason_code: "root_absent",
        observer_result_sha256: observerHash,
        provider_evidence_ref: `hns-observer-v1:sha256:${observerHash}:negative-1`,
      }),
    );
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({
      status: "rejected",
      reason_code: "root_unavailable",
      generation: 14,
    });
    expect(fixture.state().terminal?.result).toMatchObject({
      outcome_status: "root_absent",
      ownership_status_or_null: "revoked",
      route_lifecycle_status_or_null: "suspended",
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "finalize"]);
  });

  test("normalizes a provider poll defect and releases the attempt", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes({}), undefined, { providerDefect: "die" });
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services)),
    ).rejects.toMatchObject({
      _tag: "HnsOwnerRecoveryProviderFailed",
      reason: "invalid_response",
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "release"]);
    expect(fixture.state().terminal).toBeNull();
  });

  test("rejects a short poll lease before provider work", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes({}), undefined, {
      leaseExpiresAt: "2026-02-02T04:40:15.999Z",
    });
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryPollStorageFailed);
    expect(fixture.sequence).toEqual(["load", "reserve", "release"]);
    expect(fixture.providerCalls()).toBe(0);
  });

  test("returns enumeration-safe absence for a noncreator poll", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes({}));
    await expect(
      Effect.runPromise(
        pollHnsOwnerRecovery({ ...pollInput, actor_id: "user-2" }, fixture.services),
      ),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryPollRejected", reason: "not_found" });
    expect(fixture.sequence).toEqual(["load"]);
    expect(fixture.providerCalls()).toBe(0);
  });

  test("builds verified evidence and commits the next-generation terminal result", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes(positiveResponse));
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({
      status: "verified",
      generation: 14,
      replayed: false,
      canonical_route: { href: "/c/app.jazleeuw" },
    });
    expect(fixture.state().terminal?.result).toMatchObject({
      outcome_status: "verified",
      ownership_status_or_null: "verified",
      route_lifecycle_status_or_null: "active",
      evidence_ref_or_null: "route_evidence_14",
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "finalize"]);
  });

  test("retains an application-owned provider byte snapshot", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const providerBytes = bytes(positiveResponse);
    const expectedBytes = new Uint8Array(providerBytes);
    const fixture = pollServices(stored, providerBytes, undefined, {
      mutateProviderBufferBeforeFinalize: true,
    });
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(providerBytes.every((value) => value === 0)).toBe(true);
    expect(fixture.finalizedProviderResponseBytes()).toEqual(expectedBytes);
  });

  test("releases the poll attempt when terminal finalization fails", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes(positiveResponse), undefined, {
      finalizeFailure: "fail",
    });
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryPollStorageFailed);
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "finalize", "release"]);
    expect(fixture.state().terminal).toBeNull();
  });

  test("maps a lost late-response fence to typed unavailable", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes(positiveResponse), undefined, {
      finalizeOutcome: "lease_lost",
    });
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({
      status: "unavailable",
      retry_after_seconds: 5,
      result_hash: null,
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "finalize"]);
    expect(fixture.state().terminal).toBeNull();
  });

  test("terminalizes database-time expiry without calling the provider", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(
      stored,
      bytes(positiveResponse),
      stored.session.challenge_expires_at,
      { leaseExpiresAt: "2026-02-02T05:39:20.000Z" },
    );
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(response).toMatchObject({ status: "expired", generation: 14, replayed: false });
    expect(fixture.providerCalls()).toBe(0);
    expect(fixture.state().terminal?.result).toMatchObject({
      outcome_status: "session_expired",
      provider_response_sha256_or_null: null,
      ownership_status_or_null: "expired",
      route_lifecycle_status_or_null: "suspended",
    });
    expect(fixture.sequence).toEqual(["load", "reserve", "finalize"]);
  });

  test("replays an exact terminal poll before reservation or provider work", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const first = pollServices(stored, bytes(positiveResponse));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, first.services));
    const replay = pollServices(first.state(), bytes({}));
    const response = await Effect.runPromise(pollHnsOwnerRecovery(pollInput, replay.services));
    expect(response).toMatchObject({ status: "verified", replayed: true, generation: 14 });
    expect(replay.sequence).toEqual(["load"]);
    expect(replay.providerCalls()).toBe(0);
  });

  test("rejects a terminal envelope whose stored result has different idempotency", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const first = pollServices(stored, bytes(positiveResponse));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, first.services));
    const terminal = first.state().terminal;
    if (terminal === null) throw new Error("fixture did not terminalize");
    const replay = pollServices(
      {
        ...first.state(),
        terminal: {
          ...terminal,
          result: { ...terminal.result, idempotency_key: "different-poll" },
        },
      },
      bytes({}),
    );
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, replay.services)),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryPollRejected", reason: "conflict" });
    expect(replay.sequence).toEqual(["load"]);
    expect(replay.providerCalls()).toBe(0);
  });

  test("rejects a stored terminal result-hash mismatch", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const first = pollServices(stored, bytes(positiveResponse));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, first.services));
    const terminal = first.state().terminal;
    if (terminal === null) throw new Error("fixture did not terminalize");
    const replay = pollServices(
      {
        ...first.state(),
        terminal: { ...terminal, result_hash: "f".repeat(64) },
      },
      bytes({}),
    );
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, replay.services)),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryPollRejected", reason: "conflict" });
    expect(replay.sequence).toEqual(["load"]);
    expect(replay.providerCalls()).toBe(0);
  });

  test("invalid provider bytes release the attempt and surface no terminal result", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes({ status: "verified" }));
    await expect(
      Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services)),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryProviderFailed);
    expect(fixture.sequence).toEqual(["load", "reserve", "provider", "release"]);
    expect(fixture.state().terminal).toBeNull();
  });

  test("rejects changed idempotency on a terminal replay", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const first = pollServices(stored, bytes(positiveResponse));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, first.services));
    const replay = pollServices(first.state(), bytes({}));
    await expect(
      Effect.runPromise(
        pollHnsOwnerRecovery({ ...pollInput, idempotency_key: "different-poll" }, replay.services),
      ),
    ).rejects.toBeInstanceOf(HnsOwnerRecoveryPollRejected);
    expect(replay.sequence).toEqual(["load"]);
  });

  test("rejects browser-supplied provider facts at the application boundary", async () => {
    const fixture = startServices();
    await expect(
      Effect.runPromise(
        startHnsOwnerRecovery({ ...startInput, root_label: "attacker" }, fixture.services),
      ),
    ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryStartRejected", reason: "invalid" });
    expect(fixture.sequence).toEqual([]);
  });

  test("the fixture terminal hash is bound to the exact public poll", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const fixture = pollServices(stored, bytes(positiveResponse));
    await Effect.runPromise(pollHnsOwnerRecovery(pollInput, fixture.services));
    expect(fixture.state().terminal?.poll_hash).toBe(
      await hnsOwnerRecoveryPollHash({
        route_recovery_id: pollInput.route_recovery_id,
        session_id: pollInput.session_id,
        expected_generation: pollInput.expected_generation,
        idempotency_key: pollInput.idempotency_key,
        channel: pollInput.channel,
      }),
    );
  });
});
