import { expect, test } from "bun:test";
import type { StudySessionItemV2, StudySessionV2 } from "@pirate/contracts";
import { StudyV2CommandRejected, StudyV2StoreFailed } from "./study-v2-service.ts";
import { processTelegramInbox } from "./telegram/chat.ts";
import {
  DEFAULT_ASSISTANT_POLICY,
  type InboxRecord,
  type IntegrationRecord,
  type TelegramServices,
  type TelegramStore,
} from "./telegram/types.ts";
import {
  emptyTelegramStudyState,
  type TelegramStudyGrant,
  TelegramStudyLeaseExpired,
  type TelegramStudyReply,
  type TelegramStudyServices,
} from "./telegram-study.ts";
import { handleTelegramStudyChat } from "./telegram-study-chat.ts";

const item = (
  ordinal: number,
  graderPolicyRevision = "script_aware_token_diff_v1",
): StudySessionItemV2 => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    study_unit_id: `unit-${ordinal}`,
    line_version: 1,
    line_source_hash: "a".repeat(64),
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: {
    kind: "say_it_back",
    reference_text: "Hold on",
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: graderPolicyRevision,
  feedback_policy_revision: "feedback-v1",
  quality_policy_revision: "quality-v1",
  maximum_attempts: 3,
});

const session: StudySessionV2 = {
  object: "study_session_v2",
  session_id: "session-1",
  persona_id: "persona-1",
  community_id: "community-1",
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 1,
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  study_profile_revision: 1,
  language_profile_revision: null,
  source_set_revision: 1,
  selection_policy_revision: "selection-v1",
  qualification_policy_revision: "qualification-v1",
  timezone: "UTC",
  status: "active",
  items: [item(0), item(1), item(2), item(3)],
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 1,
    first_pass_correct: 1,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "item-0",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: "2026-08-29T10:00:00.000Z",
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 0,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: "2026-08-29T00:00:00.000Z",
  completed_at: null,
};

