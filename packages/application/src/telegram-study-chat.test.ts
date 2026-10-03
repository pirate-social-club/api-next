import { expect, test } from "bun:test";
import type { StudySessionItemV2, StudySessionV2 } from "@pirate/contracts";
import { StudyV2CommandRejected } from "./study-v2-service.ts";
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
    expired = false;
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
    navigation: async () =>
      "https://pirate.example.invalid/telegram/link?navigation_reference=public",
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
  const voice = (id: string, reply = 99) =>
    handleTelegramStudyChat(services, study, inbox(id), integration, "321", {
      message_id: 2,
      reply_to_message: { message_id: reply },
      voice: { file_id: "voice", duration: 1, file_size: 4 },
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
    expire: () => {
      expired = true;
    },
    session: (value: StudySessionV2) => {
      current = value;
    },
  };
}
test("selection discloses voice, practice and owner access before linking; expiry grants nothing", async () => {
  const f = fixture();
  f.grant(null);
  await f.begin();
  expect(f.replies.at(-1)?.text).toContain("Voice answers are required");
  expect(f.replies.at(-1)?.text).toContain("community owner");
  expect(f.counts().starts).toBe(0);
  f.advance();
  f.grant({ accountId: "learner", personaId: "persona-1", revision: 1 });
  await f.send("resume", "/resume");
  expect(f.counts().starts).toBe(0);
  expect(f.replies.at(-1)?.text).toContain("unavailable");
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
