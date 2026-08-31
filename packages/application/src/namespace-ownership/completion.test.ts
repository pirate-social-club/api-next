import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type {
  NamespaceOwnershipProviderAdapter,
  NamespaceOwnershipProviderCompleteResult,
} from "./adapter.ts";
import {
  NamespaceOwnershipProviderObservationRejected,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderUnavailable,
  NamespaceOwnershipProviderUnboundRejected,
} from "./adapter.ts";
import {
  completeNamespaceOwnership,
  hnsCompletionRequestHash,
  hnsCompletionRequestPreimage,
  hnsTerminalResultHash,
  hnsTerminalResultPreimage,
  type NamespaceOwnershipCompletionAttemptReservation,
  type NamespaceOwnershipCompletionFinalizeOutcome,
  NamespaceOwnershipCompletionRejected,
  type NamespaceOwnershipCompletionReleaseOutcome,
  type NamespaceOwnershipCompletionReservationOutcome,
  type NamespaceOwnershipCompletionStore,
  type NamespaceOwnershipStoredCompletion,
} from "./completion.ts";
import {
  decodeHnsOwnerTargetObservationV3Bytes,
  encodeHnsOwnerTargetObservationV3,
  hnsCreationSourceIneligibleResultV2Hash,
} from "./hns-control-observer-v2.ts";
import { hnsNamespaceStartHash, hnsOwnerChallengeValue } from "./hns-evidence.ts";
import { makeNamespaceOwnershipProviderRegistry } from "./registry.ts";

const NOW = Date.parse("2026-02-03T00:00:00.000Z");
const request = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  session_id: "ns_session-1",
  expected_revision: 1,
  idempotency_key: "poll-01",
  channel: "poll_result" as const,
};
const route = {
  family: "hns" as const,
  root_label: "xn--pokmon-dva",
  root_label_display: "pokémon",
  path_segment: "app.xn--pokmon-dva",
  href: "/c/app.xn--pokmon-dva",
  app_host: null,
};
const startAuthority = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  requirement_hash: "1".repeat(64),
  generation: 1,
  provider_id: "hns.owner.v1",
  provider_binding_hash: "3".repeat(64),
  provider_configuration: {
    kind: "managed" as const,
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};
const reservation: NamespaceOwnershipCompletionAttemptReservation = {
  completion_attempt_id: "completion-attempt-1",
  namespace_session_id: "ns_session-1",
  actor_id: "user-1",
  ceremony_intent_id: "cc_ceremony-1",
  evidence_ref: "hns_evidence_01",
  fence_token: 1,
  lease_expires_at: "2026-02-03T00:00:16.000Z",
};

function verifiedBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      status: "verified",
      provider_evidence_ref: "legacy-obs-01",
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: hnsOwnerChallengeValue("nvs_01"),
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_anchor_height: 123456,
      chain_anchor_block_hash: "5".repeat(64),
      chain_anchor_median_time: 1769999900,
      expiry_height: 200000,
      observed_at: "2026-02-02T00:00:00.000Z",
      expires_at: "2026-03-04T00:00:00.000Z",
    }),
  );
}

async function stored(
  overrides: Partial<NamespaceOwnershipStoredCompletion> = {},
): Promise<NamespaceOwnershipStoredCompletion> {
  const request_hash = await hnsNamespaceStartHash(startAuthority);
  return {
    namespace_session_id: "ns_session-1",
    revision: 1,
    session: {
      ...startAuthority,
      request_hash,
      upstream_session_ref: "nvs_01",
      expires_at: "2026-03-04T00:00:00.000Z",
    },
    status: "pending",
    terminal: null,
    ...overrides,
  };
}