const integration: IntegrationRecord = {
  communityId: "community-1",
  revision: 1,
  botEpoch: "epoch",
  botId: "123",
  botUsername: "fixture_bot",
  botToken: "encrypted-token",
  webhookId: "hook",
  webhookSecret: "secret",
  status: "ready",
  channelId: null,
  channelTitle: null,
  channelUsername: null,
  automaticSince: null,
  policy: { ...DEFAULT_ASSISTANT_POLICY, enabled: true },
  credentials: {
    openrouter: { ciphertext: "secret", status: "valid", checkedAt: "2026-10-03T00:00:00Z" },
  },
  lastError: null,
};
const inbox = (id: string): InboxRecord => ({
  id,
  communityId: integration.communityId,
  botEpoch: "epoch",
  update: { update_id: 1 },
  attempt: "attempt",
});
function strictPort<T extends object>(values: Partial<T>): T {
  return new Proxy(values, {
    get: (target, key) =>
      Reflect.get(target, key) ??
      (() => {
        throw Error(`Unexpected operation ${String(key)}`);
      }),
  }) as T;
}
function fixture() {
  let state = emptyTelegramStudyState(),
    now = 1000,
    sequence = 0,
    starts = 0,
    answers = 0,
    downloads = 0;
  let granted: TelegramStudyGrant | null = {
    accountId: "learner",
    personaId: "persona-1",
    revision: 1,
  };
  let current: StudySessionV2 = session;
  let busy = false,
    failReply = false,
    failNavigation = false,
    expired = false;
  // The restricted practice identity the platform would issue for this sender.
  let learnerAccount = false,
    enrollment: "issue" | "unavailable" = "issue";
  const enrollments: boolean[] = [];
  let failEnrollment = false;
  const restrictedGrant: TelegramStudyGrant = {
    accountId: "restricted-learner",
    personaId: "restricted-persona",
    revision: 0,
    restricted: true,
  };
  const replies: TelegramStudyReply[] = [];
  const promptIds = new Map<string, number>();
  const keys: string[] = [];
  const missing = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw Error(`Unexpected operation ${String(property)}`);
      },
    },
  );
  const services: TelegramServices = {
    store: missing as TelegramStore,
    api: strictPort<TelegramServices["api"]>({
      downloadVoice: async () => {
        downloads++;
        return new Uint8Array([79, 103, 103, 83]);
      },
    }),
    providers: missing as TelegramServices["providers"],
    vault: strictPort<TelegramServices["vault"]>({
      token: () => String(++sequence).padStart(43, "x"),
      hash: async (value: string) => `hash:${value}`,
      open: async () => JSON.stringify({ token: "fixture-token", secret: "fixture-secret" }),
    }),
    publicOrigin: "https://pirate.example.invalid",
    webhookOrigin: "https://api.example.invalid",
    now: () => now,
    wake: async () => {},
  };
  const study: TelegramStudyServices = {
    communityId: integration.communityId,
    store: {
      claim: async (sender, token) => (busy ? null : { sender, token, state }),
      save: async (_lease, next) => {
        state = next;
      },
      release: async () => {},
      catalogue: async () => [{ postId: "post-1", title: "Song" }],
      ready: async () => true,
      promptMessageId: async (id) => promptIds.get(id) ?? null,
      expired: async () => expired,
      cleanup: async () => {},
    },
    grant: async () => granted,
    enroll: async (_lease, input) => {
      enrollments.push(input.affirmed);
      if (failEnrollment) throw Error("enrollment unavailable");
      if (enrollment === "unavailable") return "unavailable";
      if (!learnerAccount && !input.affirmed) return "age_required";
      learnerAccount = true;
      granted = restrictedGrant;
      return restrictedGrant;
    },
    navigation: async () => {
      if (failNavigation) throw Error("navigation unavailable");
      return "https://pirate.example.invalid/telegram/link?navigation_reference=public";
    },
    start: async (_lease, _grant, _post, key) => {
      starts++;
      keys.push(key);
      return current;
    },
    session: async () => current,
    answer: async (_lease, _grant, input) => {
      answers++;
      keys.push(input.key);
      current = {
        ...session,
        lesson: {
          ...session.lesson,
          current: {
            presentation_number: 1,
            is_reappearance: false,
            presented_at: "2026-10-03T00:00:00Z",
            session_item_id: "item-1",
          },
        },
      };
      return {
        object: "study_answer_result_v2",
        session_item_id: input.itemId,
        exercise_type: "say_it_back",
        outcome: "incorrect",
        first_pass: true,
        attempt_number: input.attemptNumber,
        attempt_state: "spent",
        feedback: {
          kind: "transcript_diff",
          heard_transcript: "Hold",
          matched: [],
          missing: [{ token: "on", position: 1 }],
          extra: [],
          substituted: [],
          policy_revision: "fixture",
        },
        session: current,
      };
    },
    reply: async (_sender, _id, _chat, message) => {
      if (failReply) throw Error("delivery unavailable");
      if (
        message.keyboard &&
        typeof message.keyboard === "object" &&
        "force_reply" in message.keyboard &&
        message.keyboard.force_reply === true &&
        !promptIds.has(`hash:${_id}:reply`)
      )
        promptIds.set(`hash:${_id}:reply`, 99 + promptIds.size);
      replies.push(message);
    },
  };
  const send = (id: string, text: string) =>
    handleTelegramStudyChat(services, study, inbox(id), integration, "321", {
      message_id: 1,
      text,
    });
  const press = (id: string, data = `study:${state.token}:0`) =>
    handleTelegramStudyChat(
      services,
      study,
      inbox(id),
      integration,
      "321",
      { message_id: 1 },
      data,
    );
  const voice = (id: string, reply = 99, duration = 1, size = 4) =>
    handleTelegramStudyChat(services, study, inbox(id), integration, "321", {
      message_id: 2,
      reply_to_message: { message_id: reply },
      voice: { file_id: "voice", duration, file_size: size },
    });
  const begin = async () => {
    await send("picker", "/study");
    await press("choose");
  };
  return {
    services,
    study,
    send,
    press,
    voice,
    begin,
    replies,
    keys,
    state: () => state,
    counts: () => ({ starts, answers, downloads }),
    grant: (value: TelegramStudyGrant | null) => {
      granted = value;
    },
    advance: () => {
      now += 16 * 60 * 1000;
    },
    busy: () => {
      busy = true;
    },
    deliveryFailure: (value: boolean) => {
      failReply = value;
    },
    navigationFailure: () => {
      failNavigation = true;
    },
    enrollments,
    knownLearner: () => {
      learnerAccount = true;
    },
    enrollmentUnavailable: () => {
      enrollment = "unavailable";
    },
    enrollmentFailure: (value: boolean) => {
      failEnrollment = value;
    },
    learnerExists: () => learnerAccount,
    age: (id: string, answer: "age" | "minor" = "age") =>
      press(id, `study:${state.token}:${answer}`),
    expire: () => {
      expired = true;
    },
    session: (value: StudySessionV2) => {
      current = value;
    },
  };
}
test("a new learner practises after one explicit 16-or-older action, with no sign-in step", async () => {
  const f = fixture();
  f.grant(null);
  await f.send("picker", "/study");
  expect(f.enrollments).toEqual([]);
  await f.press("choose");
  const question = f.replies.at(-1);
  expect(question?.text).toContain("practice only. No rewards are earned in this lesson");
  expect(question?.text).toContain("voice notes");
  expect(question?.text).toContain("community owner");
  expect(question?.text).toContain("16 or older");
  expect(question?.buttons).toEqual([]);
  expect(JSON.stringify(question?.keyboard)).toContain("I'm 16 or older");
  expect(f.enrollments).toEqual([false]);
  expect(f.counts().starts).toBe(0);
  expect(f.state().observations.at(-1)?.stage).toBe("age");
  await f.age("affirm");
  expect(f.enrollments).toEqual([false, true]);
  expect(f.counts().starts).toBe(1);
  expect(f.keys).toEqual(["telegram:affirm:start"]);
  const card = f.replies.at(-1);
  expect(card?.text).toContain(
    "This lesson is practice only. No rewards are earned in this lesson.",
  );
  expect(card?.text).not.toContain("Persona:");
  expect(card?.text).not.toContain("restricted-persona");
  expect(f.state().grantRevision).toBe(0);
  expect(f.state().ageInboxId ?? null).toBeNull();
});
test("declined, stale, expired or typed answers never affirm an age or start a lesson", async () => {
  const declined = fixture();
  declined.grant(null);
  await declined.begin();
  await declined.age("no", "minor");
  expect(declined.replies.at(-1)?.text).toContain("16 or older");
  expect(declined.replies.at(-1)?.text).toContain("No profile was created");
  expect(declined.state().selectedPostId).toBeNull();
  const stale = fixture();
  stale.grant(null);
  await stale.begin();
  const old = `study:${stale.state().token}:age`;
  await stale.send("again", "/study");
  await stale.press("old", old);
  expect(stale.replies.at(-1)?.text).toContain("ended");
  // The age answer needs the sender's own current song choice.
  await stale.age("no-song");
  expect(stale.replies.at(-1)?.text).toContain("expired");
  await stale.send("typed", "I'm 16 or older");
  await stale.send("resume", "/resume");
  expect(stale.replies.at(-1)?.text).toContain("/study");
  const late = fixture();
  late.grant(null);
  await late.begin();
  late.advance();
  await late.age("late");
  expect(late.replies.at(-1)?.text).toContain("expired");
  for (const f of [declined, stale, late]) {
    expect(f.enrollments).not.toContain(true);
    expect(f.counts().starts).toBe(0);
  }
});
test("a retried affirmation replays one identity and one lesson start", async () => {
  const f = fixture();
  f.grant(null);
  await f.begin();
  f.deliveryFailure(true);
  await expect(f.age("affirm")).rejects.toThrow("delivery unavailable");
  f.deliveryFailure(false);
  const data = "study:stale-token:age";
  await f.press("affirm", data);
  expect(f.enrollments).toEqual([false, true]);
  expect(f.counts().starts).toBe(1);
  expect(f.replies.at(-1)?.text).toContain("Read aloud");
});
test("a decline sent while a failed affirmation awaits retry is honoured", async () => {
  const f = fixture();
  f.grant(null);
  await f.begin();
  const visible = f.state().token;
  f.enrollmentFailure(true);
  await expect(f.age("affirm")).rejects.toThrow("enrollment unavailable");
  f.enrollmentFailure(false);
  // The buttons the learner can still see keep working until a lesson starts.
  expect(f.state().token).toBe(visible);
  await f.press("decline", `study:${visible}:minor`);
  expect(f.replies.at(-1)?.text).toContain("No profile was created");
  await f.press("affirm", `study:${visible}:age`);
  expect(f.replies.at(-1)?.text).toContain("ended");
  expect(f.learnerExists()).toBe(false);
  expect(f.counts().starts).toBe(0);
  expect(f.enrollments.filter(Boolean)).toHaveLength(1);
});
test("a known restricted learner starts without another age question; exhausted limits start nothing", async () => {
  const f = fixture();
  f.grant(null);
  f.knownLearner();
  await f.begin();
  expect(f.enrollments).toEqual([false]);
  expect(f.counts().starts).toBe(1);
  expect(f.replies.at(-1)?.text).toContain("Read aloud");
  const g = fixture();
  g.grant(null);
  g.enrollmentUnavailable();
  await g.begin();
  expect(g.counts().starts).toBe(0);
  expect(g.replies.at(-1)?.text).toContain("cannot start right now");
  expect(g.state().selectedPostId).toBeNull();
});
test("completion offers the optional connection to restricted learners only", async () => {
  const completed: StudySessionV2 = {
    ...session,
    status: "completed",
    completed_at: "2026-10-03T00:00:00Z",
    lesson: { ...session.lesson, current: null, completion_reason: "all_resolved" },
  };
  const f = fixture();
  f.grant(null);
  f.knownLearner();
  f.session(completed);
  await f.begin();
  expect(f.replies.at(-1)?.text).toContain("No reward or pool share was earned");
  expect(f.replies.at(-1)?.text).toContain("Optional");
  expect(f.replies.at(-1)?.text).not.toContain("Persona:");
  expect(f.replies.at(-1)?.buttons).toEqual([
    {
      text: "Connect an existing Pirate account",
      url: "https://pirate.example.invalid/telegram/link?navigation_reference=public",
    },
  ]);
  const unlinked = fixture();
  unlinked.grant(null);
  unlinked.knownLearner();
  unlinked.navigationFailure();
  unlinked.session(completed);
  await unlinked.begin();
  expect(unlinked.replies.at(-1)?.text).toContain("Practice complete");
  expect(unlinked.replies.at(-1)?.buttons).toEqual([]);
  const linked = fixture();
  linked.session(completed);
  await linked.begin();
  expect(linked.replies.at(-1)?.text).toContain("Persona: persona-1");
  expect(linked.replies.at(-1)?.buttons).toEqual([]);
  expect(linked.enrollments).toEqual([]);
});
test("real session determines count and threshold; callback tokens rotate without answer keys", async () => {
  const f = fixture();
  f.session({
    ...session,
    items: Array.from({ length: 10 }, (_, i) => item(i)),
    progress: { ...session.progress, required_correct: 7 },
    lesson: { ...session.lesson, total_card_count: 10, presentation_cap: 20 },
  });
  await f.send("picker", "/study");
  const token = f.state().token;
  await f.press("choose");
  expect(f.replies.at(-1)?.text).toContain("10 cards; 7 first-try correct");
  expect(f.replies.at(-1)?.text).toContain("Persona: persona-1");
  expect(f.replies.at(-1)?.keyboard).toEqual({ force_reply: true, selective: true });
  await f.press("old", `study:${token}:0`);
  expect(f.counts().starts).toBe(1);
  expect(f.replies.at(-1)?.text).toContain("ended");
});
test("typed text and replies to old prompts never download or grade audio", async () => {
  const f = fixture();
  await f.begin();
  await f.send("text", "typed answer");
  await f.voice("late", 98);
  expect(f.counts()).toEqual({ starts: 1, answers: 0, downloads: 0 });
  expect(f.replies.at(-1)?.text).toContain("No attempt was used");
});
test("delivery failure replays the accepted answer and feedback without grading another card", async () => {
  const f = fixture();
  await f.begin();
  f.deliveryFailure(true);
  await expect(f.voice("answer")).rejects.toThrow("delivery unavailable");
  expect(f.counts().answers).toBe(1);
  f.deliveryFailure(false);
  await f.voice("answer");
  expect(f.counts()).toEqual({ starts: 1, answers: 1, downloads: 1 });
  expect(f.replies.at(-1)?.text).toContain("Try saying: on");
  expect(f.state().turn?.itemId).toBe("item-1");
  expect(f.keys.at(-1)).toBe("telegram:answer:answer");
});
test("uncertain provider completion retains the exact answer command on retry", async () => {
  const f = fixture();
  await f.begin();
  const normal = f.study.answer;
  let first = true;
  Object.assign(f.study, {
    answer: async (
      lease: Parameters<TelegramStudyServices["answer"]>[0],
      grant: TelegramStudyGrant,
      input: Parameters<TelegramStudyServices["answer"]>[2],
    ) => {
      if (first) {
        first = false;
        throw Error("uncertain commit");
      }
      return normal(lease, grant, input);
    },
  });
  await expect(f.voice("answer")).rejects.toThrow("uncertain commit");
  expect(f.state().pendingAnswer?.itemId).toBe("item-0");
  await f.voice("answer");
  expect(f.state().pendingAnswer).toBeNull();
  expect(f.keys.at(-1)).toBe("telegram:answer:answer");
});
test("provider unavailability spends no attempt; cancel and resume preserve progress", async () => {
  const f = fixture();
  await f.begin();
  Object.assign(f.study, {
    answer: async () => {
      throw new StudyV2CommandRejected({ reason: "provider-unavailable" });
    },
  });
  await f.voice("failed");
  expect(f.state().pendingAnswer).toBeNull();
  expect(f.replies.at(-1)?.text).toContain("No attempt was used");
  await f.send("cancel", "/cancel");
  expect(f.state().sessionId).toBe(session.session_id);
  expect(f.state().turn).toBeNull();
  await f.send("resume", "/resume");
  expect(f.state().turn?.itemId).toBe("item-0");
});
test("revoked or changed persona grants cannot continue grading; expired sessions explain restart", async () => {
  const f = fixture();
  await f.begin();
  f.grant(null);
  await f.voice("revoked");
  expect(f.counts().answers).toBe(0);
  f.grant({ accountId: "learner", personaId: "second", revision: 2 });
  await f.voice("changed");
  expect(f.counts().answers).toBe(0);
  expect(f.state().sessionId).toBeNull();
  const g = fixture();
  await g.begin();
  g.expire();
  await g.send("expired", "/resume");
  expect(g.replies.at(-1)?.text).toContain("expired");
});
test("busy conversation retries instead of acknowledging lost work", async () => {
  const f = fixture();
  f.busy();
  await expect(f.send("busy", "/study")).rejects.toMatchObject({ reason: "unavailable" });
});
test("completion and bounded observations carry no reward or voice-derived telemetry", async () => {
  const f = fixture();
  f.session({
    ...session,
    status: "completed",
    completed_at: "2026-10-03T00:00:00Z",
    lesson: { ...session.lesson, current: null, completion_reason: "all_resolved" },
  });
  await f.begin();
  expect(f.replies.at(-1)?.text).toContain("No reward or pool share was earned");
  expect(f.state().observations.at(-1)?.stage).toBe("completion");
  expect(JSON.stringify(f.state().observations)).not.toContain("Hold");
});
test("old callbacks acknowledge and reply before /start, even if acknowledgement has expired", async () => {
  const f = fixture();
  const item = {
    ...inbox("old"),
    update: {
      update_id: 1,
      callback_query: {
        id: "old-id",
        from: { id: 321, is_bot: false },
        message: { message_id: 1, chat: { id: 321, type: "private" } },
        data: "legacy",
      },
    },
  };
  const calls: string[] = [];
  f.services.store = strictPort<TelegramStore>({
    learnerLanguageContext: async () => ({
      preference: { locale: "en", explicit: true },
      accountLocale: null,
      helperLanguage: null,
      communityName: "Fixture community",
      resumeAvailable: false,
    }),
    claimInbox: async () => item,
    integration: async () => integration,
    privateChatStarted: async () => false,
    enqueueDelivery: async () => {
      calls.push("reply");
    },
    finishInbox: async (_item: InboxRecord, error: string | null) => {
      expect(error).toBeNull();
      calls.push("finish");
    },
  });
  f.services.api = {
    ...f.services.api,
    call: async () => {
      calls.push("ack");
      throw Error("old callback");
    },
  };
  await processTelegramInbox(f.services, "old");
  expect(calls).toEqual(["ack", "reply", "finish"]);
});
test("unknown commands never invoke the paid assistant", async () => {
  const f = fixture();
  const item = {
    ...inbox("unknown"),
    update: {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 321, is_bot: false },
        chat: { id: 321, type: "private" },
        text: "/unknown",
      },
    },
  };
  let reply = "";
  f.services.store = strictPort<TelegramStore>({
    learnerLanguageContext: async () => ({
      preference: { locale: "en", explicit: true },
      accountLocale: null,
      helperLanguage: null,
      communityName: "Fixture community",
      resumeAvailable: false,
    }),
    claimInbox: async () => item,
    integration: async () => integration,
    privateChatStarted: async () => true,
    enqueueDelivery: async (input: { desired?: { text: string } | null }) => {
      reply = input.desired?.text ?? "";
    },
    finishInbox: async (_item: InboxRecord, error: string | null) => {
      expect(error).toBeNull();
    },
  });
  await processTelegramInbox(f.services, "unknown");
  expect(reply).toContain("Unknown command");
});

