import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { runMultiGolden } from "./megapot-base-sepolia-golden-multi.ts";
import {
  rehearsalInput,
  rehearsalObservation,
  rehearsalTime,
} from "./megapot-golden-multi.fixture.ts";
import type { MultiParticipantPreflight } from "./megapot-golden-multi-input.ts";

test("mixed orchestration keeps credentials separate, preflights before funding, and skips completed activities on replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "golden-orchestration-"));
  const pcm = new ArrayBuffer(16000);
  const base = rehearsalInput();
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
        3,
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
      calls.push(`activity:${participant.key}`);
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
    observe: async () => rehearsalObservation(),
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
    expect(calls.filter((call) => call.startsWith("activity:"))).toEqual([
      "activity:study",
      "activity:karaoke",
      "activity:negative",
    ]);
    expect(await runMultiGolden(input, options, deps)).toMatchObject({
      state: "reconciled_no_win",
    });
    expect(calls.filter((call) => call.startsWith("activity:"))).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
