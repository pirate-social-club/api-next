import { describe, expect, test } from "bun:test";
import type { LearnerAudioUploadCapture } from "@pirate/application/learner-audio-capture";
import {
  bounded,
  deferred,
  dropCommitAcknowledgement,
  fixture,
  harness,
  pgUrl,
  rejected,
  run,
} from "./account-study-producer.pg-fixture.ts";
import { makeElevenLabsStudyBatchTranscriber } from "./study-spoken-audio.ts";

const bucket = { put: async (_key: string, bytes: Uint8Array) => ({ size: bytes.byteLength }) };
const captureFor = async (f: Parameters<Parameters<typeof fixture>[0]>[0], session: string) => {
  const result = await f.admin.query(
    "SELECT read_captured_learner_audio_private_v1(upload_attempt_id) AS capture FROM learner_audio_account_producer_captures WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
    [session],
  );
  return result.rows[0].capture as LearnerAudioUploadCapture;
};

describe.skipIf(!pgUrl)("ordinary Study provider refusal recovery", () => {
  test("explicit refusal settles once, survives lost acknowledgement and permits fresh success", async () => {
    await fixture(async (f) => {
      const lost = dropCommitAcknowledgement("settle_account_spoken_provider_refusal_private_v1");
      const h = harness(f, bucket, { clientFactory: lost.clientFactory });
      const input = await h.input(await h.start("provider-refusal"), "first");
      let calls = 0;
      const provider = makeElevenLabsStudyBatchTranscriber({
        apiKey: "synthetic-fixture",
        fetch: async () => {
          calls++;
          return calls === 1
            ? new Response("private body", { status: 422 })
            : Response.json({
                text: new TextDecoder().decode(input.audio),
                language_code: "en",
                language_probability: 0.99,
              });
        },
      });
      expect(await rejected(h.submit(input, h.protocol, provider))).toMatchObject({
        reason: "provider-refused",
      });
      expect(lost.observed()).toBe(true);
      const capture = await captureFor(f, input.sessionId);
      expect(
        (
          await f.admin.query(
            "SELECT state,refusal_http_status FROM learner_audio_account_provider_calls WHERE upload_attempt_id=$1",
            [capture.uploadAttemptId],
          )
        ).rows,
      ).toEqual([{ state: "known_failed", refusal_http_status: 422 }]);
      await run(h.protocol.providerFailed(capture, 422));
      await expect(
        f.serving.query("SELECT settle_account_spoken_provider_refusal_private_v1($1::jsonb,429)", [
          JSON.stringify(capture),
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        f.serving.query("SELECT settle_account_spoken_provider_refusal_private_v1($1::jsonb,422)", [
          JSON.stringify({ ...capture, sourceOwnerId: "another-owner" }),
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await run(h.store.ordinary.getSession(input))).toMatchObject({
        spoken_submission: null,
      });
      const success = await run(
        h.submit({ ...input, idempotencyKey: "fresh-recording" }, h.protocol, provider),
      );
      expect(success.session_item_id).toBe(input.sessionItemId);
      expect(calls).toBe(2);
      // An old identical callback is an acknowledgement replay, not a mutation
      // of the newer successful generation; conflicting evidence still refuses.
      await run(h.protocol.providerFailed(capture, 422));
      expect(
        (
          await f.admin.query(
            "SELECT state FROM study_spoken_answer_commands WHERE command_id=$1",
            [capture.commandRef],
          )
        ).rows,
      ).toEqual([{ state: "completed" }]);
      const newer = await captureFor(f, input.sessionId);
      await expect(
        f.serving.query("SELECT settle_account_spoken_provider_refusal_private_v1($1::jsonb,422)", [
          JSON.stringify(newer),
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::integer AS n FROM study_attempts_v2 WHERE session_item_id=$1",
            [input.sessionItemId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    });
  }, 90000);

  test("unknown is typed immediately and after lease expiry, is reloadable, and never redispatches", async () => {
    await fixture(async (f) => {
      const h = harness(f, bucket);
      const input = await h.input(await h.start("provider-unknown"), "unknown");
      let calls = 0;
      const provider = makeElevenLabsStudyBatchTranscriber({
        apiKey: "synthetic-fixture",
        fetch: async () => {
          calls++;
          throw new Error("lost response with private provider data");
        },
      });
      expect(await rejected(h.submit(input, h.protocol, provider))).toMatchObject({
        reason: "provider-outcome-unknown",
      });
      const projected = {
        state: "provider_outcome_unknown",
        session_item_id: input.sessionItemId,
        attempt_number: input.attemptNumber,
        next_action: "operator_review",
      };
      expect(await run(h.store.ordinary.getSession(input))).toMatchObject({
        spoken_submission: projected,
      });
      expect(
        await rejected(h.submit({ ...input, idempotencyKey: "retry-live" }, h.protocol, provider)),
      ).toMatchObject({ reason: "provider-outcome-unknown" });
      await f.admin.query(
        "UPDATE study_spoken_answer_commands SET lease_expires_at=reserved_at+interval '1 microsecond' WHERE session_id=$1",
        [input.sessionId],
      );
      expect(
        await rejected(
          h.submit({ ...input, idempotencyKey: "retry-expired" }, h.protocol, provider),
        ),
      ).toMatchObject({ reason: "provider-outcome-unknown" });
      const capture = await captureFor(f, input.sessionId);
      await expect(
        f.serving.query("SELECT settle_account_spoken_provider_refusal_private_v1($1::jsonb,422)", [
          JSON.stringify(capture),
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(
        (
          await f.serving.query(
            "SELECT read_account_study_spoken_block_private_v1('other-account',$1,$2) AS blocked",
            [input.sessionId, input.communityId],
          )
        ).rows,
      ).toEqual([{ blocked: null }]);
      expect(calls).toBe(1);
      expect(
        (
          await f.admin.query(
            "SELECT state,refusal_http_status FROM learner_audio_account_provider_calls WHERE upload_attempt_id=$1",
            [capture.uploadAttemptId],
          )
        ).rows,
      ).toEqual([{ state: "unknown", refusal_http_status: null }]);
    });
  }, 90000);

  test("live provider work is not unknown until its exact lease expires and 503 never redispatches", async () => {
    await fixture(async (f) => {
      const h = harness(f, bucket);
      const input = await h.input(await h.start("provider-live"), "live");
      const entered = deferred<void>();
      const response = deferred<Response>();
      let calls = 0;
      const provider = makeElevenLabsStudyBatchTranscriber({
        apiKey: "synthetic-fixture",
        fetch: async () => {
          calls++;
          entered.resolve();
          return response.promise;
        },
      });
      const original = rejected(h.submit(input, h.protocol, provider));
      try {
        await bounded(entered.promise, "provider admission");
        expect(await run(h.store.ordinary.getSession(input))).toMatchObject({
          spoken_submission: null,
        });
        await f.admin.query(
          "UPDATE study_spoken_answer_commands SET lease_expires_at=reserved_at+interval '1 microsecond' WHERE session_id=$1",
          [input.sessionId],
        );
        expect(await run(h.store.ordinary.getSession(input))).toMatchObject({
          spoken_submission: { state: "provider_outcome_unknown" },
        });
        expect(
          await rejected(
            h.submit({ ...input, idempotencyKey: "expired-replacement" }, h.protocol, provider),
          ),
        ).toMatchObject({ reason: "provider-outcome-unknown" });
        expect(calls).toBe(1);
      } finally {
        response.resolve(new Response("private upstream error", { status: 503 }));
        expect(await bounded(original, "original provider completion")).toMatchObject({
          reason: "provider-outcome-unknown",
        });
      }
      expect(
        (await f.admin.query("SELECT count(*)::integer AS n FROM activity_qualifications")).rows,
      ).toEqual([{ n: 0 }]);
    });
  }, 90000);

  test("short new recordings are refused before capture or provider dispatch", async () => {
    await fixture(async (f) => {
      const h = harness(f, bucket);
      const input = await h.input(await h.start("provider-short"), "short");
      expect(await rejected(h.submit({ ...input, audioDurationMs: 353 }))).toMatchObject({
        reason: "recording-too-short",
      });
      expect(h.calls()).toBe(0);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::integer AS n FROM learner_audio_account_producer_captures WHERE session_id=$1",
            [input.sessionId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(await run(h.submit(input))).toMatchObject({ session_item_id: input.sessionItemId });
    });
  }, 90000);
});
