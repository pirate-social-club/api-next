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
});
