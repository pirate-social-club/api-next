import type { StudySessionV2 } from "@pirate/contracts";
import { boundedTelegramText } from "@pirate/domain/telegram";
import { Schema } from "effect";
import { StudyV2CommandRejected, StudyV2StoreFailed } from "./study-v2-service.ts";
import { type TelegramLocale, telegramText } from "./telegram/copy.ts";
import { telegramBotCredentials } from "./telegram/delivery.ts";
import type { InboxRecord, IntegrationRecord, TelegramServices } from "./telegram/types.ts";
import { TelegramFailure } from "./telegram/types.ts";
import {
  TelegramStudyLeaseExpired,
  type TelegramStudyReply,
  type TelegramStudyServices,
  type TelegramStudyState,
} from "./telegram-study.ts";

const Id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
const Incoming = Schema.Struct({
  message_id: Id,
  text: Schema.optional(Schema.String),
  voice: Schema.optional(
    Schema.Struct({
      file_id: Schema.String.check(Schema.isMaxLength(512)),
      duration: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      file_size: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      ),
    }),
  ),
  reply_to_message: Schema.optional(Schema.Struct({ message_id: Id })),
});
const text = (value: string): TelegramStudyReply => ({
  kind: "text",
  text: boundedTelegramText(value),
  media: null,
  buttons: [],
});

/**
 * Read-aloud practice in a private chat, shaped like the legacy bot: a song list, then one
 * short prompt per line. An answer is a voice note sent as a reply to the current prompt.
 */
