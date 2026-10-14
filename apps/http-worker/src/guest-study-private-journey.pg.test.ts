// Five runnable PRIVATE HTTP/PostgreSQL cases after root adoption. No live host,
// provider/device, deployed staging or production activation claim.
import { describe, expect, test } from "bun:test";
import {
  GuestAttachmentIntentV1,
  GuestAuthorityV1,
  GuestLearnerAudioDeletionV1,
  GuestLearningRetentionV1,
  GuestStudyAnswerResultV1,
  GuestStudyPreparedContentV1,
  GuestStudySessionV1,
  GuestStudyStartOperationV1,
  guestParticipationRegistry,
} from "@pirate/contracts";
import { Schema } from "effect";
import {
  guestAccountingNames,
  guestLearningNames,
} from "./guest-authority-controller-composition.ts";
import {
  Browser,
  financialFingerprint,
  type HttpHarness,
  type JourneyFixture,
  journeyFixture,
  json,
  lostCommitAfter,
  pgUrl,
  startBody,
} from "./guest-study-private-journey.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
const source = { communityId: "study-community", postId: "study-post" };
async function body<S extends Schema.ConstraintDecoder<unknown>>(
  response: Response,
  schema: S,
): Promise<S["Type"]> {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(await json(response));
}
async function bootstrap(h: HttpHarness, b: Browser, key: string) {
  const discovered = await h.request(b, "GetGuestAuthorityV1");
  expect(discovered.status).toBe(200);
  b.apply(discovered);
  expect((await body(discovered, GuestAuthorityV1)).state).toBe("absent");
  const issued = await h.request(b, "IssueGuestBootstrapV1", { body: { idempotency_key: key } });
  expect(issued.status).toBe(200);
  b.apply(issued);
  const pending = await body(issued, GuestAuthorityV1),
    selected = pending.selected;
  if (selected === null) throw new Error("Actual pending authority missing");
  b.selected = selected.credential_id;
  const confirmed = await h.request(b, "ConfirmGuestBootstrapV1", {
    body: { credential_id: selected.credential_id, expected_owner_id: selected.owner_id },
  });
  expect(confirmed.status).toBe(200);
  expect(confirmed.headers.getSetCookie()).toHaveLength(0);
  b.apply(confirmed);
  expect((await body(confirmed, GuestAuthorityV1)).state).toBe("confirmed");
  return selected;
}
async function start(h: HttpHarness, b: Browser, owner: string, key: string, mixed = true) {
  const response = await h.request(b, "StartGuestStudySessionV1", {
    path: source,
    body: startBody(owner, key, mixed),
  });
  expect(response.status).toBe(201);
  expect(response.headers.getSetCookie()).toHaveLength(0);
  return body(response, GuestStudySessionV1);
}
function current(session: GuestStudySessionV1) {
  const locator = session.lesson.current;
  if (locator === null) throw new Error("Actual current lesson item required");
  const item = session.items.find((i) => i.session_item_id === locator.session_item_id);
  if (item === undefined) throw new Error("Current item absent");
  return item;
}
function spoken(f: JourneyFixture, session: GuestStudySessionV1, key: string) {
  const item = current(session);
  if (item.presentation.kind !== "say_it_back") throw new Error("Actual spoken item required");
  f.transcript(item.presentation.reference_text);
  const audio = new Uint8Array([7, item.ordinal + 1, 11]);
  return {
    path: {
      communityId: session.community_id,
      sessionId: session.session_id,
      sessionItemId: item.session_item_id,
    },
    audio,
    extraHeaders: {
      "content-type": "audio/webm",
      "idempotency-key": key,
      "x-study-attempt-number": "1",
      "x-audio-duration-ms": "1000",
    },
  };
}
const failure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    details: Schema.optional(Schema.Unknown),
  }),
});
const pendingDetails = Schema.Struct({
  reason_code: Schema.String,
  operation: Schema.Struct({
    operation_kind: Schema.String,
    idempotency_key: Schema.String,
    operation_id: Schema.NullOr(Schema.String),
  }),
  retry_after_seconds: Schema.Int,
});
const noRawProof = (b: Browser, value: unknown) => {
  const encoded = JSON.stringify(value);
  for (const secret of b.cookies.values()) expect(encoded.includes(secret)).toBe(false);
  for (const key of [
    "leaseToken",
    "resourceReservationId",
    "deletionFenceRevision",
    "uploadAttemptId",
    "objectRef",
  ])
    expect(encoded.includes(`"${key}"`)).toBe(false);
};
async function bounded<T>(promise: Promise<T>, limit = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned fixture causal wait exceeded")), limit);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

suite("genuine guest learning private HTTP/PostgreSQL journey", () => {
  test("all16 private controllers serve a real account-free mixed lesson, exact replay and recovery/deletion without money", async () => {
    await journeyFixture(async (f) => {
      const h = f.harness(),
        b = new Browser(),
        baseline = await f.snapshot(),
        finance = await financialFingerprint(f);
      const preview = await h.request(b, "GetPublicStudyPreparedContentV1", {
        path: source,
        query: { target_language: "ar", learner_band: "B1" },
      });
      expect(preview.status).toBe(200);
      expect(preview.headers.getSetCookie()).toHaveLength(0);
      expect((await body(preview, GuestStudyPreparedContentV1)).availability.state).toBe("ready");
      expect(await f.snapshot()).toEqual(baseline);
      const proof = await bootstrap(h, b, "whole-authority"),
        initial = await start(h, b, proof.owner_id, "whole-start");
      expect(initial.items.some((i) => i.exercise_type === "say_it_back")).toBe(true);
      expect(initial.items.some((i) => i.exercise_type === "translation_choice")).toBe(true);
      expect(
        (
          await f.admin.query(
            "SELECT bool_and(account_id IS NULL AND persona_id IS NULL AND participation_owner_kind='guest' AND guest_reward_mode='practice_only' AND guest_reward_terms IS NULL) AS actors FROM study_sessions_v2 WHERE participation_owner_id=$1",
            [proof.owner_id],
          )
        ).rows,
      ).toEqual([{ actors: true }]);
      expect(initial.actor).toEqual({ kind: "guest" });
      expect(initial.reward_mode).toBe("practice_only");
      expect(initial.reward_terms).toBeNull();
      expect(Date.parse(initial.expires_at) - Date.parse(initial.created_at)).toBe(86400000);
      let session = initial,
        steps = 0,
        jsonAnswers = 0,
        spokenAnswers = 0;
      let originalReply: Schema.Schema.Type<typeof GuestStudyAnswerResultV1> | undefined,
        originalRequest: Parameters<HttpHarness["request"]>[2];
      while (session.status === "active" && steps < 12) {
        const item = current(session),
          key = `whole-answer-${steps}`;
        const request =
          item.exercise_type === "say_it_back"
            ? spoken(f, session, key)
            : {
                path: {
                  communityId: session.community_id,
                  sessionId: session.session_id,
                  sessionItemId: item.session_item_id,
                },
                body: { kind: "single_select", choice_key: "a" },
                extraHeaders: { "idempotency-key": key, "x-study-attempt-number": "1" },
              };
        const response = await h.request(b, "SubmitGuestStudyAnswerV1", request);
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        const answer = await body(response, GuestStudyAnswerResultV1);
        noRawProof(b, answer);
        expect(answer.participation.state).toBe("practice_only");
        expect(answer.session.owner_id).toBe(proof.owner_id);
        if (item.exercise_type === "say_it_back") spokenAnswers++;
        else jsonAnswers++;
        if (steps === 0) {
          originalReply = answer;
          originalRequest = request;
        }
        session = answer.session;
        steps++;
      }
      expect(session.status).toBe("completed");
      expect(spokenAnswers).toBeGreaterThan(0);
      expect(jsonAnswers).toBeGreaterThan(0);
      expect(f.providerCalls()).toBe(spokenAnswers);
      expect(f.putCalls()).toBe(spokenAnswers);
      expect(f.objects.size).toBe(spokenAnswers);
      if (originalRequest === undefined || originalReply === undefined)
        throw new Error("Original completed answer required");
      const beforeReplay = await f.snapshot(),
        replay = await h.request(b, "SubmitGuestStudyAnswerV1", originalRequest);
      expect(replay.status).toBe(200);
      expect(await body(replay, GuestStudyAnswerResultV1)).toEqual(originalReply);
      expect(await f.snapshot()).toEqual(beforeReplay);
      expect(f.providerCalls()).toBe(spokenAnswers);
      expect(f.putCalls()).toBe(spokenAnswers);
      const read = await h.request(b, "GetGuestStudySessionV1", {
        path: { communityId: source.communityId, sessionId: session.session_id },
      });
      expect(await body(read, GuestStudySessionV1)).toEqual(session);
      const lookup = await h.request(b, "GetGuestStudyStartOperationV1", {
        path: { ...source, idempotencyKey: "whole-start" },
      });
      expect((await body(lookup, GuestStudyStartOperationV1)).state).toBe("completed");
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
          })
        ).status,
      ).toBe(200);
      const oldCookie = b.cookies.get(`__Host-pirate_guest_${proof.credential_id}`);
      if (oldCookie === undefined) throw new Error("Actual predecessor proof required");
      const rotation = await h.request(b, "RotateGuestCredentialV1", {
        body: { expected_owner_id: proof.owner_id, idempotency_key: "whole-rotation" },
      });
      b.apply(rotation);
      const successor = (await body(rotation, GuestAuthorityV1)).selected;
      if (successor === null) throw new Error("Actual successor missing");
      b.selected = successor.credential_id;
      b.cookies.delete(`__Host-pirate_guest_${proof.credential_id}`);
      const ack = await h.request(b, "AcknowledgeGuestCredentialV1", {
        body: {
          expected_owner_id: proof.owner_id,
          predecessor_credential_id: proof.credential_id,
          successor_credential_id: successor.credential_id,
        },
      });
      expect(ack.status).toBe(200);
      b.apply(ack);
      b.cookies.set(`__Host-pirate_guest_${proof.credential_id}`, oldCookie);
      const cleanup = await h.request(b, "CleanupGuestBrowserProofV1", {
        body: {
          selected_credential_id: successor.credential_id,
          candidate_credential_ids: [proof.credential_id],
          candidate_intent_ids: [],
        },
      });
      expect(cleanup.status).toBe(200);
      b.apply(cleanup);
      const intent = await h.request(b, "CreateGuestAttachmentIntentV1", {
        body: { expected_owner_id: proof.owner_id, idempotency_key: "whole-intent" },
      });
      expect(intent.status).toBe(200);
      b.apply(intent);
      expect((await body(intent, GuestAttachmentIntentV1)).state).toBe("awaiting_account");
      const participations = await h.request(b, "ListGuestParticipationsV1");
      expect(participations.status).toBe(200);
      expect(await json(participations)).toEqual({ items: [], next_cursor: null });
      const retention = await h.request(b, "SetGuestLearningRetentionV1", {
        body: { idempotency_key: "whole-retention", mode: "ephemeral" },
      });
      expect((await body(retention, GuestLearningRetentionV1)).mode).toBe("ephemeral");
      const deletion = await h.request(b, "DeleteGuestLearnerAudioV1", {
        extraHeaders: { "idempotency-key": "whole-delete" },
      });
      expect(deletion.status).toBe(200);
      const deleted = await body(deletion, GuestLearnerAudioDeletionV1);
      expect(deleted.state).toBe("completed");
      expect(deleted.deleted_count).toBe(spokenAnswers);
      expect(deleted.remaining_count).toBe(0);
      // Local deletion has no provider-side deletion receipt.
      expect(deleted.provider_disposition).toBe("unknown");
      expect(f.objects.size).toBe(0);
      noRawProof(b, deleted);
      const after = await f.snapshot();
      for (const field of ["accounts", "personas", "memberships"] as const)
        expect(after[field]).toBe(baseline[field]);
      expect(await financialFingerprint(f)).toEqual(finance);
      expect(
        guestLearningNames.every(
          (name) => guestParticipationRegistry[name].implementation === undefined,
        ),
      ).toBe(true);
      expect(
        guestAccountingNames.every(
          (name) => guestParticipationRegistry[name].implementation === undefined,
        ),
      ).toBe(true);
    });
  }, 120000);

  test("real start COMMIT loss returns pending, original lookup/retry recover one actual session and reservation", async () => {
    await journeyFixture(async (f) => {
      const normal = f.harness(),
        b = new Browser(),
        proof = await bootstrap(normal, b, "lost-start-authority");
      const fault = lostCommitAfter("SELECT commit_guest_study_start_v1("),
        faulty = f.harness({ clientFactory: fault.clientFactory });
      const response = await faulty.request(b, "StartGuestStudySessionV1", {
        path: source,
        body: startBody(proof.owner_id, "lost-original-start", false),
      });
      expect(fault.observed()).toBe(true);
      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      const refused = await body(response, failure),
        details = Schema.decodeUnknownSync(pendingDetails)(refused.error.details);
      expect(details.operation.idempotency_key).toBe("lost-original-start");
      expect(details.operation.operation_kind).toBe("study_start");
      const before = await f.snapshot();
      expect(before.sessions).toBe(1);
      expect(before.reservations).toBe(1);
      expect(before.calls).toBe(0);
      const found = await normal.request(b, "GetGuestStudyStartOperationV1", {
        path: { ...source, idempotencyKey: "lost-original-start" },
      });
      const outcome = await body(found, GuestStudyStartOperationV1);
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("Original actual committed session required");
      const replay = await start(normal, b, proof.owner_id, "lost-original-start", false);
      expect(replay).toEqual(outcome.session);
      expect(await f.snapshot()).toEqual(before);
      expect(f.providerCalls()).toBe(0);
      expect(f.putCalls()).toBe(0);
    });
  }, 120000);

  test("accepted spoken CP COMMIT loss recovers exact grade/archive once despite absent current policy/disclosure; visibility refusal preserves success", async () => {
    await journeyFixture(async (f) => {
      const normal = f.harness(),
        b = new Browser(),
        proof = await bootstrap(normal, b, "lost-cp-authority"),
        session = await start(normal, b, proof.owner_id, "lost-cp-start", false);
      const request = spoken(f, session, "lost-cp-answer"),
        fault = lostCommitAfter("SELECT persist_owner_guest_spoken_success_v1(");
      const pending = await f
        .harness({ clientFactory: fault.clientFactory })
        .request(b, "SubmitGuestStudyAnswerV1", request);
      expect(fault.observed()).toBe(true);
      expect(pending.status).toBe(409);
      expect(pending.headers.getSetCookie()).toHaveLength(0);
      expect(f.providerCalls()).toBe(1);
      expect(f.putCalls()).toBe(0);
      expect((await f.snapshot()).checkpoints).toBe(1);
      const recovery = f.harness({ policyAbsent: true, disclosureAbsent: true });
      const result = await recovery.request(b, "SubmitGuestStudyAnswerV1", request);
      expect(result.status).toBe(200);
      const accepted = await body(result, GuestStudyAnswerResultV1);
      expect(accepted.participation.state).toBe("practice_only");
      noRawProof(b, accepted);
      expect(f.providerCalls()).toBe(1);
      expect(f.putCalls()).toBe(1);
      const before = await f.snapshot();
      const replay = await recovery.request(b, "SubmitGuestStudyAnswerV1", request);
      expect(replay.status).toBe(200);
      expect(await body(replay, GuestStudyAnswerResultV1)).toEqual(accepted);
      expect(f.providerCalls()).toBe(1);
      expect(f.putCalls()).toBe(1);
      expect(await f.snapshot()).toEqual(before);
      await f.admin.query(
        "UPDATE posts SET visibility='members_only' WHERE community_id=$1 AND post_id=$2",
        [source.communityId, source.postId],
      );
      const hidden = await recovery.request(b, "SubmitGuestStudyAnswerV1", request);
      expect(hidden.status).toBe(404);
      expect((await body(hidden, failure)).error.code).toBe("not_found");
      expect(await f.snapshot()).toEqual(before);
      expect(f.providerCalls()).toBe(1);
      expect(f.putCalls()).toBe(1);
    });
  }, 120000);

  test("real cookies/origin/CSRF/explicit selection refuse before decoder, and actual JSON/audio limits create no effects", async () => {
    await journeyFixture(async (f) => {
      const h = f.harness(),
        b = new Browser(),
        proof = await bootstrap(h, b, "boundary-authority"),
        session = await start(h, b, proof.owner_id, "boundary-start", false),
        baseline = await f.snapshot();
      const prior = h.decoderCalls(),
        cross = b.headers(true);
      cross.set("origin", "https://another.example");
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
            headers: cross,
          })
        ).status,
      ).toBe(401);
      const csrf = b.headers(true);
      csrf.set("x-guest-csrf-token", "A".repeat(43));
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
            headers: csrf,
          })
        ).status,
      ).toBe(401);
      const selected = b.headers(true);
      selected.set(
        "x-guest-credential-id",
        proof.credential_id === "A".repeat(22) ? `${"B".repeat(21)}A` : "A".repeat(22),
      );
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
            headers: selected,
          })
        ).status,
      ).toBe(401);
      const bearer = b.headers(true);
      bearer.set("authorization", "Bearer never-authorizes-guest");
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
            headers: bearer,
          })
        ).status,
      ).toBe(401);
      const duplicate = b.headers(true);
      duplicate.set(
        "cookie",
        `${duplicate.get("cookie")}; __Host-pirate_guest_${proof.credential_id}=${b.cookies.get(`__Host-pirate_guest_${proof.credential_id}`) ?? ""}`,
      );
      expect(
        (
          await h.request(b, "RenewGuestAuthorityV1", {
            body: { expected_owner_id: proof.owner_id },
            headers: duplicate,
          })
        ).status,
      ).toBe(400);
      expect(h.decoderCalls()).toBe(prior);
      const request = spoken(f, session, "oversized-original");
      expect(
        (
          await h.request(b, "SubmitGuestStudyAnswerV1", {
            ...request,
            audio: new Uint8Array(524289),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await h.request(b, "SubmitGuestStudyAnswerV1", {
            ...request,
            extraHeaders: { ...request.extraHeaders, "x-audio-duration-ms": "60001" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await h.request(b, "IssueGuestBootstrapV1", {
            body: { idempotency_key: "x".repeat(5000) },
          })
        ).status,
      ).toBe(400);
      expect(await f.snapshot()).toEqual(baseline);
      expect(f.providerCalls()).toBe(0);
      expect(f.putCalls()).toBe(0);
    });
  }, 120000);

  test("proof-authorized native fence retains late PUT/checkpoint and unknown deletion until original command reconciles", async () => {
    await journeyFixture(async (f) => {
      const h = f.harness(),
        b = new Browser(),
        proof = await bootstrap(h, b, "fence-authority"),
        session = await start(h, b, proof.owner_id, "fence-start", false),
        finance = await financialFingerprint(f);
      const held = f.holdNextPut(),
        answerPromise = h.request(
          b,
          "SubmitGuestStudyAnswerV1",
          spoken(f, session, "fence-answer"),
        );
      await bounded(
        Promise.race([
          held.started,
          answerPromise.then(() => {
            throw new Error("Answer ended before actual PUT");
          }),
        ]),
      );
      expect(f.providerCalls()).toBe(1);
      expect((await f.snapshot()).checkpoints).toBe(1);
      const deleting = await h.request(b, "DeleteGuestLearnerAudioV1", {
        extraHeaders: { "idempotency-key": "fence-delete" },
      });
      expect(deleting.status).toBe(202);
      expect((await body(deleting, GuestLearnerAudioDeletionV1)).state).toBe("pending");
      held.release();
      const late = await bounded(answerPromise);
      expect([200, 409]).toContain(late.status);
      const uploads = (
        await f.admin.query("SELECT io_state,cleanup_required FROM learner_audio_upload_attempts")
      ).rows;
      expect(uploads).toEqual([{ io_state: "closed", cleanup_required: true }]);
      expect(f.objects.size).toBe(1);
      f.rejectNextDelete();
      const uncertain = await h.request(b, "DeleteGuestLearnerAudioV1", {
        extraHeaders: { "idempotency-key": "fence-delete" },
      });
      expect(uncertain.status).toBe(202);
      const pending = await body(uncertain, GuestLearnerAudioDeletionV1);
      expect(pending.state).toBe("pending");
      expect(pending.operation.idempotency_key).toBe("fence-delete");
      expect(f.objects.size).toBe(1);
      const done = await h.request(b, "DeleteGuestLearnerAudioV1", {
        extraHeaders: { "idempotency-key": "fence-delete" },
      });
      expect(done.status).toBe(200);
      const deleted = await body(done, GuestLearnerAudioDeletionV1);
      expect(deleted.state).toBe("completed");
      expect(deleted.operation.operation_id).toBe(pending.operation.operation_id);
      expect(f.objects.size).toBe(0);
      expect((await f.snapshot()).checkpoints).toBe(1);
      expect(f.providerCalls()).toBe(1);
      expect(f.putCalls()).toBe(1);
      expect(await financialFingerprint(f)).toEqual(finance);
      noRawProof(b, deleted);
    });
  }, 120000);
});
