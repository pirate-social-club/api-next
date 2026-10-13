// Application-owned private bridge. No public export, route or role activation.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { GuestParticipationResultV1, GuestRewardTermsV1, GuestSha256V1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Family = Schema.Literals(["study_legacy", "study_v2", "karaoke"]);
const Producer = Schema.Literals(["legacy_choice", "v2_choice", "v2_spoken", "karaoke"]);
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Owner = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Prepared = Schema.Struct({
  mainOperationId: Id,
  sourceOwnerId: Owner,
  sourceFamily: Family,
  sessionId: Id,
  operationKind: Schema.Literals(["study_answer", "karaoke_finalize"]),
  idempotencyKey: Id,
  requestHash: GuestSha256V1,
  qualificationId: Id,
  accountId: Id,
  communityId: Id,
  producerKind: Producer,
  commandRef: Schema.NullOr(Id),
  state: Schema.Literals(["captured", "completed"]),
  completion: Schema.Unknown,
  holdPresent: Schema.Boolean,
  holdState: Schema.NullOr(
    Schema.Literals(["pending", "admitted", "not_admitted", "reconciled_no_commit"]),
  ),
  attemptFence: Schema.NullOr(GuestSha256V1),
  attemptStarted: Schema.Boolean,
  noAdmission: Schema.NullOr(GuestParticipationResultV1),
}).check(
  Schema.makeFilter((r) =>
    (r.sourceFamily === "karaoke") === (r.operationKind === "karaoke_finalize") &&
    (r.state === "captured") === (r.completion === null) &&
    r.holdPresent === (r.holdState !== null) &&
    (r.holdState === "pending") === (r.attemptFence !== null) &&
    (r.producerKind === "v2_spoken") === (r.commandRef !== null)
      ? undefined
      : "Closed original Account operation required",
  ),
);
export type PreparedAccountOwnerReward = Schema.Schema.Type<typeof Prepared>;
export interface AccountOwnerRewardAction {
  readonly accountId: string;
  readonly communityId: string;
  readonly family: Schema.Schema.Type<typeof Family>;
  readonly sessionId: string;
  readonly producer: Schema.Schema.Type<typeof Producer>;
  readonly payload: unknown;
}
export interface AccountOwnerRewardBirth {
  readonly rewardPreviewTermsHash: string;
  readonly disclosureVersion: string;
  readonly disclosureAccepted: true;
  /** Explicit trusted server configuration, only for NEW birth. */
  readonly purchaseSafetyMarginSeconds: number;
}
const fail = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, raw: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(raw);
const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const Birth = Schema.Struct({
  rewardPreviewTermsHash: GuestSha256V1,
  disclosureVersion: Id,
  disclosureAccepted: Schema.Literal(true),
  purchaseSafetyMarginSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
});
const SessionRewardMetadata = Schema.Struct({
  sessionId: Id,
  accountId: Id,
  communityId: Id,
  postId: Id,
  rewardTerms: GuestRewardTermsV1,
  participation: GuestParticipationResultV1,
}).check(
  Schema.makeFilter((value) =>
    value.participation.state === "practice_only" ||
    value.rewardTerms.community_id !== value.communityId ||
    value.rewardTerms.post_id !== value.postId ||
    (value.participation.state === "admitted" &&
      (value.participation.pool_leg_id !== value.rewardTerms.pool_leg_id ||
        value.participation.original_drawing_id !== value.rewardTerms.original_drawing_id))
      ? "Exact rewarded Account source metadata required"
      : undefined,
  ),
);
export function makeControlPlaneAccountOwnerRewardHooks(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  birth: AccountOwnerRewardBirth | null,
) {
  const query = Effect.fn("accountOwnerRewards.query")(function* (
    label: string,
    text: string,
    values: readonly unknown[],
  ) {
    return yield* boundedLearnerAudioTransaction((tx) =>
      Effect.gen(function* () {
        const r = yield* tx.execute<unknown>({ label, text, values, readonly: false });
        return yield* Effect.try({
          try: () => {
            if (r.rows.length !== 1) throw new Error();
            return decode(Schema.Struct({ result: Schema.Unknown }), r.rows[0]).result;
          },
          catch: () => fail(label),
        });
      }),
    ).pipe(Effect.provide(runtime));
  });
  const birthFields = Effect.fn("accountOwnerRewards.birthFields")(function* () {
    return birth === null
      ? null
      : yield* Effect.try({
          try: () => decode(Birth, birth),
          catch: () => fail("account-owner-rewards.birth"),
        });
  });
  const lockBirth = Effect.fn("accountOwnerRewards.lockBirth")(function* (
    tx: ControlPlaneTransaction,
    accountId: string,
  ) {
    if (birth !== null)
      yield* tx.execute({
        label: "account-owner-rewards.birth-group",
        text: "SELECT lock_account_owner_reward_birth_v1($1)",
        values: [accountId],
        readonly: false,
      });
  });
  const prepare = Effect.fn("accountOwnerRewards.prepare")(function* (
    request: AccountOwnerRewardAction,
  ) {
    const payload = yield* Effect.try({
      try: () => JSON.stringify(request.payload),
      catch: () => fail("account-owner-rewards.payload"),
    });
    const values = [
      request.accountId,
      request.communityId,
      request.family,
      request.sessionId,
      request.producer,
      payload,
    ];
    const execute = (suffix: readonly unknown[]) =>
      query(
        "account-owner-rewards.prepare",
        "SELECT prepare_account_owner_reward_action_v1($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,decode($10,'hex'),$11) AS result",
        [...values, ...suffix],
      );
    // Existing original capture lookup precedes any fresh randomness/config.
    // GP007 is private native proof of no capture; no other failure authorizes NEW.
    const prior = yield* execute([null, null, null, null, null]).pipe(
      Effect.catchTag("ControlPlaneStatementFailed", (error) =>
        error.sqlState === "GP007" &&
        error.outcomeCertainty === "completed" &&
        error.label === "account-owner-rewards.prepare"
          ? Effect.succeed("new" as const)
          : Effect.fail(error),
      ),
    );
    const raw =
      prior === "new"
        ? yield* Effect.gen(function* () {
            const fresh = yield* Effect.try({
              try: () => [
                `account_reward_${crypto.randomUUID()}`,
                `owner_admission_${crypto.randomUUID()}`,
                randomHex(),
                randomHex(),
                null,
              ],
              catch: () => fail("account-owner-rewards.random"),
            });
            return yield* execute(fresh);
          })
        : prior;
    if (raw === null) return null;
    const original = yield* Effect.try({
      try: () => {
        const record = decode(Prepared, raw);
        if (
          record.accountId !== request.accountId ||
          record.communityId !== request.communityId ||
          record.sourceFamily !== request.family ||
          record.sessionId !== request.sessionId ||
          record.producerKind !== request.producer
        )
          throw new Error();
        const submitted = decode(Schema.Record(Schema.String, Schema.Unknown), request.payload);
        if (request.producer !== "karaoke" && record.requestHash !== submitted.requestHash)
          throw new Error();
        if (
          (request.producer === "legacy_choice" || request.producer === "v2_choice") &&
          record.idempotencyKey !== submitted.idempotencyKey
        )
          throw new Error();
        if (request.producer === "v2_spoken" && record.commandRef !== submitted.commandId)
          throw new Error();
        if (request.producer === "karaoke") {
          const authority = decode(
            Schema.Record(Schema.String, Schema.Unknown),
            submitted.authority,
          );
          if (record.idempotencyKey !== `karaoke-finalize:${authority.attemptId}`)
            throw new Error();
        }
        return record;
      },
      catch: () => fail("account-owner-rewards.prepare.correlation"),
    });
    if (original.state === "completed" || !original.holdPresent) return original;
    const freshFence = yield* Effect.try({
      try: randomHex,
      catch: () => fail("account-owner-rewards.random"),
    });
    // A sent-COMMIT unknown at this callback propagates; no owning producer is
    // entered. The next request reconciles under original locks before rearming.
    const started = yield* query(
      "account-owner-rewards.start-attempt",
      "SELECT start_account_owner_reward_attempt_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
      [
        original.mainOperationId,
        original.accountId,
        original.communityId,
        original.sourceFamily,
        original.sessionId,
        original.producerKind,
        original.idempotencyKey,
        original.requestHash,
        original.attemptFence,
        freshFence,
      ],
    );
    return yield* Effect.try({
      try: () => {
        const result = decode(Prepared, started);
        if (
          result.mainOperationId !== original.mainOperationId ||
          result.sourceOwnerId !== original.sourceOwnerId ||
          result.sourceFamily !== original.sourceFamily ||
          result.sessionId !== original.sessionId ||
          result.accountId !== original.accountId ||
          result.communityId !== original.communityId ||
          result.producerKind !== original.producerKind ||
          result.operationKind !== original.operationKind ||
          result.idempotencyKey !== original.idempotencyKey ||
          result.requestHash !== original.requestHash ||
          result.commandRef !== original.commandRef ||
          result.qualificationId !== original.qualificationId ||
          (result.state === "captured" && result.holdState === "pending" && !result.attemptStarted)
        )
          throw new Error();
        return result;
      },
      catch: () => fail("account-owner-rewards.start-attempt.correlation"),
    });
  });
  const enter = Effect.fn("accountOwnerRewards.enter")(function* (
    tx: ControlPlaneTransaction,
    original: PreparedAccountOwnerReward | null,
  ) {
    if (original !== null)
      yield* tx.execute({
        label: "account-owner-rewards.owning-group",
        text: "SELECT enter_account_owner_reward_action_v1($1,$2,$3,$4,$5)",
        values: [
          original.mainOperationId,
          original.accountId,
          original.communityId,
          original.sessionId,
          original.attemptFence,
        ],
        readonly: false,
      });
  });
  const draw = Effect.fn("accountOwnerRewards.draw")(function* (
    tx: ControlPlaneTransaction,
    original: PreparedAccountOwnerReward | null,
  ) {
    if (original !== null && original.state !== "completed")
      yield* tx.execute({
        label: "account-owner-rewards.owning-drawing",
        text: "SELECT lock_account_owner_reward_draw_v1($1,$2)",
        values: [original.mainOperationId, original.attemptFence],
        readonly: false,
      });
  });
  const complete = Effect.fn("accountOwnerRewards.complete")(function* (
    tx: ControlPlaneTransaction,
    original: PreparedAccountOwnerReward | null,
    actual: unknown,
  ) {
    if (original !== null) {
      const actualJson = yield* Effect.try({
        try: () => JSON.stringify(actual),
        catch: () => fail("account-owner-rewards.complete.payload"),
      });
      const r = yield* tx.execute<unknown>({
        label: "account-owner-rewards.complete",
        text: "SELECT complete_account_owner_reward_action_v1($1,$2,$3::jsonb) AS result",
        values: [original.mainOperationId, original.attemptFence, actualJson],
        readonly: false,
      });
      yield* Effect.try({
        try: () => {
          if (r.rows.length !== 1) throw new Error();
          const envelope = decode(Schema.Struct({ result: Schema.Unknown }), r.rows[0]);
          return decode(
            Schema.Struct({ answer: Schema.Unknown, participation: GuestParticipationResultV1 }),
            envelope.result,
          );
        },
        catch: () => fail("account-owner-rewards.complete.result"),
      });
    }
  });
  const project = Effect.fn("accountOwnerRewards.project")(function* (
    accountId: string,
    communityId: string,
    sessionId: string,
  ) {
    const raw = yield* query(
      "account-owner-rewards.project",
      "SELECT read_account_owner_study_reward_v1($1,$2,$3) AS result",
      [accountId, communityId, sessionId],
    );
    return yield* Effect.try({
      try: () => {
        const value = decode(SessionRewardMetadata, raw);
        if (
          value.accountId !== accountId ||
          value.communityId !== communityId ||
          value.sessionId !== sessionId
        )
          throw new Error();
        return value;
      },
      catch: () => fail("account-owner-rewards.project.correlation"),
    });
  });
  const findStart = Effect.fn("accountOwnerRewards.findStart")(function* (
    accountId: string,
    communityId: string,
    postId: string,
    idempotencyKey: string,
  ) {
    const raw = yield* query(
      "account-owner-rewards.start-lookup",
      "SELECT find_account_owner_study_start_v1($1,$2,$3,$4) AS result",
      [accountId, communityId, postId, idempotencyKey],
    );
    return yield* Effect.try({
      try: () => {
        const value = decode(
          Schema.Union([
            Schema.Struct({ state: Schema.Literal("completed"), result: SessionRewardMetadata }),
            Schema.Struct({ state: Schema.Literal("not_started"), result: Schema.Null }),
          ]),
          raw,
        );
        if (
          value.state === "completed" &&
          (value.result.accountId !== accountId ||
            value.result.communityId !== communityId ||
            value.result.postId !== postId)
        )
          throw new Error();
        return value;
      },
      catch: () => fail("account-owner-rewards.start-lookup.correlation"),
    });
  });
  const preview = Effect.fn("accountOwnerRewards.preview")(function* (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly audioRevision: number;
    readonly lyricsRevision: number;
    readonly qualificationPolicyRevision: string;
    readonly disclosureVersion: string;
    /** Process-owned configuration only. Never request/query/header/hash input. */
    readonly purchaseSafetyMarginSeconds: number | null;
  }) {
    if (
      input.purchaseSafetyMarginSeconds === null ||
      !Number.isInteger(input.purchaseSafetyMarginSeconds) ||
      input.purchaseSafetyMarginSeconds < 1 ||
      input.purchaseSafetyMarginSeconds > 86400
    )
      return null;
    const raw = yield* query(
      "account-owner-rewards.preview",
      "SELECT read_account_owner_reward_terms_private_v1($1,$2,'study',$3,$4,$5,$6,$7,$8,$9) AS result",
      [
        input.accountId,
        input.personaId,
        input.communityId,
        input.postId,
        input.audioRevision,
        input.lyricsRevision,
        input.qualificationPolicyRevision,
        input.disclosureVersion,
        input.purchaseSafetyMarginSeconds,
      ],
    );
    if (raw === null) return null;
    return yield* Effect.try({
      try: () => {
        const value = decode(
          Schema.Struct({
            reward_terms: GuestRewardTermsV1,
            reward_preview_terms_hash: GuestSha256V1,
          }),
          raw,
        );
        if (
          value.reward_terms.community_id !== input.communityId ||
          value.reward_terms.post_id !== input.postId ||
          value.reward_terms.audio_revision !== input.audioRevision ||
          value.reward_terms.lyrics_revision !== input.lyricsRevision ||
          value.reward_terms.qualification_policy_version_id !==
            input.qualificationPolicyRevision ||
          value.reward_terms.disclosure_version !== input.disclosureVersion
        )
          throw new Error();
        return value;
      },
      catch: () => fail("account-owner-rewards.preview.correlation"),
    });
  });
  return { birthFields, lockBirth, prepare, enter, draw, complete, project, findStart, preview };
}
export type AccountOwnerRewardHooks = ReturnType<typeof makeControlPlaneAccountOwnerRewardHooks>;

export const withAccountOwnerRewardMutation = Effect.fn("withAccountOwnerRewardMutation")(
  function* <A, E, R>(
    hooks: AccountOwnerRewardHooks | undefined,
    tx: ControlPlaneTransaction,
    original: PreparedAccountOwnerReward | null,
    use: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | ControlPlaneError, R> {
    if (hooks !== undefined) yield* hooks.enter(tx, original);
    const actual = yield* use;
    if (hooks !== undefined) yield* hooks.complete(tx, original, actual);
    return actual;
  },
);
