import type { StudySessionV2 } from "@pirate/contracts";
import { boundedTelegramText } from "@pirate/domain/telegram";
import { Schema } from "effect";
import { StudyV2CommandRejected, StudyV2StoreFailed } from "./study-v2-service.ts";
import { type TelegramLocale, telegramText } from "./telegram/copy.ts";
import { telegramBotCredentials } from "./telegram/delivery.ts";
import type { InboxRecord, IntegrationRecord, TelegramServices } from "./telegram/types.ts";
import { TelegramFailure } from "./telegram/types.ts";
import {
  type TelegramStudyGrant,
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
  const help = t("studyHelp");
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
  const respond = async (message: TelegramStudyReply) => {
    state = { ...state, lastInboxId: inbox.id, lastReply: message };
    await persist();
    await study.reply(sender, inbox.id, senderId, message);
  };
  const showSession = async (
    session: StudySessionV2,
    prefix: string,
    grant: TelegramStudyGrant,
  ) => {
    const current = session.lesson.current;
    // A restricted practice identity has no public persona to name.
    const identity = grant.restricted
      ? ""
      : `${t("personaLine", { persona: grant.personaLabel ?? session.persona_id })}\n`;
    state = {
      ...state,
      sessionId: session.session_id,
      pendingAnswer: null,
      token: services.vault.token(),
      selectedPostId: null,
      selectionInboxId: null,
      navigationUrl: null,
      selectedUntil: 0,
      ageInboxId: null,
    };
    if (session.status === "completed" || current === null) {
      state = { ...state, turn: null };
      observe("completion", session.items.length);
      const complete = t("complete", {
        prefix,
        identity,
        correct: session.progress.first_pass_correct,
        total: session.items.length,
        required: session.progress.required_correct,
      });
      if (!grant.restricted) {
        await respond(text(complete));
        return;
      }
      // Connection is optional; a failed link mint must not withhold the result.
      let url: string | null = null;
      try {
        url = await study.navigation(sender, session.post_id);
      } catch {
        url = null;
      }
      await respond(
        url === null
          ? text(complete)
          : {
              ...text(`${complete}\n${t("connectOptional")}`),
              buttons: [{ text: t("connectButton"), url }],
            },
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
    await respond({
      ...text(
        t("card", {
          prefix,
          identity,
          total: session.items.length,
          required: session.progress.required_correct,
          resolved: session.lesson.resolved_card_count,
          correct: session.progress.first_pass_correct,
          line: item.presentation.reference_text,
        }),
      ),
      keyboard: { force_reply: true, selective: true },
    });
  };
  try {
    if (state.lastInboxId === inbox.id && state.lastReply !== null) {
      await study.reply(sender, inbox.id, senderId, state.lastReply);
      return;
    }
    const parsed = Schema.decodeUnknownOption(Incoming)(rawMessage);
    const message = parsed._tag === "Some" ? parsed.value : null;
    const command = (message?.text ?? "").trim().replace(/@[A-Za-z0-9_]+(?=\s|$)/u, "");
    if (command === "/help") {
      await respond(text(help));
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
        ageInboxId: null,
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
        ageInboxId: null,
        selectedUntil: services.now() + 15 * 60 * 1000,
      };
      await respond({
        ...text(songs.length ? `${help}\n${t("chooseSong")}` : t("noReadySongs")),
        keyboard: {
          inline_keyboard: songs.map((song, index) => [
            { text: song.title.slice(0, 60), callback_data: `study:${state.token}:${index}` },
          ]),
        },
      });
      return;
    }
    if (callbackData !== undefined && state.selectionInboxId !== inbox.id) {
      const suffix = callbackData.slice(`study:${state.token}:`.length);
      if (suffix === "age" || suffix === "minor") {
        // Only the sender's own unexpired song choice can carry the age answer.
        if (state.selectedPostId === null || services.now() >= state.selectedUntil) {
          await respond(text(t("selectionExpired")));
          return;
        }
        if (suffix === "minor") {
          state = {
            ...state,
            selectedPostId: null,
            selectionInboxId: null,
            navigationUrl: null,
            selectedUntil: 0,
            ageInboxId: null,
            token: services.vault.token(),
          };
          await respond(text(t("under16")));
          return;
        }
        // The token is kept: until a lesson starts, the visible buttons must still work, so
        // a decline sent while this item waits for a retry is honoured, not discarded.
        state = { ...state, ageInboxId: inbox.id, selectionInboxId: inbox.id };
        await persist();
      } else {
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
          ageInboxId: null,
          selectedUntil: services.now() + 15 * 60 * 1000,
          token: services.vault.token(),
        };
        await persist();
      }
    }
    let grant = await study.grant(sender);
    if (!grant) {
      state = { ...state, pendingAnswer: null, turn: null };
      // Only a deliberate lesson start, never /study or a typed command, issues an identity.
      if (
        callbackData === undefined ||
        state.selectedPostId === null ||
        services.now() >= state.selectedUntil
      ) {
        await respond(text(t("chooseFirst")));
        return;
      }
      const enrolled = await study.enroll(activeLease, {
        affirmed: state.ageInboxId === inbox.id,
      });
      if (enrolled === "age_required") {
        observe("age");
        await respond({
          ...text(t("ageQuestion")),
          keyboard: {
            inline_keyboard: [
              [{ text: t("ageYes"), callback_data: `study:${state.token}:age` }],
              [{ text: t("ageNo"), callback_data: `study:${state.token}:minor` }],
            ],
          },
        });
        return;
      }
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
      await showSession(
        session,
        grant.restricted ? `${t("practiceOnly")} ${t("noReferenceAudio")}` : t("noReferenceAudio"),
        grant,
      );
      return;
    }
    if (state.sessionId !== null && (await study.store.expired(state.sessionId))) {
      state = { ...state, sessionId: null, turn: null, pendingAnswer: null };
      await respond(text(t("sessionExpired")));
      return;
    }
    if (command === "/resume" && state.sessionId !== null) {
      await showSession(
        await study.session(activeLease, grant, state.sessionId),
        t("resuming"),
        grant,
      );
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
      const feedback = result.feedback.kind === "transcript_diff" ? result.feedback : null;
      const notes =
        feedback === null
          ? ""
          : [
              t("heard", { answer: feedback.heard_transcript.slice(0, 500) || t("nothingClear") }),
              ...(feedback.missing.length
                ? [
                    t("trySaying", {
                      words: feedback.missing
                        .map((word) => word.token)
                        .join(" ")
                        .slice(0, 300),
                    }),
                  ]
                : []),
              ...(feedback.substituted.length
                ? [
                    t("trySaying", {
                      words: feedback.substituted
                        .map((word) => word.expected.token)
                        .join(" ")
                        .slice(0, 300),
                    }),
                  ]
                : []),
            ].join("\n");
      await showSession(
        result.session,
        [
          result.outcome === "correct"
            ? t("correct")
            : result.outcome === "ungraded_rerecord"
              ? t("rerecord")
              : t("incorrect"),
          notes,
        ]
          .filter(Boolean)
          .join("\n"),
        grant,
      );
      return;
    }
    await respond(text(state.sessionId !== null ? t("voiceRequired") : help));
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
            error instanceof TelegramStudyLeaseExpired
              ? t("gradingTimeout")
              : error instanceof StudyV2CommandRejected && error.reason === "provider-unavailable"
                ? t("gradingUnavailable")
                : t("answerUnavailable"),
            currentGrant,
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
