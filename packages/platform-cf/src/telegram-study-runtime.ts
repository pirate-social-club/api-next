import {
  Clock,
  type ControlPlaneDb,
  type ControlPlaneError,
  IdGen,
  makeStudyV2Service,
} from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import type {
  TelegramStudyGrant,
  TelegramStudyLease,
  TelegramStudyServices,
} from "@pirate/application/telegram-study";
import { Effect, type Layer, Result, Schema } from "effect";
import {
  makeElevenLabsStudyBatchTranscriber,
  makeR2StudyAudioArchive,
  type StudyAudioBucket,
} from "./study-spoken-audio.ts";
import { makeControlPlaneStudyV2Store } from "./study-v2-repository.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { makeControlPlaneTelegramLinkStore } from "./telegram-linking-repository.ts";
import { telegramStudyAdmission } from "./telegram-study-admission.ts";
import { makeTelegramStudyLearnerStore } from "./telegram-study-learner-store.ts";
import { makeTelegramStudyStore } from "./telegram-study-store.ts";

export interface TelegramPracticeBindings {
  readonly TELEGRAM_STUDY_PRACTICE_ENABLED?: string;
  readonly TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID?: string;
  readonly TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON?: string;
  readonly API_NEXT_ENV?: string;
  readonly ELEVENLABS_API_KEY?: string;
  readonly LEARNER_AUDIO?: StudyAudioBucket;
}
const Catalogue = Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(128))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
);
export function makeTelegramStudyServices(
  bindings: TelegramPracticeBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  telegram: TelegramServices,
): TelegramStudyServices | undefined {
  if (bindings.TELEGRAM_STUDY_PRACTICE_ENABLED !== "true") return undefined;
  const communityId = bindings.TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID;
  const apiKey = bindings.ELEVENLABS_API_KEY;
  if (
    bindings.API_NEXT_ENV !== "staging" ||
    !communityId ||
    !bindings.LEARNER_AUDIO ||
    !apiKey ||
    apiKey.trim() !== apiKey
  )
    throw Error(
      "Telegram practice requires staging, an explicit community and Study transcription credentials",
    );
  const postIds = Schema.decodeUnknownSync(Catalogue)(
    JSON.parse(bindings.TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON ?? "[]"),
  );
  if (new Set(postIds).size !== postIds.length)
    throw Error("Telegram practice catalogue has duplicate songs");
  const database = makeTelegramDatabase(runtime);
  const store = makeTelegramStudyStore(database, communityId, postIds);
  const links = makeControlPlaneTelegramLinkStore(runtime);
  const learners = makeTelegramStudyLearnerStore(database, communityId);
  const spoken = {
    transcriber: makeElevenLabsStudyBatchTranscriber({ apiKey }),
    archive: makeR2StudyAudioArchive(bindings.LEARNER_AUDIO),
  };
  const service = (lease: TelegramStudyLease, grant: TelegramStudyGrant) =>
    makeStudyV2Service(
      makeControlPlaneStudyV2Store(runtime, telegramStudyAdmission(lease, grant, postIds)),
      spoken,
    );
  const run = async <A, E>(effect: Effect.Effect<A, E, Clock | IdGen>) => {
    const result = await Effect.runPromise(
      Effect.result(
        effect.pipe(
          Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
          Effect.provideService(IdGen, {
            next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")),
          }),
        ),
      ),
    );
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  };
  return {
    communityId,
    store,
    // An explicit linked-account grant keeps its authority; otherwise practice is restricted.
    grant: async (sender) =>
      (await links.resolveGrant(
        sender.communityId,
        sender.botId,
        sender.epoch,
        sender.telegramUserId,
      )) ?? (await learners.resolve(sender)),
    enroll: (lease, input) => learners.enroll(lease, input.affirmed),
    async navigation(sender, postId) {
      const reference = telegram.vault.token();
      await links.createNavigation({
        referenceHash: await telegram.vault.hash(reference),
        communityId: sender.communityId,
        botId: sender.botId,
        epoch: sender.epoch,
        telegramUserId: sender.telegramUserId,
        postId,
      });
      const url = new URL("/telegram/link", telegram.publicOrigin);
      url.searchParams.set("navigation_reference", reference);
      return url.href;
    },
    start: (lease, grant, postId, key) =>
      run(
        service(lease, grant).startSession({
          accountId: grant.accountId,
          personaId: grant.personaId,
          communityId: lease.sender.communityId,
          postId,
          idempotencyKey: key,
          learnerBand: null,
          targetLanguage: null,
          timezone: "UTC",
        }),
      ),
    session: (lease, grant, sessionId) =>
      run(
        service(lease, grant).getSession({
          accountId: grant.accountId,
          communityId: lease.sender.communityId,
          sessionId,
        }),
      ),
    answer: (lease, grant, input) =>
      run(
        service(lease, grant).submitSpokenAnswer({
          accountId: grant.accountId,
          communityId: lease.sender.communityId,
          sessionId: input.sessionId,
          sessionItemId: input.itemId,
          attemptNumber: input.attemptNumber,
          idempotencyKey: input.key,
          audio: input.audio,
          audioContentType: "audio/ogg",
          audioDurationMs: input.durationMs,
        }),
      ),
    async reply(sender, inboxId, chatId, message) {
      const id = await telegram.vault.hash(`${inboxId}:reply`);
      await telegram.store.enqueueDelivery({
        id,
        communityId: sender.communityId,
        botEpoch: sender.epoch,
        chatId,
        kind: "reply",
        postId: null,
        state: "pending",
        desired: message,
        desiredHash: await telegram.vault.hash(JSON.stringify(message)),
      });
      try {
        await telegram.wake({ kind: "delivery", id });
      } catch {
        /* Durable pending work resumes delivery. */
      }
    },
  };
}