test("reordered voice for an already graded prompt cannot grade the next card", async () => {
  const f = fixture();
  await f.begin();
  await f.voice("first");
  await f.voice("late", 99);
  expect(f.counts().answers).toBe(1);
  expect(f.state().turn?.itemId).toBe("item-1");
  expect(f.replies.at(-1)?.text).toContain("No attempt was used");
});

test("practice is unavailable in communities outside the admitted pilot", async () => {
  const f = fixture();
  f.services.study = { ...f.services.study!, communityId: "another-community" };
  const item = {
    ...inbox("outside"),
    update: {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 321, is_bot: false },
        chat: { id: 321, type: "private" },
        text: "/study",
      },
    },
  };
  let reply = "";
  f.services.store = strictPort<TelegramStore>({
    learnerLanguageContext: async () => ({
      preference: { locale: "en", explicit: true },
      accountLocale: null,
      helperLanguage: null,
      communityName: "Fixture community",
      resumeAvailable: false,
    }),
    claimInbox: async () => item,
    integration: async () => integration,
    privateChatStarted: async () => true,
    enqueueDelivery: async (input: { desired?: { text: string } | null }) => {
      reply = input.desired?.text ?? "";
    },
    finishInbox: async (_item: InboxRecord, error: string | null) => {
      expect(error).toBeNull();
    },
  });
  await processTelegramInbox(f.services, "outside");
  expect(reply).toContain("Native Study is not available");
  expect(f.counts().starts).toBe(0);
});