function adapter(
  result:
    | NamespaceOwnershipProviderCompleteResult
    | NamespaceOwnershipProviderObservationRejected
    | NamespaceOwnershipProviderRejected
    | NamespaceOwnershipProviderUnboundRejected
    | NamespaceOwnershipProviderUnavailable,
  calls: { complete: number },
  completeMs = 15_000,
): NamespaceOwnershipProviderAdapter {
  return {
    manifest: {
      provider_id: "hns.owner.v1",
      manifest_version: "1",
      supported_families: ["hns"],
      protocol_versions: ["hns-txt-v1"],
      environments: ["staging"],
      submission_channels: ["poll_result"],
      operation_deadlines: { plan_ms: 1_000, start_ms: 1_000, complete_ms: completeMs },
    },
    plan: () => Effect.succeed({ status: "unsupported" as const }),
    start: () => Effect.die("not used"),
    complete: () => {
      calls.complete += 1;
      return result instanceof Error ? Effect.fail(result) : Effect.succeed(result);
    },
  };
}

async function services(options: {
  readonly initial: NamespaceOwnershipStoredCompletion;
  readonly provider:
    | NamespaceOwnershipProviderCompleteResult
    | NamespaceOwnershipProviderObservationRejected
    | NamespaceOwnershipProviderRejected
    | NamespaceOwnershipProviderUnboundRejected
    | NamespaceOwnershipProviderUnavailable;
  readonly reserve?: NamespaceOwnershipCompletionReservationOutcome;
  readonly release?: NamespaceOwnershipCompletionReleaseOutcome;
  readonly finalize?: NamespaceOwnershipCompletionFinalizeOutcome;
  readonly complete_ms?: number;
}) {
  const calls = {
    load: 0,
    reserve: 0,
    release: 0,
    reject: 0,
    consume: 0,
    verify: 0,
    complete: 0,
  };
  let capturedVerified: Parameters<NamespaceOwnershipCompletionStore["verify"]>[0] | undefined;
  let capturedRejected: Parameters<NamespaceOwnershipCompletionStore["reject"]>[0] | undefined;
  let capturedReserve: Parameters<NamespaceOwnershipCompletionStore["reserve"]>[0] | undefined;
  const store: NamespaceOwnershipCompletionStore = {
    load: () => {
      calls.load += 1;
      return Effect.succeed(options.initial);
    },
    reserve: (input) => {
      calls.reserve += 1;
      capturedReserve = input;
      return Effect.succeed(options.reserve ?? { kind: "acquired", reservation });
    },
    release: () => {
      calls.release += 1;
      return Effect.succeed(options.release ?? { kind: "released" as const });
    },
    reject: (input) => {
      calls.reject += 1;
      capturedRejected = input;
      return Effect.succeed(options.finalize ?? { kind: "committed", result_hash: "8".repeat(64) });
    },
    consume: () => {
      calls.consume += 1;
      return Effect.succeed({ kind: "consumed" as const });
    },
    verify: (input) => {
      calls.verify += 1;
      capturedVerified = input;
      return Effect.succeed(
        options.finalize ?? { kind: "committed", result_hash: input.result_hash },
      );
    },
  };
  const registry = await Effect.runPromise(
    makeNamespaceOwnershipProviderRegistry(
      [adapter(options.provider, calls, options.complete_ms)],
      {
        now: () => NOW,
      },
    ),
  );
  return {
    calls,
    capturedReserve: () => capturedReserve,
    capturedRejected: () => capturedRejected,
    capturedVerified: () => capturedVerified,
    value: {
      store,
      registry,
      ids: {
        attempt: () => reservation.completion_attempt_id,
        evidence: () => reservation.evidence_ref,
      },
    },
  };
}

