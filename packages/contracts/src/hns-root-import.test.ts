import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
  HnsCommunityRootImportSessionResponseV1,
  HnsRootImportSessionResponseV1,
  PollHnsRootImport,
  StartHnsCommunityRootImport,
} from "./hns-root-import.ts";

const signature = btoa("\u0001".repeat(64));

describe("HNS root-import contract", () => {
  test("keeps legacy poll valid and accepts only a compact provisioning signature", () => {
    const body = PollHnsRootImport.request.body;
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(body)({ expected_revision: 1, idempotency_key: "poll-1" }),
      ),
    ).toBe(true);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(body)({
          expected_revision: 1,
          idempotency_key: "poll-1",
          provisioning_name_signature: signature,
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(body)({
          expected_revision: 1,
          idempotency_key: "poll-1",
          provisioning_name_signature: "AQ==",
        }),
      ),
    ).toBe(true);
  });

  test("presents the exact wallet operation and bounded message while awaiting ownership", () => {
    const result = Schema.decodeUnknownOption(HnsRootImportSessionResponseV1)({
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      root_import_session_id: "root-import-1",
      namespace_session_id: "namespace-1",
      root_label: "dankmemes",
      revision: 1,
      expires_at: "2026-09-09T00:00:00.000Z",
      replayed: false,
      status: "awaiting_ownership",
      ownership_challenge: {
        ownership_source: "hns_parent_chain_txt",
        record: { type: "TXT", txt: ["pirate-verification=namespace-1"] },
      },
      provisioning_authorization: {
        kind: "hns_name_signature_v1",
        wallet_rpc_method: "signmessagewithname",
        message: '["pirate-hns-root-import-name-proof-v1","fixture"]',
        expires_at: "2026-09-09T00:00:00.000Z",
      },
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    });
    expect(Option.isSome(result)).toBe(true);
  });

  test("keys an existing-community import by community and a canonical root", () => {
    expect(StartHnsCommunityRootImport.path).toBe("/communities/:communityId/hns-root-imports");
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(StartHnsCommunityRootImport.request.body)({
          root_label: "dankmemes",
          idempotency_key: "start-dankmemes",
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(StartHnsCommunityRootImport.request.body)({
          root_label: "DANKMEMES",
          idempotency_key: "start-dankmemes",
        }),
      ),
    ).toBe(true);
  });

  test("returns a community-shaped signing session without creation-intent authority", () => {
    const result = Schema.decodeUnknownOption(HnsCommunityRootImportSessionResponseV1)({
      community_id: "community_fixture",
      attachment_intent_id: "attachment-1",
      root_import_session_id: "root-import-1",
      root_label: "dankmemes",
      revision: 1,
      expires_at: "2026-09-09T00:00:00.000Z",
      replayed: false,
      status: "awaiting_ownership",
      provisioning_authorization: {
        kind: "hns_name_signature_v1",
        wallet_rpc_method: "signmessagewithname",
        message: '["pirate-hns-community-root-import-name-proof-v1","fixture"]',
        expires_at: "2026-09-09T00:00:00.000Z",
      },
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    });
    expect(Option.isSome(result)).toBe(true);
  });

  test("bounds community failure reasons while accepting older terminal responses", () => {
    const terminal = {
      community_id: "community_fixture",
      attachment_intent_id: "attachment-1",
      root_import_session_id: "root-import-1",
      root_label: "dankmemes",
      revision: 3,
      expires_at: "2026-09-09T00:00:00.000Z",
      replayed: false,
      status: "failed",
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: null,
    };
    expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(terminal)).toBe(true);
    expect(
      Schema.is(HnsCommunityRootImportSessionResponseV1)({
        ...terminal,
        failure_reason: "root_resource_unavailable",
      }),
    ).toBe(true);
    expect(
      Schema.is(HnsCommunityRootImportSessionResponseV1)({
        ...terminal,
        failure_reason: "raw_driver_failure",
      }),
    ).toBe(false);
  });
});

