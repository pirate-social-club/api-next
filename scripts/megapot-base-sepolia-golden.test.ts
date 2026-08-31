import { describe, expect, test } from "bun:test";

import {
  parseMegapotGoldenInput,
  runMegapotBaseSepoliaGolden,
} from "./megapot-base-sepolia-golden.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const startsAt = "2026-08-26T10:00:00.000Z";
const endsAt = "2026-08-27T10:00:00.000Z";

const input = parseMegapotGoldenInput({
  run_id: "flow-001",
  community_id: "community_1",
  post_id: "song_1",
  persona_id: "persona_1",
  starts_at: startsAt,
  ends_at: endsAt,
  funding_amount_atomic: "20000",
  max_ticket_price_atomic: "10000",
  entry_cutoff_seconds: 300,
  eligible_activities: ["study"],
  study_participant: {
    account_id: "participant_account_1",
    persona_id: "participant_persona_1",
    timezone: "UTC",
    accepted_lyrics: "Line 1\nLine 2\nLine 3\nLine 4",
  },
});

const offer = {
  object: "song_reward_offer",
  offer_id: "offer_1",
  community_id: input.community_id,
  post_id: input.post_id,
  audio_revision: 1,
  status: "draft",
  starts_at: startsAt,
  ends_at: endsAt,
  terms_hash: "a".repeat(64),
} as const;

const leg = {
  object: "megapot_pool_leg",
  leg_id: "leg_1",
  offer_id: offer.offer_id,
  status: "funding",
  chain_id: 84_532,
  token_address: address("1"),
  token_decimals: 6,
  custody_address: address("2"),
  max_ticket_price_atomic: input.max_ticket_price_atomic,
  entry_cutoff_seconds: input.entry_cutoff_seconds,
  participation_starts_drawing_id: "8342",
  eligible_activities: input.eligible_activities,
  min_score_bps: 7_000,
  empty_pool_policy: "no_purchase",
  fallback_payout_persona_id: null,
  funded_atomic: "0",
  leg_terms_hash: hash("3"),
} as const;

const funding = {
  object: "megapot_pool_funding",
  action: "fund_with_usdc",
  funding_effect_id: "funding_1",
  leg_id: leg.leg_id,
  status: "planned",
  chain_id: 84_532,
  token_address: leg.token_address,
  token_decimals: 6,
  sender_address: address("4"),
  recipient_address: leg.custody_address,
  expected_amount_atomic: input.funding_amount_atomic,
  confirmed_amount_atomic: null,
  required_confirmations: 3,
  transaction_hash: null,
} as const;

const options = {
  execute: true,
  qualifyStudy: true,
  apiOrigin: "https://api-next-staging.pirate.sc",
  authorization: "Bearer staging-test-token",
  participantAuthorization: "Bearer staging-participant-token",
} as const;

const checkedAt = "2026-08-26T09:59:00.000Z";
const validUntil = "2026-08-26T10:09:00.000Z";
const participantPreflight = {
  object: "megapot_participant_preflight_v1",
  checked_at: checkedAt,
  valid_until: validUntil,
  account_id: input.study_participant.account_id,
  persona_id: input.study_participant.persona_id,
  community_id: input.community_id,
  post_id: input.post_id,
  membership_id: "membership_1",
  audio_revision: 1,
  lyrics_revision: 1,
  study_exercise_count: 4,
  study_due_exercise_count: 4,
  subject_key_id: "subject_key_1",
  binding_event_id: "binding_event_1",
  binding_epoch: 1,
  binding_group_id: "binding_group_1",
  evidence_receipt_id: "evidence_receipt_1",
  evidence_hash: "a".repeat(64),
  personhood_assertion_id: "assertion_personhood_1",
  subject_unique_assertion_id: "assertion_unique_1",
  evidence_expires_at: null,
} as const;