describe("namespace ownership poll completion", () => {
  test("pins the completion request and terminal result vectors", async () => {
    expect(hnsCompletionRequestPreimage(request)).toBe(
      '["pirate-hns-completion-request-v2","cc_intent-1","cc_ceremony-1","ns_session-1",1,"poll-01","poll_result",{}]',
    );
    await expect(hnsCompletionRequestHash(request)).resolves.toBe(
      "baf902779ead99960d22ec4662ffc9007066c4e823d384b6da97b6797564c06d",
    );
    const rejected = {
      ceremony_intent_id: request.ceremony_intent_id,
      session_id: request.session_id,
      expected_revision: request.expected_revision,
      idempotency_key: request.idempotency_key,
      completion_request_hash: "baf902779ead99960d22ec4662ffc9007066c4e823d384b6da97b6797564c06d",
      status: "rejected" as const,
      evidence_ref: null,
      evidence_digest: null,
      provider_identity_digest: null,
    };
    expect(hnsTerminalResultPreimage(rejected)).toBe(
      '["pirate-hns-terminal-result-v1","cc_ceremony-1","ns_session-1",1,"poll-01","baf902779ead99960d22ec4662ffc9007066c4e823d384b6da97b6797564c06d","rejected",null,null,null]',
    );
    await expect(hnsTerminalResultHash(rejected)).resolves.toBe(
      "ef01c152cc0a7205db726538a7ef70e91666901b37616f9b8881f7a91d6f484d",
    );
    await expect(
      hnsTerminalResultHash({
        ...rejected,
        status: "verified",
        evidence_ref: "hns_evidence_01",
        evidence_digest: "faa2d10678673c9550eac18a5551a127bb84aba093d80bb784754d9a9840cd5a",
        provider_identity_digest:
          "21d53c5e1d466e65cfa1a2997ddf307640592743472df15feb64d4084b5396ff",
      }),
    ).resolves.toBe("5a57ab41cc2e555024d838e861484caafa59eb742a5ed3bd097dea2bc2d8354f");
  });

  test("returns an exact terminal replay before registry or provider access", async () => {
    const requestHash = await hnsCompletionRequestHash(request);
    const initial = await stored({
      status: "completed",
      terminal: {
        status: "verified",
        idempotency_key: request.idempotency_key,
        completion_request_hash: requestHash,
        result_hash: "2".repeat(64),
      },
    });
    let resolved = 0;
    const result = await Effect.runPromise(
      completeNamespaceOwnership(request, {
        store: {
          load: () => Effect.succeed(initial),
          reserve: () => Effect.die("not used"),
          release: () => Effect.die("not used"),
          reject: () => Effect.die("not used"),
          consume: () => Effect.die("not used"),
          verify: () => Effect.die("not used"),
        },
        registry: {
          list: () => [],
          resolve: () => {
            resolved += 1;
            return Effect.die("not used");
          },
        },
      }),
    );
    expect(result).toEqual({
      ceremony_intent_id: request.ceremony_intent_id,
      session_id: request.session_id,
      revision: 1,
      status: "verified",
      replayed: true,
      result_hash: "2".repeat(64),
      retry_after_seconds: null,
    });
    expect(resolved).toBe(0);
    await expect(
      Effect.runPromise(
        completeNamespaceOwnership(
          { ...request, idempotency_key: "different-terminal-key" },
          {
            store: {
              load: () => Effect.succeed(initial),
              reserve: () => Effect.die("not used"),
              release: () => Effect.die("not used"),
              reject: () => Effect.die("not used"),
              consume: () => Effect.die("not used"),
              verify: () => Effect.die("not used"),
            },
            registry: {
              list: () => [],
              resolve: () => Effect.die("not used"),
            },
          },
        ),
      ),
    ).rejects.toMatchObject(
      new NamespaceOwnershipCompletionRejected({ reason: "idempotency_conflict" }),
    );
    await expect(
      Effect.runPromise(
        completeNamespaceOwnership(
          { ...request, creation_intent_id: "cc_intent-other" },
          {
            store: {
              load: () => Effect.succeed(initial),
              reserve: () => Effect.die("not used"),
              release: () => Effect.die("not used"),
              reject: () => Effect.die("not used"),
              consume: () => Effect.die("not used"),
              verify: () => Effect.die("not used"),
            },
            registry: {
              list: () => [],
              resolve: () => {
                resolved += 1;
                return Effect.die("not used");
              },
            },
          },
        ),
      ),
    ).rejects.toMatchObject(new NamespaceOwnershipCompletionRejected({ reason: "not_found" }));
    expect(resolved).toBe(0);
  });

  test("releases pending and unavailable attempts without terminal authority", async () => {
    const initial = await stored();
    const pending = await services({ initial, provider: { status: "pending" } });
    const pendingResult = await Effect.runPromise(
      completeNamespaceOwnership(request, pending.value),
    );
    expect(pendingResult).toMatchObject({ status: "pending", result_hash: null, replayed: false });
    expect(pending.calls).toMatchObject({ reserve: 1, release: 1, complete: 1, verify: 0 });

    const unavailable = await services({
      initial,
      provider: new NamespaceOwnershipProviderUnavailable({
        provider_id: "hns.owner.v1",
        operation: "complete",
      }),
    });
    const unavailableResult = await Effect.runPromise(
      completeNamespaceOwnership(request, unavailable.value),
    );
    expect(unavailableResult).toMatchObject({ status: "unavailable", result_hash: null });
    expect(unavailable.calls).toMatchObject({ release: 1, reject: 0, verify: 0 });
  });

  test("returns durable expiry when retry settlement crosses the session deadline", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: { status: "pending" },
      release: { kind: "expired", result_hash: "9".repeat(64) },
    });
    const result = await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    expect(result).toMatchObject({
      status: "expired",
      replayed: false,
      result_hash: "9".repeat(64),
      retry_after_seconds: null,
    });
    expect(context.calls).toMatchObject({ release: 1, reject: 0, consume: 0, verify: 0 });
  });

  test("releases local provider precondition failures without terminal authority", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: new NamespaceOwnershipProviderUnboundRejected({
        provider_id: "hns.owner.v1",
        operation: "complete",
      }),
    });
    await expect(
      Effect.runPromise(completeNamespaceOwnership(request, context.value)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnboundRejected);
    expect(context.calls).toMatchObject({ release: 1, reject: 0, consume: 0, verify: 0 });
  });

  test("derives the fenced lease from the configured provider deadline", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: { status: "pending" },
      complete_ms: 30_000,
    });
    await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    expect(context.capturedReserve()?.lease_ms).toBe(31_000);
  });

  test("turns an authenticated provider rejection into one terminal failed result", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: new NamespaceOwnershipProviderRejected({
        provider_id: "hns.owner.v1",
        operation: "complete",
      }),
    });
    const result = await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    expect(result).toMatchObject({
      status: "rejected",
      replayed: false,
      result_hash: "8".repeat(64),
    });
    expect(context.calls).toMatchObject({ reject: 1, release: 0, verify: 0, complete: 1 });
  });

  test("retains and hashes an exact target-v3 source-ineligible terminal response", async () => {
    const bytes = await encodeHnsOwnerTargetObservationV3({
      status: "ineligible",
      observation_contract_version: "pirate-hns-target-observation-v3",
      reason_code: "owner_authoritative_source_ineligible",
      ownership_source: "owner_authoritative_dns_txt",
      root_label: route.root_label,
      chain_authority_digest: "6".repeat(64),
      authority_inventory_reference: "authority-inventory:regtest-current",
      authority_inventory_version: "authority-inventory-v1",
      authority_inventory_digest: "7".repeat(64),
      observer_snapshot_sha256: "8".repeat(64),
      observer_result_sha256: "9".repeat(64),
      diagnostic_ref: "hns-observer:regtest:snapshot-01",
    });
    const decoded = await decodeHnsOwnerTargetObservationV3Bytes(bytes);
    const initial = await stored();
    const context = await services({
      initial,
      provider: {
        status: "ineligible",
        observation_contract_version: "pirate-hns-target-observation-v3",
        raw_response_bytes: bytes,
        provider_response_sha256: decoded.response_sha256,
        observation: decoded.response,
      },
    });
    const result = await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    const expectedHash = await hnsCreationSourceIneligibleResultV2Hash({
      ceremony_intent_id: request.ceremony_intent_id,
      session_id: request.session_id,
      expected_revision: request.expected_revision,
      idempotency_key: request.idempotency_key,
      completion_request_hash: await hnsCompletionRequestHash(request),
      provider_response_sha256: decoded.response_sha256,
    });
    expect(result).toMatchObject({ status: "rejected", replayed: false });
    expect(context.capturedRejected()).toMatchObject({
      result_hash: expectedHash,
      target_response: {
        observation_contract_version: "pirate-hns-target-observation-v3",
        status: "ineligible",
        provider_response_sha256: decoded.response_sha256,
      },
    });
    expect(context.capturedRejected()?.target_response?.raw_response_bytes).toEqual(bytes);
    expect(context.calls).toMatchObject({ reject: 1, release: 0, verify: 0 });
  });

  test("preserves the persisted status when a different finalizer receives terminal replay", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: {
        status: "verified",
        evidence_kind: "raw_provider_response_v1",
        provider_evidence_ref: "legacy-obs-01",
        raw_response_bytes: verifiedBytes(),
        observation: JSON.parse(new TextDecoder().decode(verifiedBytes())),
        observed_at: "2026-02-02T00:00:00.000Z",
        expires_at: "2026-03-04T00:00:00.000Z",
      },
      finalize: { kind: "replay", status: "rejected", result_hash: "8".repeat(64) },
    });
    const result = await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    expect(result).toMatchObject({
      status: "rejected",
      replayed: true,
      result_hash: "8".repeat(64),
    });
  });

  test("consumes a semantic ownership contradiction without fabricating a terminal result", async () => {
    const initial = await stored();
    const context = await services({
      initial,
      provider: new NamespaceOwnershipProviderObservationRejected({
        provider_id: "hns.owner.v1",
        operation: "complete",
      }),
    });
    await expect(
      Effect.runPromise(completeNamespaceOwnership(request, context.value)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderObservationRejected);
    expect(context.calls).toMatchObject({ consume: 1, reject: 0, release: 0, verify: 0 });
  });

  test("builds verified evidence from exact bytes and finalizes once", async () => {
    const initial = await stored();
    const bytes = verifiedBytes();
    const observation = JSON.parse(new TextDecoder().decode(bytes));
    const context = await services({
      initial,
      provider: {
        status: "verified",
        evidence_kind: "raw_provider_response_v1",
        provider_evidence_ref: "legacy-obs-01",
        raw_response_bytes: bytes,
        observation,
        observed_at: "2026-02-02T00:00:00.000Z",
        expires_at: "2026-03-04T00:00:00.000Z",
      },
    });
    const result = await Effect.runPromise(completeNamespaceOwnership(request, context.value));
    expect(result).toMatchObject({ status: "verified", replayed: false });
    expect(context.calls).toMatchObject({ verify: 1, release: 0, complete: 1 });
    const finalized = context.capturedVerified();
    expect(finalized?.verified.raw_response_bytes).toEqual(bytes);
    expect(finalized?.verified.envelope).toMatchObject({
      evidence_ref: reservation.evidence_ref,
      provider_evidence_ref: "legacy-obs-01",
      root_label: route.root_label,
    });
  });

  test("releases when provider metadata does not match its retained exact bytes", async () => {
    const initial = await stored();
    const bytes = verifiedBytes();
    const context = await services({
      initial,
      provider: {
        status: "verified",
        evidence_kind: "raw_provider_response_v1",
        provider_evidence_ref: "substituted-observation",
        raw_response_bytes: bytes,
        observation: JSON.parse(new TextDecoder().decode(bytes)),
        observed_at: "2026-02-02T00:00:00.000Z",
        expires_at: "2026-03-04T00:00:00.000Z",
      },
    });
    await expect(
      Effect.runPromise(completeNamespaceOwnership(request, context.value)),
    ).rejects.toBeDefined();
    expect(context.calls).toMatchObject({ release: 1, verify: 0 });
  });

  test("maps reservation admission and stale identities before provider work", async () => {
    const initial = await stored();
    const inFlight = await services({
      initial,
      provider: { status: "pending" },
      reserve: { kind: "in_flight", retry_after_seconds: 7 },
    });
    await expect(
      Effect.runPromise(completeNamespaceOwnership(request, inFlight.value)),
    ).rejects.toMatchObject(
      new NamespaceOwnershipCompletionRejected({
        reason: "completion_in_progress",
        retry_after_seconds: 7,
      }),
    );
    expect(inFlight.calls.complete).toBe(0);

    const stale = await services({
      initial: await stored({ revision: 2 }),
      provider: { status: "pending" },
    });
    await expect(
      Effect.runPromise(completeNamespaceOwnership(request, stale.value)),
    ).rejects.toMatchObject(new NamespaceOwnershipCompletionRejected({ reason: "stale_revision" }));
    expect(stale.calls.reserve).toBe(0);
  });
});
