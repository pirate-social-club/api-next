// Shared genuine source fixture utility: extracted from accepted CP7 at15f3.
// No fake authority rows/SQL. Actual controlled reserve creates all lineage.
import { expect } from "bun:test";
import { gradeStudySpokenTranscript, type OwnerSpokenPreArchiveSuccess } from "@pirate/application";
import { Schema } from "effect";
import type { CheckpointFixture as Fixture } from "./owner-spoken-checkpoint.pg-fixture.ts";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "./owner-spoken-checkpoint-store.ts";
import { makeControlPlaneOwnerStudyMutations } from "./owner-study-mutations.ts";
import {
  completed,
  disclosure,
  hash,
  policy,
  reserve,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const runtime = (f: Fixture) =>
  makeDirectPostgresControlPlaneLayer(f.guestUrl, { closeTimeoutMs: 2000 });
const mutations = (f: Fixture) =>
  makeControlPlaneOwnerStudyMutations(runtime(f), {
    rawPolicy: policy,
    disclosureVersion: disclosure.version,
    rerecordEnabled: true,
    providerRetention: "not_stored", // Typed deterministic fixture stub has no remote storage.
  });
export async function dispatch(
  f: Fixture,
  serial: number,
  existingGuest?: Awaited<ReturnType<typeof seedGuest>>,
) {
  const guest = existingGuest ?? (await seedGuest(f, serial));
  const initial = await reserve(f, guest.access, `checkpoint-start-${serial}`, 24);
  const start = completed(await run(f.store.startSession(initial.input)));
  const source = start.result.source;
  if (source.kind !== "guest") throw new Error("Actual starter guest source required");
  const current = start.result.session.lesson.current;
  if (current === null) throw new Error("Real starter current item missing");
  const owner = mutations(f);
  const operation = {
    sourceOwnerId: guest.ownerId,
    kind: "study_answer" as const,
    idempotencyKey: `checkpoint-answer-${serial}`,
    requestHash: hash(`checkpoint-answer-${serial}`),
  };
  const context = await run(
    owner.loadSpokenAnswerContext({
      access: guest.access,
      communityId: start.result.session.community_id,
      sessionId: start.result.session.session_id,
      sessionItemId: current.session_item_id,
      idempotencyKey: operation.idempotencyKey,
    }),
  );
  expect(context.source).toEqual(source);
  const audio = new Uint8Array([1, 2, 3]);
  const input = {
    access: guest.access,
    source,
    operation,
    sessionId: start.result.session.session_id,
    sessionItemId: current.session_item_id,
    attemptNumber: 1,
    audioByteSize: audio.byteLength,
    audioContentType: "audio/webm",
    audioDigest: hash(audio),
    audioDurationMs: 1000,
    commandId: `checkpoint-command-${serial}`,
    attemptId: `checkpoint-attempt-${serial}`,
    artifactId: `checkpoint-artifact-${serial}`,
    idempotencyKey: operation.idempotencyKey,
    requestHash: operation.requestHash,
    leaseToken: `fixture-private-dispatch-${serial}`,
    providerRetention: "not_stored" as const,
    resourceReservationId: initial.reservationId,
    deletionFenceRevision: 0,
  };
  const receipt = await run(owner.reserveSpokenAnswer(input));
  if (receipt.state !== "reserved") throw new Error("Actual first committed reserve required");
  // Deterministic typed provider stub only. No external network/provider body,
  // duplicate invocation or fabricated producer row is introduced.
  let providerInvocations = 0;
  const provider = () => {
    providerInvocations += 1;
    return {
      transcript: context.context.referenceText,
      detectedLanguage: "en",
      detectedLanguageConfidence: 0.99,
    };
  };
  const providerResult = provider();
  const grade = gradeStudySpokenTranscript({
    referenceText: context.context.referenceText,
    transcript: providerResult.transcript,
    dominantLanguage: context.context.dominantLanguage,
    policy: Schema.decodeUnknownSync(
      Schema.Literals([
        "script_aware_token_diff_v1",
        "script_aware_token_phonetic_v2",
        "script_aware_token_phonetic_v3",
        "script_aware_token_phonetic_v4",
      ]),
    )(context.context.item.grader_policy_revision),
    languageProvenance: context.context.languageProvenance,
    detectedLanguage: providerResult.detectedLanguage,
    detectedLanguageConfidence: providerResult.detectedLanguageConfidence,
  });
  const success: OwnerSpokenPreArchiveSuccess = {
    source,
    operation,
    commandId: receipt.commandId,
    resourceReservationId: receipt.resourceReservationId,
    deletionFenceRevision: receipt.deletionFenceRevision,
    providerResult,
    result: {
      acceptedAt: new Date().toISOString(),
      artifactId: receipt.artifactId,
      attemptId: receipt.attemptId,
      attemptNumber: 1,
      audioByteSize: input.audioByteSize,
      audioContentType: "audio/webm",
      audioDigest: input.audioDigest,
      audioDurationMs: input.audioDurationMs,
      commandId: receipt.commandId,
      leaseToken: receipt.leaseToken,
      communityId: start.result.session.community_id,
      ...grade,
      languageProvenance: context.context.languageProvenance,
      rerecordEnabled: true,
      providerDetectedLanguage: providerResult.detectedLanguage,
      providerDetectedLanguageConfidence: providerResult.detectedLanguageConfidence,
      qualificationId: `unused-guest-candidate-${serial}`,
      requestHash: operation.requestHash,
      sessionId: start.result.session.session_id,
      sessionItemId: current.session_item_id,
    },
  };
  const checkpoint = makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(runtime(f));
  return {
    guest,
    audio,
    initial,
    input,
    owner,
    success,
    checkpoint,
    providerInvocations: () => providerInvocations,
  };
}
