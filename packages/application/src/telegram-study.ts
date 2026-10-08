import type { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";
import { Schema } from "effect";
import { StudyV2CommandRejected } from "./study-v2-service.ts";

/** Internal admission distinction; the shared Study error vocabulary stays unchanged. */
export class TelegramStudyLeaseExpired extends StudyV2CommandRejected {
  constructor() {
    super({ reason: "not-found" });
  }
}

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
  /** The inbox item whose explicit chat action affirmed the learner is 16 or older. */
  ageInboxId: Schema.optional(Schema.NullOr(Schema.String)),
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
        "age",
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
  ageInboxId: null,
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
  /** Linked grants carry their consent revision; restricted practice identities use zero. */
  readonly revision: number;
  /** Automatic practice-only identity created from bot ingress, never from account login. */
  readonly restricted?: true;
}
/** No account exists and no affirmation was given, or the practice identity cannot be issued. */
export type TelegramStudyEnrollment = TelegramStudyGrant | "age_required" | "unavailable";
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
  /**
   * Issues the sender's restricted practice identity for this community on a deliberate
   * lesson start. A first lesson in a community requires the explicit 16-or-older affirmation.
   */
  readonly enroll: (
    lease: TelegramStudyLease,
    input: { readonly affirmed: boolean },
  ) => Promise<TelegramStudyEnrollment>;
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
