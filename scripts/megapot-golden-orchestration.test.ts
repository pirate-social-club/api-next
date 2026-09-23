import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { runMultiGolden } from "./megapot-base-sepolia-golden-multi.ts";
import {
  onePalmRehearsalInput,
  rehearsalInput,
  rehearsalObservation,
  rehearsalTime,
} from "./megapot-golden-multi.fixture.ts";
import type { MultiParticipantPreflight } from "./megapot-golden-multi-input.ts";
import { parseMultiGoldenInput } from "./megapot-golden-multi-input.ts";

async function exerciseOrchestration(makeInput: typeof rehearsalInput): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "golden-orchestration-"));
  const pcm = new ArrayBuffer(16000);
  const base = makeInput();
  const input = {
    ...base,
    participants: base.participants.map((p) =>
      p.karaoke_audio
        ? {
            ...p,
            karaoke_audio: {
              ...p.karaoke_audio,
              sha256: createHash("sha256").update(new Uint8Array(pcm)).digest("hex"),
            },
          }
        : p,
    ),
  };
  const calls: string[] = [];
  let invalidRevision = false;
  const deps: NonNullable<Parameters<typeof runMultiGolden>[2]> = {
    now: () => rehearsalTime,
    sleep: async () => {},
    readAudio: async () => pcm,
    read: async (_url, _host, _database, fn) => fn(new Client()),
    readArtifact: async (path): Promise<MultiParticipantPreflight> => {
      const p = input.participants.find((candidate) => candidate.preflight_path === path);
      if (!p) throw new Error("fixture");
      return {
        object: "megapot_participant_preflight_v2",
        checked_at: new Date(rehearsalTime).toISOString(),
        valid_until: new Date(rehearsalTime + 600000).toISOString(),
        account_id: p.account_id,
        persona_id: p.persona_id,
        community_id: input.community_id,
        post_id: input.post_id,
        audio_revision: invalidRevision ? 2 : 1,
        lyrics_revision: 1,
        wallet_assignment_id: `wallet-${p.key}`,
        wallet_address: `0x${"a".repeat(40)}`,
        verification_state: p.expected_admission,
        very_evidence:
          p.expected_admission === "eligible"
            ? [
                {
                  subject_key_id: "subject",
                  binding_event_id: "binding",
                  binding_group_id: "group",
                  binding_epoch: 1,
                  evidence_receipt_id: "receipt",
                  proof_session_id: "proof-session",
                  evidence_hash: "a".repeat(64),
                  personhood_assertion_id: "personhood",
                  subject_unique_assertion_id: "unique",
                  evidence_expires_at: null,
                  ceremony_reference: "fixture-not-live",
                },
              ]
            : [],
        study_exercise_count: 4,
        karaoke_revision_id: p.karaoke_audio ? "revision" : null,
        karaoke_line_count: p.karaoke_audio ? 5 : 0,
        playback_kind: p.karaoke_audio ? "full_mix" : null,
      };
    },
    verifyIdentity: async (_client, artifact) => {
      calls.push(`preflight:${artifact.account_id}`);
    },
    pool: async (_input, options, journal) => {
      expect(calls.filter((call) => call.startsWith("preflight:")).length).toBeGreaterThanOrEqual(
        input.participants.length,
      );
      expect(options.authorization).toBe("Bearer sponsor");
      calls.push("pool");
      await journal.save({
        ...journal.state,
        leg_id: "leg",
        funding_effect_id: "funding",
        drawing_id: "101",
      });
      return { state: "funded", leg_id: "leg", drawing_id: "101" };
    },
    activity: async (_input, participant, _artifact, activity, http, journal) => {
      expect(http.authorization).toBe(`Bearer ${participant.key}`);
      expect(journal.state.pending_activity).toBe(`${participant.key}:${activity}`);
      calls.push(`activity:${participant.key}:${activity}`);
      return {
        object: "staging_study_participant_result_v2",
        session_id: "session",
        audio_revision: 1,
        lyrics_revision: 1,
        source_set_revision: 1,
        qualifying_exercise_count: 4,
        first_pass_correct: 3,
        required_correct: 3,
        score_bps: 7500,
      };
    },
    observe: async () => rehearsalObservation(input),
    adopt: async () => {},
    recoverDrawing: async () => {
      throw new Error("Unexpected recovery");
    },
  };
  const options = {
    execute: true,
    reconcileOnly: false,
    journalPath: join(directory, "run.jsonl"),
    environment: {
      API_NEXT_ENV: "staging",
      CONTROL_PLANE_POSTGRES_RUNTIME_URL: "unused",
      PIRATE_STAGING_POSTGRES_HOST: "unused",
      PIRATE_STAGING_POSTGRES_DATABASE: "unused",
      PIRATE_STAGING_AUTHORIZATION: "Bearer sponsor",
      STUDY_AUTHORIZATION: "Bearer study",
      KARAOKE_AUTHORIZATION: "Bearer karaoke",
      NEGATIVE_AUTHORIZATION: "Bearer negative",
    },
  };
  try {
    invalidRevision = true;
    await expect(runMultiGolden(input, options, deps)).rejects.toThrow("preflight");
    expect(calls).toEqual([]);
    invalidRevision = false;
    if (!input.authorization) throw new Error("fixture");
    await expect(
      runMultiGolden(
        { ...input, authorization: { ...input.authorization, max_study_submissions: 1 } },
        { ...options, journalPath: join(directory, "insufficient.jsonl") },
        deps,
      ),
    ).rejects.toThrow("cap cannot cover");
    expect(calls).not.toContain("pool");
    calls.length = 0;
    expect(await runMultiGolden(input, options, deps)).toMatchObject({
      state: "reconciled_no_win",
    });
    const expectedActivities = input.participants.flatMap((p) =>
      p.activities.map((activity) => `activity:${p.key}:${activity}`),
    );
    expect(calls.filter((call) => call.startsWith("activity:"))).toEqual(expectedActivities);
    expect(await runMultiGolden(input, options, deps)).toMatchObject({
      state: "reconciled_no_win",
    });
    expect(calls.filter((call) => call.startsWith("activity:"))).toHaveLength(
      expectedActivities.length,
    );
    const interruptedOptions = { ...options, journalPath: join(directory, "lost-attempt.jsonl") };
    let reservations = 0;
    const interrupted = {
      ...deps,
      activity: async (...args: Parameters<typeof deps.activity>) => {
        const activity = args[3];
        if (activity !== "karaoke") return deps.activity(...args);
        const journal = args[5];
        await journal.save({
          ...journal.state,
          karaoke_attempts: journal.state.karaoke_attempts + 1,
        });
        reservations++;
        throw new Error("Reservation accepted; response lost before recordAttempt");
      },
    };
    await expect(runMultiGolden(input, interruptedOptions, interrupted)).rejects.toThrow(
      "response lost",
    );
    await expect(runMultiGolden(input, interruptedOptions, interrupted)).rejects.toThrow(
      "Prior activity outcome is ambiguous",
    );
    expect(reservations).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("two verified accounts orchestrate without duplicate effects", () =>
  exerciseOrchestration(rehearsalInput));

test("one verified dual-activity account orchestrates without duplicate effects", () =>
  exerciseOrchestration(onePalmRehearsalInput));

test("observe_app waits for human rows and only drives the negative Study", async () => {
  const directory = await mkdtemp(join(tmpdir(), "golden-observe-"));
  const base = onePalmRehearsalInput();
  const input = parseMultiGoldenInput({
    ...base,
    activity_mode: "observe_app",
    app_funded_pool: {
      offer_id: "offer",
      leg_id: "leg",
      funding_effect_id: "funding",
      transaction_hash: `0x${"a".repeat(64)}`,
      sender_address: `0x${"b".repeat(40)}`,
    },
    participants: base.participants.map((p) =>
      p.expected_admission === "eligible"
        ? { ...p, accepted_lyrics: undefined, karaoke_audio: undefined }
        : p,
    ),
    authorization: base.authorization && {
      ...base.authorization,
      qualification_deadline: "2026-09-21T10:19:00.000Z",
    },
  });
  let clock = rehearsalTime;
  let observations = 0;
  const activities: string[] = [];
  const deps: NonNullable<Parameters<typeof runMultiGolden>[2]> = {
    now: () => clock,
    sleep: async () => {
      clock += 300000;
    },
    readAudio: async () => {
      throw new Error("Human audio must not be read");
    },
    read: async (_url, _host, _database, fn) => fn(new Client()),
    readArtifact: async (path): Promise<MultiParticipantPreflight> => {
      const p = input.participants.find((candidate) => candidate.preflight_path === path);
      if (!p) throw new Error("fixture");
      return {
        object: "megapot_participant_preflight_v2",
        checked_at: new Date(clock).toISOString(),
        valid_until: new Date(clock + 60000).toISOString(),
        account_id: p.account_id,
        persona_id: p.persona_id,
        community_id: input.community_id,
        post_id: input.post_id,
        audio_revision: input.audio_revision,
        lyrics_revision: input.lyrics_revision,
        wallet_assignment_id: `wallet-${p.key}`,
        wallet_address: `0x${"a".repeat(40)}`,
        verification_state: p.expected_admission,
        very_evidence:
          p.expected_admission === "eligible"
            ? [
                {
                  subject_key_id: "subject",
                  binding_event_id: "binding",
                  binding_group_id: "group",
                  binding_epoch: 1,
                  evidence_receipt_id: "receipt",
                  proof_session_id: "proof",
                  evidence_hash: "a".repeat(64),
                  personhood_assertion_id: "personhood",
                  subject_unique_assertion_id: "unique",
                  evidence_expires_at: null,
                  ceremony_reference: "fixture",
                },
              ]
            : [],
        study_exercise_count: 4,
        karaoke_revision_id: "revision",
        karaoke_line_count: 5,
        playback_kind: "full_mix",
      };
    },
    verifyIdentity: async () => {},
    adopt: async () => {},
    pool: async (_input, _options, journal) => {
      await journal.save({
        ...journal.state,
        leg_id: "leg",
        funding_effect_id: "funding",
        drawing_id: "101",
      });
      return { state: "funded", leg_id: "leg", drawing_id: "101" };
    },
    activity: async (_input, p, _artifact, activity) => {
      activities.push(`${p.key}:${activity}`);
      return {
        object: "staging_study_participant_result_v2" as const,
        session_id: "session",
        audio_revision: 1,
        lyrics_revision: 1,
        source_set_revision: 1,
        qualifying_exercise_count: 4,
        first_pass_correct: 3,
        required_correct: 3,
        score_bps: 7500,
      };
    },
    observe: async () => {
      observations++;
      const complete = rehearsalObservation(input);
      return {
        ...complete,
        observed_at: new Date(clock).toISOString(),
        ...(observations === 1
          ? {
              shares: [],
              qualifications: complete.qualifications.filter((q) => q.account_id === "negative"),
              decisions: complete.decisions.filter((d) => d.account_id === "negative"),
            }
          : {}),
      };
    },
    recoverDrawing: async () => {
      throw new Error("unexpected recovery");
    },
  };
  const options = {
    execute: true,
    reconcileOnly: false,
    journalPath: join(directory, "run.jsonl"),
    environment: {
      API_NEXT_ENV: "staging",
      CONTROL_PLANE_POSTGRES_RUNTIME_URL: "unused",
      PIRATE_STAGING_POSTGRES_HOST: "unused",
      PIRATE_STAGING_POSTGRES_DATABASE: "unused",
      PIRATE_STAGING_AUTHORIZATION: "Bearer sponsor",
      NEGATIVE_AUTHORIZATION: "Bearer negative",
    },
  };
  try {
    expect(await runMultiGolden(input, options, deps)).toMatchObject({
      state: "reconciled_no_win",
    });
    expect(activities).toEqual(["negative:study"]);
    expect(clock).toBeGreaterThan(rehearsalTime + 60000);
    expect(await runMultiGolden(input, options, deps)).toMatchObject({
      state: "reconciled_no_win",
    });
    expect(activities).toEqual(["negative:study"]);
    clock = rehearsalTime;
    const timeoutOptions = { ...options, journalPath: join(directory, "timeout.jsonl") };
    const missing = {
      ...deps,
      observe: async () => {
        const observation = rehearsalObservation(input);
        return {
          ...observation,
          observed_at: new Date(clock).toISOString(),
          shares: [],
          qualifications: observation.qualifications.filter((q) => q.account_id === "negative"),
          decisions: observation.decisions.filter((d) => d.account_id === "negative"),
        };
      },
    };
    expect(await runMultiGolden(input, timeoutOptions, missing)).toMatchObject({
      state: "activity_evidence_incomplete",
      terminal: false,
    });
    expect(activities).toEqual(["negative:study", "negative:study"]);
    await expect(runMultiGolden(input, timeoutOptions, missing)).rejects.toThrow(
      "Outside authorized run window",
    );
    expect(activities).toEqual(["negative:study", "negative:study"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