test.each([61, 120, 121])(
  "oversized duration %i replies without checkpointing or downloading",
  async (duration) => {
    const f = fixture();
    await f.begin();
    const save = f.study.store.save;
    Object.assign(f.study.store, {
      save: async (...args: Parameters<typeof save>) => {
        expect(args[1].pendingAnswer).toBeNull();
        return save(...args);
      },
    });
    await f.voice("long", 99, duration);
    expect(f.counts()).toEqual({ starts: 1, answers: 0, downloads: 0 });
    expect(f.replies.at(-1)?.text).toContain("No attempt was used");
    expect(f.replies.at(-1)?.text).toContain("minute");
    await f.send("resume-long", "/resume");
    expect(f.state().turn?.itemId).toBe("item-0");
  },
);
test("file metadata and downloaded bytes are both bounded before pending persistence", async () => {
  const f = fixture();
  await f.begin();
  await f.voice("metadata", 99, 1, 524289);
  expect(f.counts().downloads).toBe(0);
  const save = f.study.store.save;
  Object.assign(f.study.store, {
    save: async (...args: Parameters<typeof save>) => {
      expect(args[1].pendingAnswer).toBeNull();
      return save(...args);
    },
  });
  Object.assign(f.services.api, { downloadVoice: async () => new Uint8Array(524289) });
  await f.voice("bytes");
  expect(f.counts().answers).toBe(0);
  expect(f.replies.at(-1)?.text).toContain("No attempt was used");
  await f.send("resume-bytes", "/resume");
  expect(f.state().turn?.itemId).toBe("item-0");
});
test("the exact Study duration and byte limits remain accepted", async () => {
  const f = fixture();
  await f.begin();
  Object.assign(f.services.api, { downloadVoice: async () => new Uint8Array(524288) });
  await f.voice("boundary", 99, 60, 524288);
  expect(f.counts().answers).toBe(1);
  expect(f.state().pendingAnswer).toBeNull();
});
test.each([
  "attempt-conflict",
  "idempotency-conflict",
  "invalid-input",
  "submission-kind-mismatch",
  "transcript-evidence-expired",
  "transcript-evidence-mismatch",
  "transcript-evidence-not-found",
  "insufficient-exercises",
] as const)(
  "permanent %s refusal clears the note and reloads the current prompt",
  async (reason) => {
    const f = fixture();
    await f.begin();
    const normal = f.study.answer;
    Object.assign(f.study, {
      answer: async () => {
        throw new StudyV2CommandRejected({ reason });
      },
    });
    f.session({
      ...session,
      lesson: {
        ...session.lesson,
        current: {
          session_item_id: "item-1",
          presentation_number: 1,
          is_reappearance: false,
          presented_at: "2026-10-04T00:00:00Z",
        },
      },
    });
    await f.voice("rejected");
    expect(f.state().pendingAnswer).toBeNull();
    expect(f.state().turn?.itemId).toBe("item-1");
    expect(f.replies.at(-1)?.text).toContain("Hold on");
    Object.assign(f.study, { answer: normal });
    await f.voice("new-answer", 100);
    expect(f.counts().answers).toBe(1);
  },
);
test("an in-flight command retains the answer identity for retry", async () => {
  const f = fixture();
  await f.begin();
  Object.assign(f.study, {
    answer: async () => {
      throw new StudyV2CommandRejected({ reason: "command-in-flight" });
    },
  });
  await expect(f.voice("busy-answer")).rejects.toMatchObject({ reason: "command-in-flight" });
  expect(f.state().pendingAnswer?.inboxId).toBe("busy-answer");
});