const studyV2Items = Array.from({ length: 4 }, (_, ordinal) => ({
  object: "study_session_item_v2",
  session_item_id: `study_v2_item_${ordinal + 1}`,
  ordinal,
  exercise_review_key: `review_${ordinal + 1}`,
  exercise_version_id: `exercise_${ordinal + 1}`,
  exercise_type: "say_it_back",
  exercise_variant: "source_line_v1",
  line: {
    post_id: input.post_id,
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line_${ordinal + 1}`,
    study_unit_id: `unit_${ordinal + 1}`,
    line_version: 1,
    line_source_hash: `source_${ordinal + 1}`,
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: 1,
  presentation: {
    kind: "say_it_back",
    reference_text: `Line ${ordinal + 1}`,
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "grader_v1",
  feedback_policy_revision: "feedback_v1",
  quality_policy_revision: "quality_v1",
  maximum_attempts: 3,
}));

const participantStudyV2Session = {
  object: "study_session_v2",
  session_id: "study_v2_session_1",
  persona_id: input.study_participant.persona_id,
  community_id: input.community_id,
  post_id: input.post_id,
  audio_revision: 1,
  lyrics_revision: 1,
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  study_profile_revision: 1,
  language_profile_revision: 1,
  source_set_revision: 1,
  selection_policy_revision: "selection_v1",
  qualification_policy_revision: "qualification_v1",
  timezone: "UTC",
  status: "active",
  items: studyV2Items,
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "study_v2_item_1",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: startsAt,
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 1,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: startsAt,
  completed_at: null,
} as const;

const executeOptions = { ...options, participantPreflight } as const;
const now = () => new Date("2026-08-26T10:00:00.000Z");

function studyV2Progress(answered: number) {
  const completed = answered === 4;
  return {
    ...participantStudyV2Session,
    status: completed ? ("completed" as const) : ("active" as const),
    progress: {
      qualifying_exercise_count: 4,
      answered_exercise_count: answered,
      first_pass_correct: answered,
      required_correct: 3,
      score_bps: completed ? 10_000 : null,
    },
    lesson: {
      current: completed
        ? null
        : {
            session_item_id: `study_v2_item_${answered + 1}`,
            presentation_number: 1,
            is_reappearance: false,
            presented_at: startsAt,
          },
      resolved_card_count: answered,
      total_card_count: 4,
      presentation_count: completed ? 4 : answered + 1,
      presentation_cap: 12,
      completion_reason: completed ? ("all_resolved" as const) : null,
    },
    completed_at: completed ? "2026-08-26T10:01:00.000Z" : null,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Base Sepolia Megapot golden flow", () => {
  test("dry-run fixes no-purchase semantics without requiring credentials", async () => {
    let fetched = false;
    const result = await runMegapotBaseSepoliaGolden(
      input,
      { execute: false, apiOrigin: options.apiOrigin },
      {
        fetcher: async () => {
          fetched = true;
          return json({});
        },
        sleep: async () => {},
        now,
      },
    );

    expect(fetched).toBe(false);
    expect(result).toMatchObject({
      mode: "dry-run",
      chain_id: 84_532,
      empty_pool_policy: "no_purchase",
      min_score_bps: 7_000,
      qualification: {
        activity: "study",
        execution: "authenticated_participant_api",
      },
      funding_transaction_supplied: false,
    });
  });

  test("refuses every write when the participant artifact is absent", async () => {
    let fetched = false;
    await expect(
      runMegapotBaseSepoliaGolden(input, options, {
        fetcher: async () => {
          fetched = true;
          return json({});
        },
        sleep: async () => {},
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    expect(fetched).toBe(false);
  });

  test("refuses an artifact with no selectable items or active typed session", async () => {
    let fetched = false;
    await expect(
      runMegapotBaseSepoliaGolden(
        input,
        {
          ...options,
          participantPreflight: { ...participantPreflight, study_due_exercise_count: 0 },
        },
        {
          fetcher: async () => {
            fetched = true;
            return json({});
          },
          sleep: async () => {},
          now,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
    expect(fetched).toBe(false);
  });

  test("checks a matching typed Study v2 session before the offer request", async () => {
    const paths: string[] = [];
    await expect(
      runMegapotBaseSepoliaGolden(input, executeOptions, {
        fetcher: async (url) => {
          const path = new URL(url).pathname;
          paths.push(path);
          return json({ ...participantStudyV2Session, audio_revision: 2 }, 201);
        },
        sleep: async () => {},
        now,
      }),
    ).rejects.toMatchObject({ code: "request-failed" });
    expect(paths).toEqual([
      `/communities/${input.community_id}/posts/${input.post_id}/study/v2/sessions`,
    ]);
  });

  test("authenticates and reuses a preflight-created Study v2 session", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const replayedPreflight = {
      ...participantPreflight,
      study_due_exercise_count: 0,
      study_session_id: participantStudyV2Session.session_id,
    } as const;
    const responses = [
      json(participantStudyV2Session),
      json({ offer, replayed: false }, 201),
      json({ leg, funding, replayed: false }, 201),
    ];
    await runMegapotBaseSepoliaGolden(
      input,
      { ...options, participantPreflight: replayedPreflight },
      {
        fetcher: async (url, init) => {
          requests.push({ url, init });
          const response = responses.shift();
          if (response === undefined) throw new Error("unexpected request");
          return response;
        },
        sleep: async () => {},
        now,
      },
    );

    expect(new URL(requests[0]?.url ?? "").pathname).toEndWith(
      `/study/v2/sessions/${participantStudyV2Session.session_id}`,
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(new URL(requests[1]?.url ?? "").pathname).toEndWith("/reward-offers");
  });

  test("opens the offer and returns exact user-authorized funding instructions", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const responses = [
      json(participantStudyV2Session, 201),
      json({ offer, replayed: false }, 201),
      json({ leg, funding, replayed: false }, 201),
    ];
    const result = await runMegapotBaseSepoliaGolden(input, executeOptions, {
      fetcher: async (url, init) => {
        requests.push({ url, init });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      sleep: async () => {},
      now,
    });

    expect(result).toMatchObject({
      mode: "execute",
      state: "awaiting_funder_transfer",
      funding: {
        action: "fund_with_usdc",
        recipient_address: leg.custody_address,
        expected_amount_atomic: input.funding_amount_atomic,
      },
    });
    expect(requests).toHaveLength(3);
    expect(new URL(requests[0]?.url ?? "").pathname).toEndWith("/study/v2/sessions");
    const legRequest = JSON.parse(String(requests[2]?.init?.body)) as Readonly<
      Record<string, unknown>
    >;
    expect(legRequest).toMatchObject({
      min_score_bps: 7_000,
      empty_pool_policy: "no_purchase",
      fallback_payout_persona_id: null,
      fallback_disclosure_acknowledged: false,
    });
  });

  test("replays funding observation until confirmed, then reads backend projections", async () => {
    const transactionHash = hash("5");
    const withTransaction = parseMegapotGoldenInput({
      ...input,
      funding_transaction_hash: transactionHash,
    });
    const methods: string[] = [];
    const paths: string[] = [];
    const authorizations: Array<string | null> = [];
    let observations = 0;
    let sleeps = 0;
    let studyAnswers = 0;
    let studySession = participantStudyV2Session;
    const confirmed = {
      ...funding,
      status: "confirmed",
      confirmed_amount_atomic: funding.expected_amount_atomic,
      transaction_hash: transactionHash,
    } as const;
    const result = await runMegapotBaseSepoliaGolden(withTransaction, executeOptions, {
      fetcher: async (url, init) => {
        methods.push(init?.method ?? "GET");
        paths.push(new URL(url).pathname);
        authorizations.push(new Headers(init?.headers).get("authorization"));
        const path = new URL(url).pathname;
        if (path.endsWith("/study/v2/sessions")) return json(participantStudyV2Session, 201);
        if (path.endsWith("/reward-offers")) return json({ offer, replayed: true });
        if (path.endsWith("/megapot-pool-legs")) return json({ leg, funding, replayed: true });
        if (path.endsWith("/observations")) {
          observations += 1;
          return json({
            funding:
              observations === 1
                ? { ...funding, status: "confirming", transaction_hash: transactionHash }
                : confirmed,
            replayed: observations > 1,
          });
        }
        if (path.endsWith(`/funding/${funding.funding_effect_id}`)) {
          return json({ funding: confirmed });
        }
        if (path.endsWith("/rewards/megapot-pool")) return json({ pool: null });
        if (path.includes("/study/v2/sessions/") && path.endsWith("/answers")) {
          studyAnswers += 1;
          const headers = new Headers(init?.headers);
          expect(headers.get("content-type")).toBe("audio/wav");
          expect(headers.get("idempotency-key")).toBe(
            `megapot-golden-${input.run_id}-study-v2-answer-${studyAnswers}-1`,
          );
          expect(headers.get("x-study-attempt-number")).toBe("1");
          expect(init?.body).toBeInstanceOf(Uint8Array);
          studySession = studyV2Progress(studyAnswers);
          return json({
            object: "study_answer_result_v2",
            session_item_id: `study_v2_item_${studyAnswers}`,
            attempt_number: 1,
            exercise_type: "say_it_back",
            outcome: "correct",
            first_pass: true,
            attempt_state: "spent",
            feedback: {
              kind: "transcript_diff",
              heard_transcript: `Line ${studyAnswers}`,
              matched: [],
              missing: [],
              extra: [],
              substituted: [],
              policy_revision: "grader_v1",
            },
            session: studySession,
          });
        }
        if (path.endsWith(`/study/v2/sessions/${participantStudyV2Session.session_id}`)) {
          return json(studySession);
        }
        throw new Error(`unexpected path: ${path}`);
      },
      sleep: async () => {
        sleeps += 1;
      },
      now,
      synthesizeStudyAudio: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        durationMs: 100,
      }),
    });

    expect(observations).toBe(2);
    expect(sleeps).toBe(1);
    expect(methods).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
      "GET",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
      "GET",
    ]);
    expect(paths.at(-1)).toEndWith(`/study/v2/sessions/${participantStudyV2Session.session_id}`);
    expect(authorizations[0]).toBe("Bearer staging-participant-token");
    expect(authorizations.slice(1, 7)).toEqual(Array(6).fill("Bearer staging-test-token"));
    expect(authorizations.slice(7)).toEqual(Array(5).fill("Bearer staging-participant-token"));
    expect(result).toMatchObject({
      mode: "execute",
      state: "funded_and_qualified",
      funding: { status: "confirmed", transaction_hash: transactionHash },
      pool: null,
      participant: {
        session_id: participantStudyV2Session.session_id,
        score_bps: 10_000,
        required_correct: 3,
      },
    });
  });

  test("stops at funded until Study qualification is explicitly requested", async () => {
    const transactionHash = hash("6");
    const withTransaction = parseMegapotGoldenInput({
      ...input,
      funding_transaction_hash: transactionHash,
    });
    const paths: string[] = [];
    const confirmed = {
      ...funding,
      status: "confirmed",
      confirmed_amount_atomic: funding.expected_amount_atomic,
      transaction_hash: transactionHash,
    } as const;
    const result = await runMegapotBaseSepoliaGolden(
      withTransaction,
      { ...executeOptions, qualifyStudy: false },
      {
        fetcher: async (url) => {
          const path = new URL(url).pathname;
          paths.push(path);
          if (path.endsWith("/study/v2/sessions")) return json(participantStudyV2Session, 201);
          if (path.endsWith("/reward-offers")) return json({ offer, replayed: true });
          if (path.endsWith("/megapot-pool-legs")) {
            return json({ leg, funding, replayed: true });
          }
          if (path.endsWith("/observations")) {
            return json({ funding: confirmed, replayed: false });
          }
          if (path.endsWith(`/funding/${funding.funding_effect_id}`)) {
            return json({ funding: confirmed });
          }
          if (path.endsWith("/rewards/megapot-pool")) return json({ pool: null });
          throw new Error(`unexpected path: ${path}`);
        },
        sleep: async () => {},
        now,
      },
    );

    expect(paths.filter((path) => path.includes("/study/"))).toEqual([
      `/communities/${input.community_id}/posts/${input.post_id}/study/v2/sessions`,
    ]);
    expect(result).toMatchObject({ state: "funded", participant: null });
  });
});