export async function handleTelegramStudyChat(
  services: TelegramServices,
  study: TelegramStudyServices,
  inbox: InboxRecord,
  integration: IntegrationRecord,
  senderId: string,
  rawMessage: unknown,
  callbackData?: string,
  locale: TelegramLocale = "en",
): Promise<void> {
  const t = (
    key: Parameters<typeof telegramText>[1],
    values?: Readonly<Record<string, string | number>>,
  ) => telegramText(locale, key, values);
  if (!integration.botId) throw new TelegramFailure({ reason: "unavailable" });
  const sender = {
    communityId: inbox.communityId,
    botId: integration.botId,
    epoch: inbox.botEpoch,
    telegramUserId: senderId,
  };
  const lease = await study.store.claim(sender, services.vault.token());
  if (!lease) throw new TelegramFailure({ reason: "unavailable" });
  // Keep the acquired lease narrowed across asynchronous closures.
  let activeLease = lease;
  let state: TelegramStudyState = lease.state;
  const persist = async () => {
    await study.store.save(activeLease, state);
  };
  const observe = (
    stage: TelegramStudyState["observations"][number]["stage"],
    card: number | null = null,
    presentation: number | null = null,
  ) => {
    state = {
      ...state,
      observations: [
        ...state.observations,
        { stage, at: services.now(), card, presentation },
      ].slice(-64),
    };
  };
  // Feedback is its own message and is always delivered before the message that follows it.
  const send = async (message: TelegramStudyReply, feedback: TelegramStudyReply | null) => {
    if (feedback === null) {
      await study.reply(sender, inbox.id, senderId, message);
      return;
    }
    const first = await study.reply(sender, inbox.id, senderId, feedback, "feedback");
    await study.reply(sender, inbox.id, senderId, { ...message, after: first });
  };
  const respond = async (
    message: TelegramStudyReply,
    feedback: TelegramStudyReply | null = null,
  ) => {
    state = { ...state, lastInboxId: inbox.id, lastReply: message, lastFeedback: feedback };
    await persist();
    await send(message, feedback);
  };
  const showSession = async (
    session: StudySessionV2,
    feedback: TelegramStudyReply | null = null,
  ) => {
    const current = session.lesson.current;
    state = {
      ...state,
      sessionId: session.session_id,
      pendingAnswer: null,
      token: services.vault.token(),
      selectedPostId: null,
      selectionInboxId: null,
      navigationUrl: null,
      selectedUntil: 0,
    };
    if (session.status === "completed" || current === null) {
      // "Practice again" is a song choice from a one-song list: the lesson just finished.
      state = {
        ...state,
        turn: null,
        songs: [
          {
            postId: session.post_id,
            title: state.songs.find((song) => song.postId === session.post_id)?.title ?? "",
          },
        ],
        selectedUntil: services.now() + 15 * 60 * 1000,
      };
      observe("completion", session.items.length);
      await respond(
        {
          ...text(
            t("complete", {
              correct: session.progress.first_pass_correct,
              total: session.items.length,
            }),
          ),
          keyboard: {
            inline_keyboard: [
              [
                { text: t("chooseSongAction"), callback_data: "tg-menu:songs" },
                { text: t("practiceAgain"), callback_data: `study:${state.token}:0` },
              ],
            ],
          },
        },
        feedback,
      );
      return;
    }
    const item = session.items.find((row) => row.session_item_id === current.session_item_id);
    if (item?.presentation.kind !== "say_it_back")
      throw new TelegramFailure({ reason: "unavailable" });
    observe("card", item.ordinal, current.presentation_number);
    state = {
      ...state,
      turn: {
        itemId: item.session_item_id,
        attemptNumber: current.presentation_number,
        deliveryId: await services.vault.hash(`${inbox.id}:reply`),
      },
    };
    // The prompt is the instruction and the line, nothing else.
    await respond(
      {
        ...text(t("sayThis", { line: item.presentation.reference_text })),
        keyboard: { force_reply: true, selective: true },
      },
      feedback,
    );
  };
  try {
    if (state.lastInboxId === inbox.id && state.lastReply !== null) {
      await send(state.lastReply, state.lastFeedback ?? null);
      return;
    }
    const parsed = Schema.decodeUnknownOption(Incoming)(rawMessage);
    const message = parsed._tag === "Some" ? parsed.value : null;
    const command = (message?.text ?? "").trim().replace(/@[A-Za-z0-9_]+(?=\s|$)/u, "");
    if (command === "/help") {
      await respond(text(t("studyHelp")));
      return;
    }
    if (command === "/cancel") {
      observe("cancel");
      state = {
        ...state,
        turn: null,
        pendingAnswer: null,
        selectedPostId: null,
        selectionInboxId: null,
        navigationUrl: null,
        selectedUntil: 0,
        token: services.vault.token(),
      };
      await respond(text(t("stopped")));
      return;
    }
    if (
      callbackData !== undefined &&
      state.selectionInboxId !== inbox.id &&
      !callbackData.startsWith(`study:${state.token}:`)
    ) {
      await respond(text(t("ended")));
      return;
    }
    if (state.pendingAnswer !== null && state.pendingAnswer.inboxId !== inbox.id) {
      await respond(text(t("processing")));
      return;
    }
    if (command === "/study" || command === "/songs") {
      observe("selection");
      const songs = await study.store.catalogue(sender.communityId);
      state = {
        ...state,
        songs: [...songs],
        token: services.vault.token(),
        selectedPostId: null,
        selectedUntil: services.now() + 15 * 60 * 1000,
      };
      await respond({
        ...text(songs.length ? t("chooseSong") : t("noReadySongs")),
        keyboard: {
          inline_keyboard: songs.map((song, index) => [
            { text: song.title.slice(0, 60), callback_data: `study:${state.token}:${index}` },
          ]),
        },
      });
      return;
    }
    if (callbackData !== undefined && state.selectionInboxId !== inbox.id) {
      // Buttons from the removed age question fail this check like any other stale choice.
      const suffix = callbackData.slice(`study:${state.token}:`.length);
      if (!/^[0-7]$/u.test(suffix) || services.now() >= state.selectedUntil) {
        await respond(text(t("selectionExpired")));
        return;
      }
      const song = state.songs[Number(suffix)];
      if (!song || !(await study.store.ready(sender.communityId, song.postId))) {
        await respond(text(t("songUnavailable")));
        return;
      }
      state = {
        ...state,
        selectedPostId: song.postId,
        selectionInboxId: inbox.id,
        navigationUrl: null,
        selectedUntil: services.now() + 15 * 60 * 1000,
        token: services.vault.token(),
      };
      await persist();
    }
    let grant = await study.grant(sender);
    if (!grant) {
      state = { ...state, pendingAnswer: null, turn: null };
      // Only a deliberate song choice, never /study or a typed command, issues an identity.
      if (
        callbackData === undefined ||
        state.selectedPostId === null ||
        services.now() >= state.selectedUntil
      ) {
        await respond(text(t("chooseFirst")));
        return;
      }
      const enrolled = await study.enroll(activeLease);
      if (enrolled === "unavailable") {
        state = { ...state, selectedPostId: null, selectionInboxId: null, selectedUntil: 0 };
        await respond(text(t("practiceUnavailable")));
        return;
      }
      grant = enrolled;
    }
    if (state.sessionId !== null && state.grantRevision !== grant.revision) {
      state = { ...state, sessionId: null, turn: null, pendingAnswer: null, grantRevision: null };
    }
    if (state.selectedPostId !== null && (command === "/resume" || callbackData !== undefined)) {
      if (
        services.now() >= state.selectedUntil ||
        !(await study.store.ready(sender.communityId, state.selectedPostId))
      ) {
        state = {
          ...state,
          selectedPostId: null,
          selectionInboxId: null,
          navigationUrl: null,
          selectedUntil: 0,
        };
        await respond(text(t("selectionUnavailable")));
        return;
      }
      const session = await study.start(
        activeLease,
        grant,
        state.selectedPostId,
        `telegram:${inbox.id}:start`,
      );
      state = { ...state, grantRevision: grant.revision };
      await showSession(session);
      return;
    }
    if (state.sessionId !== null && (await study.store.expired(state.sessionId))) {
      state = { ...state, sessionId: null, turn: null, pendingAnswer: null };
      await respond(text(t("sessionExpired")));
      return;
    }
    if (command === "/resume" && state.sessionId !== null) {
      await showSession(await study.session(activeLease, grant, state.sessionId));
      return;
    }
    if (
      state.sessionId !== null &&
      state.turn !== null &&
      (message?.voice !== undefined || state.pendingAnswer?.inboxId === inbox.id)
    ) {
      const oversized = () => respond(text(t("shorterVoice")));
      let pending = state.pendingAnswer;
      if (pending === null) {
        // An answer is a voice note sent as a reply to the current prompt, nothing else.
        if (
          !message?.voice ||
          message.reply_to_message?.message_id !==
            (await study.store.promptMessageId(state.turn.deliveryId))
        ) {
          await respond(text(t("replyToLine")));
          return;
        }
        if (message.voice.duration > 60 || (message.voice.file_size ?? 0) > 524288) {
          await oversized();
          return;
        }
        pending = {
          inboxId: inbox.id,
          sessionId: state.sessionId,
          itemId: state.turn.itemId,
          attemptNumber: state.turn.attemptNumber,
          fileId: message.voice.file_id,
          durationMs: message.voice.duration * 1000,
          messageId: message.message_id,
        };
      }
      if (pending.durationMs > 60000) {
        state = { ...state, pendingAnswer: null };
        await oversized();
        return;
      }
      const bot = await telegramBotCredentials(services, integration);
      const audio = await services.api.downloadVoice(bot.token, pending.fileId);
      if (audio.byteLength < 1 || audio.byteLength > 524288) {
        state = { ...state, pendingAnswer: null };
        await oversized();
        return;
      }
      if (state.pendingAnswer === null) {
        state = {
          ...state,
          pendingAnswer: pending,
        };
        await persist();
      }
      const result = await study.answer(activeLease, grant, {
        sessionId: pending.sessionId,
        itemId: pending.itemId,
        attemptNumber: pending.attemptNumber,
        key: `telegram:${inbox.id}:answer`,
        audio,
        durationMs: pending.durationMs,
      });
      const heard =
        result.feedback.kind === "transcript_diff"
          ? result.feedback.heard_transcript.slice(0, 200)
          : "";
      const verdict =
        result.outcome === "correct"
          ? t("correct")
          : result.outcome === "ungraded_rerecord"
            ? t("rerecord")
            : heard
              ? `${t("incorrect")}\n${t("heard", { answer: heard })}`
              : t("incorrect");
      // The verdict answers the learner's voice note; the next prompt is a separate message.
      await showSession(result.session, {
        ...text(verdict),
        ...(pending.messageId === undefined ? {} : { replyTo: pending.messageId }),
      });
      return;
    }
    // Anything else leaves the lesson and its attempts untouched.
    await respond(text(state.sessionId !== null ? t("voiceRequired") : t("chooseFirst")));
  } catch (error) {
    if (
      (error instanceof StudyV2CommandRejected && error.reason !== "command-in-flight") ||
      (error instanceof StudyV2StoreFailed && error.reason === "constraint")
    ) {
      // Recovery also needs a fresh lease when a slow provider exhausted the old one.
      // Never overwrite state acquired by another handler in the release/claim gap.
      const priorInboxId = state.lastInboxId;
      await study.store.release(activeLease);
      const recoveredLease = await study.store.claim(sender, services.vault.token());
      if (!recoveredLease) throw new TelegramFailure({ reason: "unavailable" });
      activeLease = recoveredLease;
      state = recoveredLease.state;
      if (
        state.lastInboxId !== priorInboxId ||
        (state.pendingAnswer !== null && state.pendingAnswer.inboxId !== inbox.id)
      )
        throw new TelegramFailure({ reason: "unavailable" });
      state = { ...state, pendingAnswer: null };
      observe("unavailable");
      await persist();
      const currentGrant = await study.grant(sender);
      if (currentGrant && state.sessionId && state.grantRevision === currentGrant.revision) {
        let current: StudySessionV2 | null = null;
        try {
          current = await study.session(activeLease, currentGrant, state.sessionId);
        } catch (reloadError) {
          if (
            !(reloadError instanceof StudyV2CommandRejected) ||
            reloadError.reason !== "not-found"
          )
            throw reloadError;
        }
        if (current) {
          await showSession(
            current,
            text(
              error instanceof TelegramStudyLeaseExpired
                ? t("gradingTimeout")
                : error instanceof StudyV2CommandRejected && error.reason === "provider-unavailable"
                  ? t("gradingUnavailable")
                  : t("answerUnavailable"),
            ),
          );
          return;
        }
      }
      state = { ...state, turn: null, sessionId: null };
      await respond(text(t("grantUnavailable")));
    } else throw error;
  } finally {
    await study.store.release(activeLease);
  }
}
