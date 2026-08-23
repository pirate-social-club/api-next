import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { OwnerRecoveryInProgress } from "./errors.ts";
import {
  HnsOwnerRecoveryPollRequestV1,
  HnsOwnerRecoveryPollResponseV1,
  HnsOwnerRecoveryStartRequestV1,
  HnsOwnerRecoveryStartResponseV1,
  PollHnsOwnerRecovery,
  StartHnsOwnerRecovery,
} from "./hns-owner-recovery.ts";

const exactOptions = { onExcessProperty: "error" } as const;

describe("HNS owner-recovery endpoint contracts", () => {
  test("freezes paths, browser auth, status unions, and byte caps", () => {
    expect(StartHnsOwnerRecovery.path).toBe(
      "/communities/:communityId/canonical-route/ownership-recovery/start",
    );
    expect(StartHnsOwnerRecovery.auth).toEqual({
      policy: { kind: "user" },
      browserSessionOnly: true,
    });
    expect(StartHnsOwnerRecovery.successStatus).toEqual([200, 201]);
    expect(StartHnsOwnerRecovery.request?.maxBodyBytes).toBe(1_024);
    expect(PollHnsOwnerRecovery.path).toBe(
      "/communities/:communityId/canonical-route/ownership-recovery/poll",
    );
    expect(PollHnsOwnerRecovery.successStatus).toEqual([200, 202, 422, 503]);
    expect(PollHnsOwnerRecovery.request?.maxBodyBytes).toBe(2_048);
    expect(PollHnsOwnerRecovery.errors).toContain(OwnerRecoveryInProgress);
  });

  test("keeps start and poll requests exact and ordered", () => {
    const start = Schema.decodeUnknownSync(
      HnsOwnerRecoveryStartRequestV1,
      exactOptions,
    )({
      expected_generation: 7,
      idempotency_key: "start-1",
    });
    expect(JSON.stringify(start)).toBe('{"expected_generation":7,"idempotency_key":"start-1"}');
    expect(() =>
      Schema.decodeUnknownSync(
        HnsOwnerRecoveryStartRequestV1,
        exactOptions,
      )({
        expected_generation: 7,
        idempotency_key: "start-1",
        root_label: "forged",
      }),
    ).toThrow();

    const poll = Schema.decodeUnknownSync(
      HnsOwnerRecoveryPollRequestV1,
      exactOptions,
    )({
      route_recovery_id: "recovery-1",
      session_id: "session-1",
      expected_generation: 7,
      idempotency_key: "poll-1",
      channel: "poll_result",
    });
    expect(Object.keys(poll)).toEqual([
      "route_recovery_id",
      "session_id",
      "expected_generation",
      "idempotency_key",
      "channel",
    ]);
    expect(
      Schema.is(StartHnsOwnerRecovery.request?.path)({ communityId: "community_1-safe" }),
    ).toBe(true);
    expect(Schema.is(StartHnsOwnerRecovery.request?.path)({ communityId: "unsafe/id" })).toBe(
      false,
    );
  });

  test("accepts only coherent public recovery response members", () => {
    const challenge = {
      ownership_source: "hns_parent_chain_txt" as const,
      challenge_name: "_pirate-recovery.example",
      challenge_value: "pirate-verification=opaque",
      expires_at: "2026-08-23T12:00:00.000Z",
    };
    expect(
      Schema.is(HnsOwnerRecoveryStartResponseV1)({
        route_recovery_id: "recovery-1",
        session_id: "session-1",
        generation: 7,
        channel: "poll_result",
        status: "pending",
        expires_at: challenge.expires_at,
        challenge,
        replayed: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(HnsOwnerRecoveryPollResponseV1)({
        route_recovery_id: "recovery-1",
        session_id: "session-1",
        generation: 8,
        status: "pending",
        replayed: false,
        retry_after_seconds: 3_601,
        result_hash: null,
      }),
    ).toBe(false);
    expect(
      Schema.is(HnsOwnerRecoveryPollResponseV1)({
        route_recovery_id: "recovery-1",
        session_id: "session-1",
        generation: 8,
        status: "verified",
        canonical_route: {
          family: "hns",
          root_label: "jazleeuw",
          root_label_display: "jazleeuw",
          path_segment: "app.jazleeuw",
          href: "/c/app.jazleeuw",
          app_host: null,
        },
        replayed: false,
        retry_after_seconds: null,
        result_hash: "a".repeat(64),
      }),
    ).toBe(true);
  });
});
