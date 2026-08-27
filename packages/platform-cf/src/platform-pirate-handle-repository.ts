import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type PlatformPirateAvailabilityStoreOutcome,
  type PlatformPirateHandleStore,
  type PlatformPirateRenameStoreOutcome,
} from "@pirate/application";
import { RenamePlatformPirateHandleResultV1 } from "@pirate/contracts";
import {
  isGeneratedPlatformPiratePlaceholderV1,
  platformPirateHandleStateV1Hash,
  platformPirateRenameTransitionV1Hash,
} from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};

const integer = (row: Row, key: string): number => {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${key}`);
  return value;
};

const bool = (row: Row, key: string): boolean => {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`invalid ${key}`);
  return value;
};

const parseStoredResponse = (value: unknown) =>
  Schema.decodeUnknownSync(RenamePlatformPirateHandleResultV1)(
    typeof value === "string" ? JSON.parse(value) : value,
  );

const retryAfter = (row: Row): number => Math.max(1, integer(row, "retry_after_seconds"));

const rateOutcome = Effect.fn("PlatformPirateHandle.rateOutcome")(function* (
  transaction: ControlPlaneTransaction,
  input: { accountId: string; operation: "availability" | "rename" },
) {
  const window = input.operation === "availability" ? "10 minutes" : "24 hours";
  const limit = input.operation === "availability" ? 20 : 5;
  yield* transaction.execute({
    label: "platform-pirate-handles.rate.lock",
    text: `SELECT pg_advisory_xact_lock(
             hashtextextended('platform-pirate-rate:' || $1 || ':' || $2, 0)
           )`,
    values: [input.accountId, input.operation],
    readonly: false,
  });
  const counted = yield* transaction.execute<Row>({
    label: "platform-pirate-handles.rate.count",
    text: `SELECT count(*)::bigint AS submission_count,
                  CASE WHEN count(*) >= $3 THEN
                    GREATEST(
                      1,
                      ceil(extract(epoch FROM (
                        min(submitted_at) + $4::interval - clock_timestamp()
                      )))::bigint
                    )
                  ELSE 0 END AS retry_after_seconds
             FROM platform_pirate_handle_rate_submissions
            WHERE actor_account_id=$1
              AND operation=$2
              AND submitted_at > clock_timestamp() - $4::interval`,
    values: [input.accountId, input.operation, limit, window],
    readonly: false,
  });
  const row = counted.rows[0];
  if (row === undefined) throw new Error("missing rate outcome");
  if (integer(row, "submission_count") >= limit) return retryAfter(row);
  yield* transaction.execute({
    label: "platform-pirate-handles.rate.consume",
    text: `INSERT INTO platform_pirate_handle_rate_submissions (
             actor_account_id, operation, submitted_at
           ) VALUES ($1, $2, clock_timestamp())`,
    values: [input.accountId, input.operation],
    readonly: false,
  });
  return null;
});

const collisionQuery = (input: {
  accountId: string;
  platformHandleId: string;
  desiredLabel: string;
  confusabilityKey: string;
}) =>
  ({
    label: "platform-pirate-handles.collision.read",
    text: `SELECT EXISTS (
           SELECT 1 FROM public_handle_index AS used
            WHERE used.label_normalized=$1
               OR used.confusability_key=$2 COLLATE "C"
         ) OR EXISTS (
           SELECT 1
             FROM platform_pirate_label_policy_revisions AS policy,
                  unnest(policy.exact_labels) AS reserved(label)
            WHERE policy.label_policy_revision=1
              AND (
                reserved.label=$1
                OR translate(replace(reserved.label, '-', ''), '013457', 'oleast')=$2
              )
         ) OR EXISTS (
           SELECT 1
             FROM platform_pirate_label_policy_revisions AS policy,
                  unnest(policy.reserved_prefixes) AS reserved(prefix)
            WHERE policy.label_policy_revision=1
              AND $1 LIKE reserved.prefix || '%'
         ) AS unavailable`,
    values: [input.desiredLabel, input.confusabilityKey],
    readonly: false,
  }) as const;

export function makeControlPlanePlatformPirateHandleRepository() {
  const checkAvailability = (
    input: Parameters<PlatformPirateHandleStore["checkAvailability"]>[0],
  ) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const limited = yield* rateOutcome(transaction, {
            accountId: input.accountId,
            operation: "availability",
          });
          if (limited !== null) {
            return {
              kind: "rate_limited",
              retryAfterSeconds: limited,
            } satisfies PlatformPirateAvailabilityStoreOutcome;
          }
          const owned = yield* transaction.execute<Row>({
            label: "platform-pirate-handles.availability.authorize",
            text: `SELECT active.label_normalized
                     FROM platform_pirate_handles AS stable
                     JOIN personas AS persona
                       ON persona.persona_id=stable.owner_persona_id
                      AND persona.account_id=stable.actor_account_id
                     JOIN public_handle_index AS active
                       ON active.handle_id=stable.active_handle_id
                      AND active.platform_handle_id=stable.platform_handle_id
                      AND active.status='active'
                    WHERE stable.actor_account_id=$1
                      AND stable.owner_persona_id=$2
                      AND stable.platform_handle_id=$3
                      AND persona.status='active'`,
            values: [input.accountId, input.personaId, input.platformHandleId],
            readonly: false,
          });
          if (owned.rows.length !== 1 || owned.rows[0] === undefined) {
            return { kind: "platform_handle_unavailable" } as const;
          }
          if (text(owned.rows[0], "label_normalized") === input.desiredLabel) {
            return { kind: "current_label" } as const;
          }
          const collision = yield* transaction.execute<Row>(collisionQuery(input));
          if (collision.rows.length !== 1 || collision.rows[0] === undefined) {
            throw new Error("missing collision outcome");
          }
          return bool(collision.rows[0], "unavailable")
            ? ({ kind: "unavailable" } as const)
            : ({ kind: "available" } as const);
        }),
      );
    });

  const rename = (input: Parameters<PlatformPirateHandleStore["rename"]>[0]) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute({
            label: "platform-pirate-handles.rename.replay-lock",
            text: `SELECT pg_advisory_xact_lock(
                     hashtextextended('platform-pirate-rename:' || $1 || ':' || $2, 0)
                   )`,
            values: [input.accountId, input.idempotencyKey],
            readonly: false,
          });
          const replay = yield* transaction.execute<Row>({
            label: "platform-pirate-handles.rename.replay-read",
            text: `SELECT request_hash,response_json
                     FROM platform_pirate_handle_rename_actions
                    WHERE actor_account_id=$1
                      AND endpoint_template='/platform-pirate-handles/rename'
                      AND idempotency_key=$2`,
            values: [input.accountId, input.idempotencyKey],
            readonly: false,
          });
          if (replay.rows.length === 1 && replay.rows[0] !== undefined) {
            if (text(replay.rows[0], "request_hash") !== input.requestHash) {
              return { kind: "idempotency_conflict" } as const;
            }
            const stored = parseStoredResponse(replay.rows[0].response_json);
            return {
              kind: "replayed",
              handle: stored.handle,
              previous: stored.previous,
            } satisfies PlatformPirateRenameStoreOutcome;
          }
          const limited = yield* rateOutcome(transaction, {
            accountId: input.accountId,
            operation: "rename",
          });
          if (limited !== null) {
            return {
              kind: "rate_limited",
              retryAfterSeconds: limited,
            } satisfies PlatformPirateRenameStoreOutcome;
          }
          yield* transaction.execute({
            label: "platform-pirate-handles.rename.collision-lock",
            text: `SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
                     FROM unnest(ARRAY[
                       'platform-pirate-label:' || $1,
                       'platform-pirate-skeleton:' || $2
                     ]) AS lock_key
                    ORDER BY lock_key COLLATE "C"`,
            values: [input.desiredLabel, input.confusabilityKey],
            readonly: false,
          });
          const current = yield* transaction.execute<Row>({
            label: "platform-pirate-handles.rename.authority-lock",
            text: `SELECT stable.platform_handle_id,
                          stable.actor_account_id,
                          stable.owner_persona_id,
                          stable.generation,
                          stable.cleanup_rename_consumed,
                          active.handle_id,
                          active.label_normalized,
                          persona.status AS persona_status,
                          profile.display_name,
                          profile.avatar_ref
                     FROM platform_pirate_handles AS stable
                     JOIN personas AS persona
                       ON persona.persona_id=stable.owner_persona_id
                      AND persona.account_id=stable.actor_account_id
                     JOIN persona_profiles AS profile
                       ON profile.persona_id=persona.persona_id
                     JOIN public_handle_index AS active
                       ON active.handle_id=stable.active_handle_id
                      AND active.platform_handle_id=stable.platform_handle_id
                      AND active.status='active'
                    WHERE stable.actor_account_id=$1
                      AND stable.owner_persona_id=$2
                      AND stable.platform_handle_id=$3
                    FOR UPDATE OF stable,persona,active`,
            values: [input.accountId, input.personaId, input.platformHandleId],
            readonly: false,
          });
          if (current.rows.length !== 1 || current.rows[0] === undefined) {
            return { kind: "platform_handle_unavailable" } as const;
          }
          const row = current.rows[0];
          if (text(row, "persona_status") !== "active") {
            return { kind: "platform_handle_unavailable" } as const;
          }
          const generation = integer(row, "generation");
          const previousLabel = text(row, "label_normalized");
          const consumed = bool(row, "cleanup_rename_consumed");
          const currentState = platformPirateHandleStateV1Hash({
            platform_handle_id: input.platformHandleId,
            owner_persona_id: input.personaId,
            generation,
            handle_label: previousLabel,
            state: "active",
            cleanup_rename_consumed: consumed,
            redirect_to_label: null,
          });
          if (currentState.sha256 !== input.expectedStateHash) {
            return { kind: "stale_platform_handle" } as const;
          }
          if (consumed || !isGeneratedPlatformPiratePlaceholderV1(previousLabel)) {
            return { kind: "cleanup_rename_unavailable" } as const;
          }
          if (!input.desiredLabelValid) {
            return { kind: "invalid_label" } as const;
          }
          if (previousLabel === input.desiredLabel) {
            return { kind: "handle_unavailable" } as const;
          }
          const collision = yield* transaction.execute<Row>(collisionQuery(input));
          if (
            collision.rows.length !== 1 ||
            collision.rows[0] === undefined ||
            bool(collision.rows[0], "unavailable")
          ) {
            return { kind: "handle_unavailable" } as const;
          }
          const nextGeneration = generation + 1;
          if (!Number.isSafeInteger(nextGeneration)) {
            return { kind: "cleanup_rename_unavailable" } as const;
          }
          const transition = platformPirateRenameTransitionV1Hash({
            platform_handle_id: input.platformHandleId,
            owner_persona_id: input.personaId,
            previous_generation: generation,
            previous_label: previousLabel,
            next_generation: nextGeneration,
            next_label: input.desiredLabel,
            previous_next_state: "redirect",
            previous_redirect_to_label: input.desiredLabel,
            rename_request_hash: input.requestHash,
          });
          const nextHandleId = `${input.platformHandleId}:generation:${nextGeneration}`;
          yield* transaction.execute({
            label: "platform-pirate-handles.rename.trigger-scope",
            text: `SELECT set_config('pirate.platform_handle_rename', 'on', true)`,
            values: [],
            readonly: false,
          });
          const redirected = yield* transaction.execute({
            label: "platform-pirate-handles.rename.redirect-history",
            text: `UPDATE public_handle_index
                      SET status='redirect',
                          redirect_target_handle_id=$2,
                          updated_at=clock_timestamp()
                    WHERE platform_handle_id=$1
                      AND status IN ('active','redirect')`,
            values: [input.platformHandleId, nextHandleId],
            readonly: false,
          });
          if (redirected.rowCount < 1) throw new Error("missing active label transition");
          const inserted = yield* transaction.execute({
            label: "platform-pirate-handles.rename.insert-active",
            text: `INSERT INTO public_handle_index (
                     handle_id,label_normalized,label_display,status,owner_user_id,
                     owner_persona_id,redirect_target_handle_id,platform_handle_id,
                     generation,rename_transition_hash,created_at,updated_at
                   ) VALUES (
                     $1,$2,$2 || '.pirate','active',$3,$4,NULL,$5,$6,$7,
                     clock_timestamp(),clock_timestamp()
                   )`,
            values: [
              nextHandleId,
              input.desiredLabel,
              input.accountId,
              input.personaId,
              input.platformHandleId,
              nextGeneration,
              transition.sha256,
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1) throw new Error("active label insert failed");
          const updatedStable = yield* transaction.execute({
            label: "platform-pirate-handles.rename.advance-stable",
            text: `UPDATE platform_pirate_handles
                      SET generation=$2,
                          active_handle_id=$3,
                          cleanup_rename_consumed=true,
                          updated_at=clock_timestamp()
                    WHERE platform_handle_id=$1
                      AND generation=$4
                      AND NOT cleanup_rename_consumed`,
            values: [input.platformHandleId, nextGeneration, nextHandleId, generation],
            readonly: false,
          });
          if (updatedStable.rowCount !== 1) throw new Error("stable handle advance lost");
          const updatedAccount = yield* transaction.execute({
            label: "platform-pirate-handles.rename.update-account-projection",
            text: `UPDATE users
                      SET account=jsonb_set(
                        jsonb_set(
                          jsonb_set(
                            jsonb_set(
                              jsonb_set(account, '{global_handle,label_normalized}', to_jsonb($2::text), true),
                              '{global_handle,label_display}', to_jsonb($2::text || '.pirate'), true
                            ),
                            '{global_handle,issuance_source}', '"free_cleanup_rename"'::jsonb, true
                          ),
                          '{global_handle,free_rename_consumed}', '1'::jsonb, true
                        ),
                        '{onboarding,cleanup_rename_available}', 'false'::jsonb, true
                      )
                    WHERE user_id=$1`,
            values: [input.accountId, input.desiredLabel],
            readonly: false,
          });
          if (updatedAccount.rowCount !== 1) throw new Error("account projection update failed");
          yield* transaction.execute({
            label: "platform-pirate-handles.rename.advance-public-linkage",
            text: `SELECT advance_handle_persona_public_linkage_v1(
                     $1,
                     clock_timestamp()
                   )`,
            values: [input.personaId],
            readonly: false,
          });
          const handle = {
            platform_handle_id: input.platformHandleId,
            owner_persona: {
              persona_id: input.personaId,
              object: "persona" as const,
              display_name: nullableText(row, "display_name"),
              avatar_ref: nullableText(row, "avatar_ref"),
              primary_public_handle: `${input.desiredLabel}.pirate`,
            },
            handle_label: input.desiredLabel,
            display_identifier: `${input.desiredLabel}.pirate`,
            generation: nextGeneration,
            state: "active" as const,
            state_hash: platformPirateHandleStateV1Hash({
              platform_handle_id: input.platformHandleId,
              owner_persona_id: input.personaId,
              generation: nextGeneration,
              handle_label: input.desiredLabel,
              state: "active",
              cleanup_rename_consumed: true,
              redirect_to_label: null,
            }).sha256,
            cleanup_rename_available: false,
          };
          const previous = {
            platform_handle_id: input.platformHandleId,
            handle_label: previousLabel,
            display_identifier: `${previousLabel}.pirate`,
            generation,
            state: "redirect" as const,
            redirect_to_label: input.desiredLabel,
          };
          const stored = { handle, previous, replayed: false };
          const action = yield* transaction.execute({
            label: "platform-pirate-handles.rename.store-replay",
            text: `INSERT INTO platform_pirate_handle_rename_actions (
                     actor_account_id,idempotency_key,request_hash,platform_handle_id,
                     owner_persona_id,response_json,transition_hash,committed_at
                   ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,clock_timestamp())`,
            values: [
              input.accountId,
              input.idempotencyKey,
              input.requestHash,
              input.platformHandleId,
              input.personaId,
              JSON.stringify(stored),
              transition.sha256,
            ],
            readonly: false,
          });
          if (action.rowCount !== 1) throw new Error("rename replay insert failed");
          return { kind: "renamed", handle, previous } satisfies PlatformPirateRenameStoreOutcome;
        }),
      );
    });

  return { checkAvailability, rename };
}

export function makeControlPlanePlatformPirateHandleStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): PlatformPirateHandleStore {
  const repository = makeControlPlanePlatformPirateHandleRepository();
  return {
    checkAvailability: (input) => Effect.provide(runtime)(repository.checkAvailability(input)),
    rename: (input) => Effect.provide(runtime)(repository.rename(input)),
  };
}
