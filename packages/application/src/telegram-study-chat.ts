import type { StudySessionV2 } from "@pirate/contracts";
import { boundedTelegramText } from "@pirate/domain/telegram";
import { Schema } from "effect";
import { StudyV2CommandRejected } from "./study-v2-service.ts";
import { telegramBotCredentials } from "./telegram/delivery.ts";
import type { InboxRecord, IntegrationRecord, TelegramServices } from "./telegram/types.ts";
import { TelegramFailure } from "./telegram/types.ts";
import type {
  TelegramStudyReply,
  TelegramStudyServices,
  TelegramStudyState,
} from "./telegram-study.ts";

const Id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
const Incoming = Schema.Struct({
  message_id: Id,
  text: Schema.optional(Schema.String),
  voice: Schema.optional(
    Schema.Struct({
      file_id: Schema.String.check(Schema.isMaxLength(512)),
      duration: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
      file_size: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5242880 })),
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
const help =
  "Use /study to choose a ready song, /resume to continue, and /cancel to stop. Practice only: read each line aloud and reply to it with a voice note. Voice answers are required. The community owner can read your messages and listen to your voice notes. Manage your link and persona on Pirate.";

export async function handleTelegramStudyChat(
  services: TelegramServices,
  study: TelegramStudyServices,
  inbox: InboxRecord,
  integration: IntegrationRecord,
  senderId: string,
  rawMessage: unknown,
  callbackData?: string,
): Promise<void> {
  if (!integration.botId) throw new TelegramFailure({ reason: "unavailable" });
  const sender = {
    communityId: inbox.communityId,
    botId: integration.botId,
    epoch: inbox.botEpoch,
    telegramUserId: senderId,
  };
  const lease = await study.store.claim(sender, services.vault.token());
  if (!lease) throw new TelegramFailure({ reason: "unavailable" });
  let state: TelegramStudyState = lease.state;
  const persist = async () => {
    await study.store.save(lease, state);
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
    personaLabel = session.persona_id,
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
      state = { ...state, turn: null };
      observe("completion", session.items.length);
      await respond(
        text(
          `${prefix}\nPersona: ${personaLabel} (${session.persona_id})\nPractice complete. ${session.progress.first_pass_correct}/${session.items.length} correct on the first try; the threshold was ${session.progress.required_correct}. No reward or pool share was earned.`,
        ),
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
        `${prefix}\nPersona: ${personaLabel} (${session.persona_id})\nPractice only. ${session.items.length} cards; ${session.progress.required_correct} first-try correct to meet the threshold.\nProgress: ${session.lesson.resolved_card_count}/${session.items.length}; first-try correct: ${session.progress.first_pass_correct}.\nRead aloud (presentation ${current.presentation_number}):\n${item.presentation.reference_text}\nReply to this message with a voice note. /resume repeats the prompt; /cancel stops.`,
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
        token: services.vault.token(),
      };
      await respond(
        text(
          "Practice stopped. Your Study progress is saved. Use /resume to return within the session lifetime, or /study to choose a song.",
        ),
      );
      return;
    }
    if (
      callbackData !== undefined &&
      state.selectionInboxId !== inbox.id &&
      !callbackData.startsWith(`study:${state.token}:`)
    ) {
      await respond(text("This lesson has ended. Use /study to start again."));
      return;
    }
    if (state.pendingAnswer !== null && state.pendingAnswer.inboxId !== inbox.id)
      throw new TelegramFailure({ reason: "unavailable" });
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
        ...text(
          songs.length
            ? `${help}\nChoose a song:`
            : "No ready practice songs are available here yet. Use /help for help.",
        ),
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
      if (!/^[0-7]$/u.test(suffix) || services.now() >= state.selectedUntil) {
        await respond(text("This song selection has expired. Use /study to choose again."));
        return;
      }
      const song = state.songs[Number(suffix)];
      if (!song || !(await study.store.ready(sender.communityId, song.postId))) {
        await respond(text("This song is not ready for practice. Use /study to choose another."));
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
    const grant = await study.grant(sender);
    if (!grant) {
      if (state.selectedPostId !== null && services.now() < state.selectedUntil) {
        observe("linking");
        const url = state.navigationUrl ?? (await study.navigation(sender, state.selectedPostId));
        state = { ...state, navigationUrl: url };
        await persist();
        await respond({
          ...text(
            "Practice only. Voice answers are required: you will read lines aloud and send voice notes. The community owner can read your messages and listen to them. Link on Pirate, explicitly choose your community persona, then return here and use /resume. Owners of multiple bots can correlate your Telegram identity across them.",
          ),
          buttons: [{ text: "Link with Pirate", url }],
        });
      } else
        await respond(
          text(
            "Use /study to choose a ready song before linking. Manage your Telegram link and community persona on Pirate.",
          ),
        );
      return;
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
        await respond(text("This song selection is unavailable. Use /study to choose again."));
        return;
      }
      const session = await study.start(
        lease,
        grant,
        state.selectedPostId,
        `telegram:${inbox.id}:start`,
      );
      state = { ...state, grantRevision: grant.revision };
      await showSession(
        session,
        "Read-aloud practice; there is no reference audio.",
        grant.personaLabel,
      );
      return;
    }
    if (state.sessionId !== null && (await study.store.expired(state.sessionId))) {
      state = { ...state, sessionId: null, turn: null, pendingAnswer: null };
      await respond(text("This practice session has expired. Use /study to start again."));
      return;
    }
    if (command === "/resume" && state.sessionId !== null) {
      await showSession(
        await study.session(lease, grant, state.sessionId),
        "Resuming saved practice.",
        grant.personaLabel,
      );
      return;
    }
    if (
      state.sessionId !== null &&
      state.turn !== null &&
      (message?.voice !== undefined || state.pendingAnswer?.inboxId === inbox.id)
    ) {
      if (state.pendingAnswer === null) {
        if (
          !message?.voice ||
          message.reply_to_message?.message_id !==
            (await study.store.promptMessageId(state.turn.deliveryId))
        ) {
          await respond(
            text(
              "Reply to the current line with your voice note so it can be graded safely. No attempt was used. Use /resume to show it again.",
            ),
          );
          return;
        }
        state = {
          ...state,
          pendingAnswer: {
            inboxId: inbox.id,
            sessionId: state.sessionId,
            itemId: state.turn.itemId,
            attemptNumber: state.turn.attemptNumber,
            fileId: message.voice.file_id,
            durationMs: message.voice.duration * 1000,
          },
        };
        await persist();
      }
      const pending = state.pendingAnswer;
      if (!pending) throw new TelegramFailure({ reason: "unavailable" });
      const bot = await telegramBotCredentials(services, integration);
      const audio = await services.api.downloadVoice(bot.token, pending.fileId);
      const result = await study.answer(lease, grant, {
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
              `Heard: ${feedback.heard_transcript.slice(0, 500) || "(nothing clear)"}`,
              ...(feedback.missing.length
                ? [
                    `Try saying: ${feedback.missing
                      .map((word) => word.token)
                      .join(" ")
                      .slice(0, 300)}`,
                  ]
                : []),
              ...(feedback.substituted.length
                ? [
                    `Try saying: ${feedback.substituted
                      .map((word) => word.expected.token)
                      .join(" ")
                      .slice(0, 300)}`,
                  ]
                : []),
            ].join("\n");
      await showSession(
        result.session,
        [
          result.outcome === "correct"
            ? "Correct."
            : result.outcome === "ungraded_rerecord"
              ? "Record this line again. No attempt was used."
              : "This presentation was incorrect. Continue with the line shown below.",
          notes,
        ]
          .filter(Boolean)
          .join("\n"),
        grant.personaLabel,
      );
      return;
    }
    await respond(
      text(
        state.sessionId !== null
          ? "This read-aloud lesson requires a voice note replying to the current line. Typed text does not use an attempt. Use /resume or /cancel."
          : help,
      ),
    );
  } catch (error) {
    if (error instanceof StudyV2CommandRejected && error.reason === "provider-unavailable") {
      state = { ...state, pendingAnswer: null };
      observe("unavailable");
      await respond(
        text(
          "Voice grading is temporarily unavailable. No attempt was used. Use /resume and send a new voice note replying to the line.",
        ),
      );
    } else if (error instanceof StudyV2CommandRejected && error.reason === "not-found") {
      state = { ...state, turn: null, pendingAnswer: null };
      await respond(
        text(
          "This lesson or its authorization is unavailable. Check your link and persona on Pirate, then use /resume or /study.",
        ),
      );
    } else throw error;
  } finally {
    await study.store.release(lease);
  }
}
