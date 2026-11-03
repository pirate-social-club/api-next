import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { prepareModeratedDanceTerms } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { projectPrivateDanceReview } from "../../application/src/use-cases/dance/moderator-review-services.ts";
import {
  initializeModeratorReview,
  type ReviewActor,
  type ReviewFacts,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import { SealedModeratorCaptureSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import { moderatedDanceFixture } from "../../testing/src/moderated-dance-fixture.ts";
import type { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";

// Synthetic historical review graph for authority/clock tests only. It is not
// evidence of a provider, R2 upload or real participant recording.
export async function historicalReview(
  f: Awaited<ReturnType<typeof seed>>,
  admin: Client,
  deadline: number,
  stage: "uploaded" | "awaiting_review" = "awaiting_review",
) {
  const uploaded = deadline - 604800000,
    created = uploaded - 1000;
  const ids = {
      sessionId: crypto.randomUUID(),
      reviewId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
    },
    uploadId = crypto.randomUUID(),
    consentId = crypto.randomUUID();
  const terms = await Effect.runPromise(
    prepareModeratedDanceTerms(
      {
        ...f.facts,
        nowMs: created,
        policyId: f.publication.policy_id,
        policy: f.publication.policy,
        disposition: f.publication.disposition,
      },
      ids,
      f.publication.policy.version === "moderator-review-policy-v2" ? "none" : "arms_t",
    ),
  );
  const capture = Schema.decodeUnknownSync(SealedModeratorCaptureSchema)({
    ...terms.capture,
    uploadId,
    sourceDigest: "a".repeat(64),
    normalizedDigest: "b".repeat(64),
    analysisRevision: 1,
    firstStoredAtMs: created + 3,
    uploadedAtMs: uploaded,
    consent: {
      receiptId: consentId,
      uploadId,
      recordedAtMs: created + 1,
      accountId: f.facts.accountId,
      personaId: f.facts.personaId,
      termsHash: terms.terms_hash,
      version: terms.capture.policy.consentVersion,
      policyHash: terms.capture.policy.consentHash,
    },
  });
  const facts: ReviewFacts = {
    ...moderatedDanceFixture().facts,
    accountFenceRevision: 1,
    ownedPersona: {
      active: true,
      accountId: capture.accountId,
      personaId: capture.personaId,
      communityId: capture.communityId,
    },
    owner: {
      accountId: "private-test-owner",
      communityId: capture.communityId,
      assignmentId: "private-owner-assignment",
      revision: 1,
      canInspect: true,
    },
    media: {
      accepted: true,
      sourceDigest: capture.sourceDigest,
      normalizedDigest: capture.normalizedDigest,
      normalizationVersion: capture.policy.normalizationVersion,
      normalizationHash: capture.policy.normalizationHash,
    },
    safety: {
      status: "accepted",
      persisted: true,
      sourceDigest: capture.sourceDigest,
      analysisRevision: 1,
      policyHash: capture.policy.safetyHash,
      frameDigests: ["6".repeat(64), "7".repeat(64), "8".repeat(64)],
    },
    integrity: {
      status: "unique",
      persisted: true,
      sourceDigest: capture.sourceDigest,
      normalizedDigest: capture.normalizedDigest,
      policyHash: capture.policy.normalizationHash,
    },
    disposition: f.publication.disposition,
    qualification: null,
    submissionDay: {
      atMs: uploaded + 1,
      day: new Date(uploaded + 1).toISOString().slice(0, 10),
      timezone: capture.timezone,
      timezoneVersion: capture.timezoneVersion,
    },
  };
  let state = initializeModeratorReview(capture, facts, uploaded);
  if (state === null) throw new Error("Invalid historical review fixture");
  if (stage === "awaiting_review") {
    const submit = transitionModeratorReview(
      state,
      {
        kind: "submit",
        receiptId: "historical-submit",
        showPublicly: false,
        disclosureVersion: capture.policy.disclosureVersion,
      },
      { kind: "account", accountId: capture.accountId },
      state.revision,
      uploaded + 1,
      facts,
    );
    expect(submit.refusal).toBeNull();
    const screen = transitionModeratorReview(
      submit.state,
      { kind: "screen" },
      { kind: "worker", accountId: "fixture-worker" },
      submit.state.revision,
      uploaded + 2,
      facts,
    );
    expect(screen.refusal).toBeNull();
    state = screen.state;
  }
  await admin.query(
    "INSERT INTO dance_review_account_fences_v1(account_id,revision,erasing) VALUES($1,1,FALSE) ON CONFLICT DO NOTHING",
    [capture.accountId],
  );
  await admin.query(
    "INSERT INTO dance_moderated_sessions_v1(session_id,review_id,attempt_id,account_id,persona_id,community_id,song_post_id,choreography_id,choreography_revision,policy_id,capture_account_fence,terms,terms_hash,created_at,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,1,$10::jsonb,$11,to_timestamp($12::NUMERIC/1000),to_timestamp($13::NUMERIC/1000),'uploaded')",
    [
      ids.sessionId,
      ids.reviewId,
      ids.attemptId,
      capture.accountId,
      capture.personaId,
      capture.communityId,
      capture.songPostId,
      capture.choreographyId,
      f.publication.policy_id,
      JSON.stringify(terms),
      terms.terms_hash,
      created,
      capture.captureExpiresAtMs,
    ],
  );
  await admin.query("INSERT INTO dance_moderated_active_slots_v1 VALUES($1,$2,1,$3)", [
    capture.accountId,
    capture.choreographyId,
    ids.sessionId,
  ]);
  await admin.query(
    "INSERT INTO dance_moderated_consents_v1 VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::NUMERIC/1000))",
    [
      ids.sessionId,
      consentId,
      capture.accountId,
      capture.personaId,
      terms.terms_hash,
      capture.policy.consentVersion,
      capture.policy.consentHash,
      capture.policy.retentionHash,
      created + 1,
    ],
  );
  await admin.query(
    "INSERT INTO dance_moderated_uploads_v1(upload_id,session_id,consent_receipt_id,private_object_key,content_type,maximum_bytes,expected_size_bytes,expected_duration_ms,reserved_at,expires_at,first_stored_at,sealed_at,server_sha256,normalized_digest,normalization_version,normalization_hash,state,immutable_object_identity,bytes_sealed_at) VALUES($1,$2,$3,$4,'video/mp4',1000000,1000,$5,to_timestamp($6::NUMERIC/1000),to_timestamp($7::NUMERIC/1000),to_timestamp($8::NUMERIC/1000),to_timestamp($9::NUMERIC/1000),$10,$11,$12,$13,'sealed',$14::jsonb,to_timestamp($9::NUMERIC/1000))",
    [
      uploadId,
      ids.sessionId,
      consentId,
      `moderated-dance/ingress/${uploadId}/source`,
      capture.bodyEndMs,
      created + 2,
      created + 60000,
      created + 3,
      uploaded,
      capture.sourceDigest,
      capture.normalizedDigest,
      capture.policy.normalizationVersion,
      capture.policy.normalizationHash,
      JSON.stringify({
        destination_ref: `moderated-dance/originals/${uploadId}/source`,
        version: "fixture-v1",
        etag: "fixture-etag",
        size_bytes: 1000,
        canonical_sha256: capture.sourceDigest,
      }),
    ],
  );
  await admin.query(
    "INSERT INTO dance_moderated_reviews_v1(review_id,session_id,account_id,community_id,state,revision,publication_revision,status,uploaded_at,review_deadline,submitted_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$11,$7,to_timestamp($8::NUMERIC/1000),to_timestamp($9::NUMERIC/1000),to_timestamp($10::NUMERIC/1000))",
    [
      ids.reviewId,
      ids.sessionId,
      capture.accountId,
      capture.communityId,
      JSON.stringify(state),
      state.revision,
      state.state,
      uploaded,
      deadline,
      state.submittedAtMs,
      state.publicationRevision,
    ],
  );
  await admin.query(
    "INSERT INTO dance_moderated_review_evidence_v1(review_id,analysis_revision,source_digest,normalization_hash,safety_policy_hash,frame_digests,safety_status,content_rating,integrity_status,normalized_digest,evidence) VALUES($1,1,$2,$3,$4,$5,'accepted','general','unique',$6,'{}')",
    [
      ids.reviewId,
      capture.sourceDigest,
      capture.policy.normalizationHash,
      capture.policy.safetyHash,
      ["6".repeat(64), "7".repeat(64), "8".repeat(64)],
      capture.normalizedDigest,
    ],
  );
  return state;
}
async function waitForBlock(admin: Client, pid: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const row = (
      await admin.query(
        "SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked,query_start FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (row?.blocked) return row;
    await Bun.sleep(5);
  }
  throw new Error("Owned second connection did not reach the expected blocking lock");
}
export async function crossDeadline(admin: Client, deadline: Date) {
  await admin.query(
    "SELECT pg_sleep(greatest(0,extract(epoch FROM $1::TIMESTAMPTZ-clock_timestamp()))+0.01)",
    [deadline],
  );
  expect(
    (await admin.query("SELECT clock_timestamp()>=$1::TIMESTAMPTZ AS past", [deadline])).rows[0]
      ?.past,
  ).toBe(true);
}
export function reviewCommit(
  state: ReturnType<typeof transitionModeratorReview>["state"],
  transition: ReturnType<typeof transitionModeratorReview>,
  actor: ReviewActor,
  operation: "expire" | "verdict" | "visibility" | "publication_failed",
  key: string,
  at: number,
) {
  return {
    action: {
      actor,
      operation,
      idempotencyKey: key,
      requestHash: "a".repeat(64),
      receiptId: key,
      communityId: state.capture.communityId,
      reviewId: state.capture.reviewId,
    },
    beforeReviewRevision: state.revision,
    beforePublicationRevision: state.publicationRevision,
    captureAccountFenceRevision: state.capture.accountFenceRevision,
    observedAccountFenceRevision: state.capture.accountFenceRevision,
    observedAccountActive: true,
    transition,
    receipt: {
      version: "dance-review-receipt-v1",
      receipt_id: key,
      review_id: state.capture.reviewId,
      operation,
      outcome: transition.refusal === null ? "applied" : "refused",
      refusal_code: transition.refusal,
      committed_at: new Date(at).toISOString(),
      result: projectPrivateDanceReview(transition.state),
    },
  };
}

/** Two owned connections and a real blocking lock, never a mocked clock. */
export async function runBlockedQuery(
  connection: string,
  admin: Client,
  blocker: { text: string; values: readonly unknown[] },
  statement: { text: string; values: readonly unknown[] },
  during: () => Promise<void>,
) {
  const second = new Client({ connectionString: connection });
  await second.connect();
  let pending: Promise<{ result: import("pg").QueryResult } | { error: unknown }> | undefined;
  let response: Awaited<NonNullable<typeof pending>> | undefined;
  try {
    const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await admin.query("BEGIN");
    await admin.query(blocker.text, [...blocker.values]);
    pending = second.query(statement.text, [...statement.values]).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await waitForBlock(admin, pid);
    await during();
  } finally {
    await admin.query("ROLLBACK");
    if (pending !== undefined) response = await pending;
    await second.end();
  }
  if (response === undefined) throw new Error("Owned query was not dispatched");
  return response;
}

export async function reserveUpload(f: Awaited<ReturnType<typeof seed>>) {
  await f.ready();
  const { session } = await Effect.runPromise(f.store.command(f.create));
  const shared = {
    version: "dance-moderated-intake-v1",
    community_id: session.community_id,
    session_id: session.session_id,
    terms_hash: session.terms_hash,
  } as const;
  await Effect.runPromise(
    f.store.command({
      ...shared,
      operation: "consent",
      idempotency_key: "clock-consent",
      consent_version: session.consent_version,
      consent_hash: session.consent_hash,
      retention_hash: session.retention_hash,
    }),
  );
  const reserved = await Effect.runPromise(
    f.store.command({
      ...shared,
      operation: "reserve",
      idempotency_key: "clock-reserve",
      content_type: "video/mp4",
      size_bytes: 1000,
      duration_ms: session.body_end_ms,
    }),
  );
  const uploadId = reserved.session.upload_id;
  if (uploadId === null) throw new Error("Missing reserved upload");
  await Effect.runPromise(
    f.store.command({
      ...shared,
      operation: "finalize",
      idempotency_key: "clock-finalize",
      upload_id: uploadId,
    }),
  );
  return uploadId;
}

export function claimMedia(f: Awaited<ReturnType<typeof seed>>, token: string) {
  return {
    text: "SELECT claim_moderated_dance_media_v1($1,$2,$3,$4::jsonb) AS packet",
    values: [
      token,
      f.facts.profile.mediaRuntimeRevision,
      f.facts.profile.safetyProviderRevision,
      JSON.stringify(f.facts.profile.replayCompatibleEpochs),
    ],
  };
}
