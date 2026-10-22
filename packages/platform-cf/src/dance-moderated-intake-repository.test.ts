import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import type { ModeratedDanceIntakeReceipt } from "../../contracts/src/dance-moderated-intake.ts";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import {
  makeControlPlaneModeratedDanceIntakeStore,
  makeModeratedDanceUploadSigner,
} from "./dance-moderated-intake-repository.ts";

const create = {
  version: "dance-moderated-intake-v1",
  idempotency_key: "create-key",
  community_id: "community",
  operation: "create",
  song_post_id: "song",
  choreography_id: "dance",
  choreography_revision: 1,
  persona_id: "persona",
  expected_policy_hash: "a".repeat(64),
} as const;
function fixture() {
  let facts = moderatedDanceIntakeFacts(),
    lostCommit = false,
    denied = false,
    counter = 0;
  let sqlFailure: { label: string; state: string } | null = null;
  const calls: string[] = [],
    receipts = new Map<string, { requestHash: string; receipt: ModeratedDanceIntakeReceipt }>();
  const execute: ControlPlaneTransaction["execute"] = (statement) =>
    Effect.gen(function* () {
      calls.push(statement.label);
      if (sqlFailure?.label === statement.label)
        return yield* new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: sqlFailure.state,
          constraint: null,
          outcomeCertainty: "aborted",
        });
      let packet: unknown;
      const body = typeof statement.values[1] === "string" ? JSON.parse(statement.values[1]) : {};
      switch (statement.label) {
        case "dance.intake.lock-replay":
          if (denied)
            return yield* new ControlPlaneStatementFailed({
              label: statement.label,
              sqlState: "DRV02",
              constraint: null,
              outcomeCertainty: "aborted",
            });
          packet = receipts.get(body.idempotency_key) ?? null;
          break;
        case "dance.intake.creation-facts":
          packet = facts;
          break;
        case "dance.intake.apply": {
          const terms = JSON.parse(String(statement.values[4])),
            c = terms.capture;
          const receipt: ModeratedDanceIntakeReceipt = {
            version: "dance-moderated-intake-receipt-v1",
            receipt_id: String(statement.values[3]),
            operation: "create",
            session: {
              version: "dance-moderated-session-v1",
              session_id: c.sessionId,
              review_id: c.reviewId,
              attempt_id: c.attemptId,
              community_id: c.communityId,
              song_post_id: c.songPostId,
              choreography_id: c.choreographyId,
              choreography_revision: c.choreographyRevision,
              terms_hash: terms.terms_hash,
              policy_hash: c.policy.hash,
              consent_version: c.policy.consentVersion,
              consent_hash: c.policy.consentHash,
              retention_hash: c.policy.retentionHash,
              normalization_version: c.policy.normalizationVersion,
              normalization_hash: c.policy.normalizationHash,
              safety_hash: c.policy.safetyHash,
              state: "created",
              created_at_ms: terms.created_at_ms,
              expires_at_ms: c.captureExpiresAtMs,
              body_start_ms: c.bodyStartMs,
              body_end_ms: c.bodyEndMs,
              cue: {
                kind: c.cueId,
                start_ms: c.cueStartMs,
                end_ms: c.cueEndMs,
                hold_ms: c.cueHoldMs,
              },
              maximum_bytes: terms.profile.maximumBytes,
              upload_id: null,
              upload_state: null,
              uploaded_at_ms: null,
              review_deadline_ms: null,
              score_bps: null,
            },
          };
          receipts.set(body.idempotency_key, { requestHash: String(statement.values[2]), receipt });
          packet = receipt;
          break;
        }
        default:
          throw new Error(`unexpected statement ${statement.label}`);
      }
      return { rows: [{ packet }], rowCount: 1 } as never;
    });
  const layer = Layer.succeed(
    ControlPlaneDb,
    ControlPlaneDb.of({
      execute,
      withTransaction: (use) =>
        Effect.gen(function* () {
          const result = yield* use({ execute });
          if (lostCommit) {
            lostCommit = false;
            return yield* new ControlPlaneTransactionOutcomeUnknown({
              phase: "commit",
              label: "commit",
              limitMs: 100,
              elapsedMs: 101,
            });
          }
          return result;
        }),
    }),
  );
  const store = makeControlPlaneModeratedDanceIntakeStore(layer, "dancer", {
    signer: {
      presign: async () => {
        throw new Error("should not sign during command");
      },
    },
    randomId: () => `id-${++counter}`,
    randomU32: () => 1,
  });
  return {
    store,
    failSql: (label: string, state: string) => {
      sqlFailure = { label, state };
    },
    calls,
    receipts,
    setReady: (ready: boolean) => {
      facts = { ...facts, mediaReady: ready };
    },
    setWrongActor: () => {
      facts = { ...facts, accountId: "foreign" };
    },
    loseCommit: () => {
      lostCommit = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
describe("actual private intake repository protocol (offline driver, not SQL proof)", () => {
  test("only the capture-options DRV06 cursor refusal maps to invalid_request", async () => {
    const invalid = fixture();
    invalid.failSql("dance.intake.capture-options", "DRV06");
    await expect(
      Effect.runPromise(invalid.store.captureOptions("community", "song", "f".repeat(64))),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    const privateDenial = fixture();
    privateDenial.failSql("dance.intake.capture-options", "DRV02");
    await expect(
      Effect.runPromise(privateDenial.store.captureOptions("community", "song", "f".repeat(64))),
    ).rejects.toMatchObject({ reason: "not_found" });
    const proofFailure = fixture();
    proofFailure.failSql("dance.intake.creation-facts", "DRV06");
    await expect(Effect.runPromise(proofFailure.store.command(create))).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
  test("creates exact terms then recovers immutable receipt before fresh availability", async () => {
    const f = fixture(),
      first = await Effect.runPromise(f.store.command(create));
    f.setReady(false);
    f.calls.length = 0;
    expect(await Effect.runPromise(f.store.command(create))).toEqual(first);
    expect(f.calls).toEqual(["dance.intake.lock-replay"]);
    expect(f.receipts.size).toBe(1);
    expect(JSON.stringify(first)).not.toMatch(/private_object|accountId|provider|https:/u);
  });
  test("same key changed body conflicts, current private denial still blocks replay", async () => {
    const f = fixture();
    await Effect.runPromise(f.store.command(create));
    await expect(
      Effect.runPromise(f.store.command({ ...create, persona_id: "foreign" })),
    ).rejects.toMatchObject({ reason: "idempotency_conflict" });
    f.deny();
    await expect(Effect.runPromise(f.store.command(create))).rejects.toMatchObject({
      reason: "not_found",
    });
  });
  test("missing current processor or contradictory actor never allocates", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.setReady(false),
      (f: ReturnType<typeof fixture>) => f.setWrongActor(),
    ]) {
      const f = fixture();
      change(f);
      await expect(Effect.runPromise(f.store.command(create))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(f.calls).not.toContain("dance.intake.apply");
      expect(f.receipts.size).toBe(0);
    }
  });
  test("lost COMMIT acknowledgement retains the original command identity without retry", async () => {
    const f = fixture();
    f.loseCommit();
    await expect(Effect.runPromise(f.store.command(create))).rejects.toMatchObject({
      reason: "outcome_unknown",
    });
    expect(f.calls.filter((c) => c === "dance.intake.apply")).toHaveLength(1);
    expect(f.receipts.size).toBe(1);
    const r = await Effect.runPromise(f.store.command(create));
    const saved = f.receipts.get(create.idempotency_key);
    if (saved === undefined) throw new Error("Original receipt missing");
    expect(r).toEqual(saved.receipt);
    expect(f.calls.filter((c) => c === "dance.intake.apply")).toHaveLength(1);
  });
  test("offline signer binds private exact size/type, one-create condition and deadline", async () => {
    const signer = makeModeratedDanceUploadSigner({
      accountId: "a".repeat(32),
      bucket: "private-ingress",
      accessKeyId: "test-key",
      secretAccessKey: "test-only-secret",
      now: () => new Date("2026-10-21T12:00:00.000Z"),
    });
    const target = {
      key: "moderated-dance/ingress/00000000-0000-4000-8000-000000000000/source",
      sizeBytes: 100,
      contentType: "video/mp4" as const,
      expiresInSeconds: 30,
    };
    const r = await signer.presign(target),
      url = new URL(r.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;if-none-match",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("30");
    expect(r.expiresAtMs).toBe(Date.parse("2026-10-21T12:00:30.000Z"));
    expect((await signer.presign({ ...target, sizeBytes: 101 })).url).not.toBe(r.url);
    await expect(signer.presign({ ...target, key: "public/source" })).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});