describe("HNS root-import lifecycle projection contract (T12)", () => {
  const baseSession = {
    community_id: "community_123e4567-e89b-42d3-a456-426614174099",
    attachment_intent_id: "attachment-1",
    root_import_session_id: "root-import-1",
    root_label: "dankmemes",
    revision: 4,
    expires_at: "2026-09-30T00:00:00.000Z",
    replayed: false,
    status: "awaiting_owner_update" as const,
    publish_plan: {
      version: "pirate-hns-root-import-publish-plan-v1",
      replacement_semantics: "complete_resource",
      current_records: [],
      preserved_records: [],
      removed_conflicts: [],
      added_records: [],
      replacement_records: [],
      preserved_unknown_record_types: [],
      encoded_resource_sha256: "ab".repeat(32),
      acknowledgement_required: true,
    },
    publish_plan_sha256: "ab".repeat(32),
    readiness_result_sha256: null,
    retry_after_seconds: 30,
  };
  const serverTime = "2026-09-09T12:00:00.000Z";

  function lifecycleFixture(phase: string, overrides: Record<string, unknown> = {}) {
    return {
      phase,
      pending_reason: null,
      deadline: null,
      server_time: serverTime,
      next_check_at: "2026-09-09T12:15:00.000Z",
      retry_hint_seconds: 900,
      permitted_actions: ["poll"],
      observation: null,
      ...overrides,
    };
  }

  test("accepts every lifecycle phase fixture with its deadline kind", () => {
    const phases: ReadonlyArray<[string, unknown, unknown]> = [
      [
        "preparing",
        lifecycleFixture("preparing", {
          pending_reason: "preparing_retained_authority",
          next_check_at: null,
          retry_hint_seconds: null,
        }),
        null,
      ],
      [
        "awaiting_publication",
        lifecycleFixture("awaiting_publication", {
          permitted_actions: ["poll", "acknowledge"],
          deadline: { kind: "publication", at: "2026-09-23T12:00:00.000Z" },
        }),
        null,
      ],
      [
        "checking_publication",
        lifecycleFixture("checking_publication", {
          permitted_actions: ["poll", "check_publication"],
          deadline: { kind: "publication", at: "2026-09-23T12:00:00.000Z" },
        }),
        null,
      ],
      [
        "waiting_safe_commitment",
        lifecycleFixture("waiting_safe_commitment", {
          deadline: { kind: "finality", at: "2026-09-10T12:00:00.000Z" },
          observation: {
            view: "current",
            resource_sha256: "cd".repeat(32),
            tip_height: 812_345,
            update_inclusion_height: 800_000,
            commitment_height: null,
          },
        }),
        null,
      ],
      [
        "checking_authority",
        lifecycleFixture("checking_authority", {
          permitted_actions: ["poll", "refresh_readiness"],
        }),
        null,
      ],
      [
        "ready",
        lifecycleFixture("ready", {
          permitted_actions: ["poll", "activate"],
          next_check_at: "2026-09-09T12:30:00.000Z",
          retry_hint_seconds: 1800,
        }),
        null,
      ],
      ["activated", lifecycleFixture("activated"), null],
      [
        "recovery_required",
        lifecycleFixture("recovery_required", {
          pending_reason: "finality_deadline_reached",
          permitted_actions: ["poll", "recover"],
          next_check_at: null,
          retry_hint_seconds: null,
        }),
        null,
      ],
      [
        "failed",
        lifecycleFixture("failed", {
          pending_reason: "operational_failure_budget_exhausted:transport_failure",
          next_check_at: "2026-09-09T12:01:00.000Z",
          retry_hint_seconds: 60,
        }),
        null,
      ],
    ];
    for (const [phase, lifecycle] of phases) {
      const result = Schema.decodeUnknownOption(HnsCommunityRootImportSessionResponseV1)({
        ...baseSession,
        lifecycle,
      });
      if (Option.isNone(result)) throw new Error(`fixture rejected for phase ${phase}`);
    }
  });

  test("rejects an unknown phase, unbounded reason, or missing server time", () => {
    for (const lifecycle of [
      lifecycleFixture("awaiting_update"),
      lifecycleFixture("ready", { pending_reason: "x".repeat(257) }),
      lifecycleFixture("ready", { server_time: "not-an-instant" }),
      lifecycleFixture("ready", { deadline: { kind: "other", at: serverTime } }),
    ]) {
      const result = Schema.decodeUnknownOption(HnsCommunityRootImportSessionResponseV1)({
        ...baseSession,
        lifecycle,
      });
      if (Option.isSome(result)) throw new Error("malformed lifecycle fixture accepted");
    }
  });

  test("older responses without the additive lifecycle field remain valid", () => {
    const result = Schema.decodeUnknownOption(HnsCommunityRootImportSessionResponseV1)(baseSession);
    expect(Option.isSome(result)).toBe(true);
  });
});