test("slow grading reacquires the lease and recovers without blaming the learner", async () => {
  const f = fixture();
  await f.begin();
  let token: string | null = null;
  const claim = f.study.store.claim;
  Object.assign(f.study.store, {
    claim: async (...args: Parameters<typeof claim>) => {
      const held = await claim(...args);
      token = held?.token ?? null;
      return held;
    },
  });
  const save = f.study.store.save;
  Object.assign(f.study.store, {
    save: async (...args: Parameters<typeof save>) => {
      if (token === null) throw Error("Missing claimed lease token");
      expect(args[0].token).toBe(token);
      return save(...args);
    },
  });
  Object.assign(f.study, {
    answer: async () => {
      token = "expired";
      throw new TelegramStudyLeaseExpired();
    },
  });
  await f.voice("slow");
  expect(f.state().pendingAnswer).toBeNull();
  expect(f.replies.at(-1)?.text).toContain("took too long");
  expect(f.replies.at(-1)?.text).not.toContain("unavailable");
  await f.send("after-slow", "/resume");
  expect(f.state().turn?.itemId).toBe("item-0");
});
test("recovery never revives a lesson cancelled while the expired lease was released", async () => {
  const f = fixture();
  await f.begin();
  const normal = f.study.store.release;
  let first = true;
  Object.assign(f.study.store, {
    release: async (...args: Parameters<typeof normal>) => {
      if (first) {
        first = false;
        await f.send("concurrent-cancel", "/cancel");
      }
      return normal(...args);
    },
  });
  Object.assign(f.study, {
    answer: async () => {
      throw new TelegramStudyLeaseExpired();
    },
  });
  await expect(f.voice("slow-cancelled")).rejects.toMatchObject({ reason: "unavailable" });
  expect(f.state().turn).toBeNull();
  expect(f.state().pendingAnswer).toBeNull();
  expect(f.replies.at(-1)?.text).toContain("Practice stopped");
});
test("a failed session reload still clears a permanently rejected note", async () => {
  const f = fixture();
  await f.begin();
  Object.assign(f.study, {
    answer: async () => {
      throw new StudyV2CommandRejected({ reason: "attempt-conflict" });
    },
    session: async () => {
      throw Error("temporary database failure");
    },
  });
  await expect(f.voice("conflict-reload")).rejects.toThrow("temporary database failure");
  expect(f.state().pendingAnswer).toBeNull();
  await f.send("after-failed-reload", "/study");
  expect(f.replies.at(-1)?.text).toContain("Choose a song");
});

