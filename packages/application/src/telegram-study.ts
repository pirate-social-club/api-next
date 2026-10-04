import type { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";
import { Schema } from "effect";

export const TelegramStudyReply = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
  media: Schema.Null,
  buttons: Schema.Array(Schema.Struct({ text: Schema.String, url: Schema.String })),
  keyboard: Schema.optional(Schema.Unknown),
});
export type TelegramStudyReply = Schema.Schema.Type<typeof TelegramStudyReply>;
export const TelegramStudyState = Schema.Struct({
  token: Schema.String,
  songs: Schema.Array(Schema.Struct({ postId: Schema.String, title: Schema.String })),
  selectedPostId: Schema.NullOr(Schema.String),
  selectionInboxId: Schema.NullOr(Schema.String),
  navigationUrl: Schema.NullOr(Schema.String),
  selectedUntil: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  grantRevision: Schema.NullOr(Schema.Number),
  turn: Schema.NullOr(
    Schema.Struct({
      itemId: Schema.String,
      attemptNumber: Schema.Number,
      deliveryId: Schema.String,
    }),
  ),
  pendingAnswer: Schema.NullOr(
    Schema.Struct({
      inboxId: Schema.String,
      sessionId: Schema.String,
      itemId: Schema.String,
      attemptNumber: Schema.Number,
      fileId: Schema.String,
      durationMs: Schema.Number,
    }),
  ),
  observations: Schema.Array(
    Schema.Struct({
      stage: Schema.Literals([
        "selection",
        "linking",
        "card",
        "completion",
        "cancel",
        "unavailable",
      ]),
      at: Schema.Number,
      card: Schema.NullOr(Schema.Number),
      presentation: Schema.NullOr(Schema.Number),
    }),
  ).check(Schema.isMaxLength(64)),
  lastInboxId: Schema.NullOr(Schema.String),
  lastReply: Schema.NullOr(TelegramStudyReply),
});
export type TelegramStudyState = Schema.Schema.Type<typeof TelegramStudyState>;
export const emptyTelegramStudyState = (): TelegramStudyState => ({
  token: "",
  songs: [],
  selectedPostId: null,
  selectionInboxId: null,
  navigationUrl: null,
  selectedUntil: 0,
  sessionId: null,
  grantRevision: null,
  turn: null,
  pendingAnswer: null,
  observations: [],
  lastInboxId: null,
  lastReply: null,
});
export interface TelegramStudySender {
  readonly communityId: string;
  readonly botId: string;
  readonly epoch: string;
  readonly telegramUserId: string;
}
export interface TelegramStudyGrant {
  readonly accountId: string;
  readonly personaId: string;
  readonly personaLabel?: string;
  readonly revision: number;
}
export interface TelegramStudyLease {
  readonly token: string;
  readonly sender: TelegramStudySender;
  readonly state: TelegramStudyState;
}
export interface TelegramStudyStore {
  claim(sender: TelegramStudySender, token: string): Promise<TelegramStudyLease | null>;
  save(lease: TelegramStudyLease, state: TelegramStudyState): Promise<void>;
  release(lease: TelegramStudyLease): Promise<void>;
  catalogue(communityId: string): Promise<readonly { postId: string; title: string }[]>;
  ready(communityId: string, postId: string): Promise<boolean>;
  promptMessageId(deliveryId: string): Promise<number | null>;
  expired(sessionId: string): Promise<boolean>;
  cleanup(): Promise<void>;
}
export interface TelegramStudyServices {
  readonly communityId: string;
  readonly store: TelegramStudyStore;
  readonly grant: (sender: TelegramStudySender) => Promise<TelegramStudyGrant | null>;
  readonly navigation: (sender: TelegramStudySender, postId: string) => Promise<string>;
  readonly start: (
    lease: TelegramStudyLease,
    grant: TelegramStudyGrant,
    postId: string,
    key: string,
  ) => Promise<StudySessionV2>;
  readonly session: (
    lease: TelegramStudyLease,
    grant: TelegramStudyGrant,
    sessionId: string,
  ) => Promise<StudySessionV2>;
  readonly answer: (
    lease: TelegramStudyLease,
    grant: TelegramStudyGrant,
    input: {
      sessionId: string;
      itemId: string;
      attemptNumber: number;
      key: string;
      audio: Uint8Array;
      durationMs: number;
    },
  ) => Promise<StudyAnswerResultV2>;
  readonly reply: (
    sender: TelegramStudySender,
    inboxId: string,
    chatId: string,
    message: TelegramStudyReply,
  ) => Promise<void>;
}
