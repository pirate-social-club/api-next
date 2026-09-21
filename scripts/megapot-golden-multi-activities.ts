import {
  CreateKaraokeAttempt,
  GetKaraokeAttempt,
  GetKaraokeReadiness,
  GetStudySessionV2,
  StartStudySessionV2,
  SubmitStudyAnswerV2,
} from "@pirate/contracts";
import { type GoldenHttpOptions, requestJson } from "./megapot-golden-http.ts";
import type { GoldenJournalPort } from "./megapot-golden-journal.ts";
import type {
  MultiGoldenInput,
  MultiParticipantPreflight,
  RehearsalParticipant,
} from "./megapot-golden-multi-input.ts";
import { openKaraokeSocket, runStagingKaraokeParticipant } from "./staging-karaoke-participant.ts";
import {
  runStagingStudyParticipant,
  synthesizeStudyFixtureAudio,
} from "./staging-study-participant.ts";

export async function runGoldenActivity(
  input: MultiGoldenInput,
  participant: RehearsalParticipant,
  artifact: MultiParticipantPreflight,
  activity: "study" | "karaoke",
  options: GoldenHttpOptions,
  journal: GoldenJournalPort,
  pcm16: ArrayBuffer | undefined,
) {
  const authorization = input.authorization;
  if (!authorization) throw new Error("Authorization missing.");
  const deadline = Date.parse(authorization.qualification_deadline);
  const guard = () => {
    if (Date.now() >= deadline) throw new Error("Qualification window ended.");
  };
  guard();
  const community = encodeURIComponent(input.community_id);
  const base = `/communities/${community}/posts/${encodeURIComponent(input.post_id)}`;
  const deps = { fetcher: fetch };
  if (activity === "study") {
    const session = await requestJson(
      deps,
      options,
      `${base}/study/v2/sessions`,
      StartStudySessionV2.response,
      {
        method: "POST",
        body: {
          idempotency_key: `megapot-${input.run_id}-${participant.key}-study`,
          persona_id: participant.persona_id,
          target_language: null,
          learner_band: null,
          timezone: participant.timezone,
        },
      },
    );
    if (
      session.audio_revision !== artifact.audio_revision ||
      session.lyrics_revision !== artifact.lyrics_revision ||
      session.items.length < 4 ||
      !participant.accepted_lyrics
    )
      throw new Error("Study source mismatch.");
    return await runStagingStudyParticipant(
      {
        runId: `${input.run_id}-${participant.key}`,
        communityId: input.community_id,
        postId: input.post_id,
        personaId: participant.persona_id,
        acceptedLyrics: participant.accepted_lyrics,
        session,
      },
      {
        synthesizeAudio: async (text) => {
          guard();
          return await synthesizeStudyFixtureAudio(text);
        },
        submitAnswer: async (answer) => {
          guard();
          if (journal.state.study_submissions >= authorization.max_study_submissions)
            throw new Error("Study submission cap reached.");
          await journal.save({
            ...journal.state,
            study_submissions: journal.state.study_submissions + 1,
          });
          return await requestJson(
            deps,
            options,
            `/communities/${community}/study/v2/sessions/${encodeURIComponent(answer.sessionId)}/items/${encodeURIComponent(answer.sessionItemId)}/answers`,
            SubmitStudyAnswerV2.response,
            {
              method: "POST",
              body: answer.audio.bytes,
              rawBody: true,
              contentType: "audio/wav",
              headers: {
                "idempotency-key": answer.idempotencyKey,
                "x-study-attempt-number": String(answer.attemptNumber),
                "x-audio-duration-ms": String(answer.audio.durationMs),
              },
            },
          );
        },
        getSession: ({ sessionId }) =>
          requestJson(
            deps,
            options,
            `/communities/${community}/study/v2/sessions/${encodeURIComponent(sessionId)}`,
            GetStudySessionV2.response,
          ),
      },
    );
  }
  const readiness = await requestJson(
    deps,
    options,
    `${base}/karaoke`,
    GetKaraokeReadiness.response,
  );
  if (
    readiness.state !== "ready" ||
    readiness.karaoke_revision_id !== artifact.karaoke_revision_id ||
    !participant.karaoke_audio ||
    !pcm16
  )
    throw new Error("Karaoke source mismatch.");
  const previous = journal.state.attempts.find((a) => a.participant_key === participant.key);
  return await runStagingKaraokeParticipant(
    {
      communityId: input.community_id,
      postId: input.post_id,
      personaId: participant.persona_id,
      readiness,
      pcm16,
      durationMs: participant.karaoke_audio.duration_ms,
      allowStoredRetention: participant.karaoke_audio.allow_stored_retention,
      deadlineMs: deadline,
      ...(previous ? { previousAttempt: previous } : {}),
    },
    {
      createAttempt: async () => {
        guard();
        if (journal.state.karaoke_attempts >= authorization.max_karaoke_attempts)
          throw new Error("Karaoke attempt cap reached.");
        await journal.save({
          ...journal.state,
          karaoke_attempts: journal.state.karaoke_attempts + 1,
        });
        return await requestJson(
          deps,
          options,
          `${base}/karaoke/attempts`,
          CreateKaraokeAttempt.response,
          {
            method: "POST",
            body: { persona_id: participant.persona_id, timezone: participant.timezone },
            headers: { "idempotency-key": `megapot-${input.run_id}-${participant.key}-karaoke` },
          },
        );
      },
      recordAttempt: async (attempt) =>
        journal.save({
          ...journal.state,
          attempts: [...journal.state.attempts, { participant_key: participant.key, ...attempt }],
        }),
      getAttempt: async (attemptId) => {
        // A missing terminal record is expected while the DO finalizes. Other failures stop.
        const result = await requestJson(
          deps,
          options,
          `/communities/${community}/karaoke/attempts/${encodeURIComponent(attemptId)}`,
          GetKaraokeAttempt.response,
        ).catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.message.startsWith("Staging rewards request failed with HTTP 404;")
          )
            return null;
          throw error;
        });
        return result;
      },
      openSocket: openKaraokeSocket,
      now: Date.now,
      sleep: Bun.sleep,
    },
  );
}