test.each(["constraint", "outcome-unknown", "unavailable", "invalid-row"] as const)(
  "storage %s preserves only outcomes that remain uncertain or retryable",
  async (reason) => {
    const f = fixture();
    await f.begin();
    Object.assign(f.study, {
      answer: async () => {
        throw new StudyV2StoreFailed({ reason });
      },
    });
    if (reason === "constraint") {
      await f.voice("store-refusal");
      expect(f.state().pendingAnswer).toBeNull();
      await f.send("store-resume", "/resume");
      expect(f.state().turn?.itemId).toBe("item-0");
    } else {
      await expect(f.voice("store-refusal")).rejects.toMatchObject({ reason });
      expect(f.state().pendingAnswer?.inboxId).toBe("store-refusal");
    }
  },
);

test("a pending answer gives guidance to new messages without losing its retry identity", async () => {
  const f = fixture();
  await f.begin();
  const normal = f.study.answer;
  Object.assign(f.study, {
    answer: async () => {
      throw new StudyV2StoreFailed({ reason: "outcome-unknown" });
    },
  });
  await expect(f.voice("unknown-answer")).rejects.toMatchObject({ reason: "outcome-unknown" });
  await f.send("resume-pending", "/resume");
  expect(f.replies.at(-1)?.text).toContain("previous voice answer has not finished");
  expect(f.state().pendingAnswer?.inboxId).toBe("unknown-answer");
  await f.voice("second-pending");
  expect(f.state().pendingAnswer?.inboxId).toBe("unknown-answer");
  expect(f.counts().answers).toBe(0);
  Object.assign(f.study, { answer: normal });
  await f.voice("unknown-answer");
  expect(f.keys.at(-1)).toBe("telegram:unknown-answer:answer");
  expect(f.counts().answers).toBe(1);
});

for (const locale of ["ru", "ka"] as const) {
  test(`localized ${locale} practice preserves English source lines and the current turn`, async () => {
    const f = fixture();
    await f.begin();
    const before = f.state().turn;
    await handleTelegramStudyChat(
      f.services,
      f.study,
      inbox(`resume-${locale}`),
      integration,
      "321",
      { message_id: 11, text: "/resume" },
      undefined,
      locale,
    );
    expect(f.state().turn?.itemId).toBe(before?.itemId);
    expect(f.replies.at(-1)?.text).toContain("Hold on");
    expect(f.replies.at(-1)?.text).not.toContain("Read aloud");
    expect(f.counts().answers).toBe(0);
  });
}
