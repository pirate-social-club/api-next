import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  PersonaStoreConflict,
  PersonaStoreRateLimited,
  type PersonaStoreService,
  PersonaWalletStoreConflict,
  type PersonaWalletStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type PersonaRow = Readonly<Record<string, unknown>>;

const validId = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && value === value.trim();

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid persona timestamp");
  return date.toISOString();
};

const nullableString = (value: unknown): string | null =>
  value === null
    ? null
    : typeof value === "string"
      ? value
      : (() => {
          throw new Error("invalid nullable persona value");
        })();

const numberValue = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid wallet index");
  return parsed;
};

const personaFromRow = (row: PersonaRow) => {
  const personaId = row.persona_id;
  const status = row.status;
  const revision = numberValue(row.profile_revision);
  if (
    typeof personaId !== "string" ||
    !validId(personaId) ||
    (status !== "active" && status !== "suspended" && status !== "retired")
  ) {
    throw new Error("invalid persona row");
  }
  const walletStatus = row.wallet_status;
  const wallet =
    walletStatus === null
      ? null
      : walletStatus === "active"
        ? {
            chain_account_kind: "evm" as const,
            hd_wallet_index: numberValue(row.hd_wallet_index),
            address:
              nullableString(row.wallet_address) ??
              (() => {
                throw new Error("active wallet address missing");
              })(),
            assigned_at: iso(row.wallet_assigned_at),
          }
        : null;
  const personaStatus = status as "active" | "suspended" | "retired";
  return {
    persona_id: personaId,
    object: "persona" as const,
    status: personaStatus,
    profile: {
      persona_id: personaId,
      object: "persona_profile" as const,
      revision,
      display_name: nullableString(row.display_name),
      avatar_ref: nullableString(row.avatar_ref),
      cover_ref: nullableString(row.cover_ref),
      bio: nullableString(row.bio),
      preferred_locale: nullableString(row.preferred_locale),
      primary_public_handle: nullableString(row.primary_public_handle),
    },
    wallet_set: { evm: wallet },
    created_at: iso(row.created_at),
    retired_at: row.retired_at === null ? null : iso(row.retired_at),
  };
};

const PERSONA_SELECT = `
  SELECT persona.persona_id,
         persona.status,
         persona.created_at,
         persona.retired_at,
         profile.revision AS profile_revision,
         profile.display_name,
         profile.avatar_ref,
         profile.cover_ref,
         profile.bio,
         profile.preferred_locale,
         handle.label_display AS primary_public_handle,
         wallet.status AS wallet_status,
         wallet.hd_wallet_index,
         wallet.address AS wallet_address,
         wallet.assigned_at AS wallet_assigned_at
    FROM personas AS persona
    JOIN persona_profiles AS profile ON profile.persona_id = persona.persona_id
    LEFT JOIN LATERAL (
      SELECT candidate.label_display
        FROM public_handle_index AS candidate
       WHERE candidate.owner_persona_id = persona.persona_id
         AND candidate.status = 'active'
       ORDER BY candidate.updated_at DESC, candidate.handle_id
       LIMIT 1
    ) AS handle ON true
    LEFT JOIN LATERAL (
      SELECT assignment.status,
             assignment.hd_wallet_index,
             assignment.address,
             assignment.assigned_at
        FROM persona_wallet_assignments AS assignment
       WHERE assignment.persona_id = persona.persona_id
         AND assignment.chain_account_kind = 'evm'
         AND assignment.status IN ('pending', 'active')
       LIMIT 1
    ) AS wallet ON true`;

const intentHash = (input: {
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly preferredLocale: string | null;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        display_name: input.displayName,
        bio: input.bio,
        preferred_locale: input.preferredLocale,
      }),
    )
    .digest("hex");

const readPersona = (db: ControlPlaneTransaction, accountId: string, personaId: string) =>
  db.execute<PersonaRow>({
    label: "personas.read-owned",
    text: `${PERSONA_SELECT}
            WHERE persona.account_id = $1 AND persona.persona_id = $2`,
    values: [accountId, personaId],
    readonly: true,
  });

const mapStorageConflict = (
  error: ControlPlaneError | PersonaStoreConflict | PersonaStoreRateLimited,
): PersonaStoreConflict | PersonaStoreRateLimited | ControlPlaneError =>
  error instanceof PersonaStoreConflict
    ? error
    : error instanceof PersonaStoreRateLimited
      ? error
      : error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505"
        ? new PersonaStoreConflict({ reason: "identifier-collision" })
        : error;

export function makeControlPlanePersonaRepository() {
  return {
    listByAccount: (accountId: Parameters<PersonaStoreService["listByAccount"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<PersonaRow>({
          label: "personas.list-owned",
          text: `${PERSONA_SELECT}
                  WHERE persona.account_id = $1
                  ORDER BY persona.created_at, persona.persona_id`,
          values: [accountId],
          readonly: true,
        });
        return yield* Effect.sync(() => result.rows.map(personaFromRow));
      }),

    findOwned: ({ accountId, personaId }: Parameters<PersonaStoreService["findOwned"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* readPersona(db, accountId, personaId);
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* Effect.die("duplicate persona identity");
        return yield* Effect.sync(() => personaFromRow(result.rows[0] as PersonaRow));
      }),

    create: ({
      accountId,
      idempotencyKey,
      intent,
      personaId,
      createdAt,
    }: Parameters<PersonaStoreService["create"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const requestHash = intentHash(intent);
        return yield* db
          .withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute({
                label: "personas.create.lock",
                text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000046))",
                values: [JSON.stringify([accountId, "evm"])],
                readonly: false,
              });
              const replay = yield* transaction.execute<PersonaRow>({
                label: "personas.create.replay",
                text: `SELECT request_hash, persona_id
                       FROM persona_create_actions
                      WHERE account_id = $1
                        AND endpoint_template = '/personas'
                        AND idempotency_key = $2`,
                values: [accountId, idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length === 1) {
                const row = replay.rows[0] as PersonaRow;
                if (row.request_hash !== requestHash || typeof row.persona_id !== "string") {
                  return yield* new PersonaStoreConflict({ reason: "idempotency-mismatch" });
                }
                const existing = yield* transaction.execute<WalletRow>({
                  label: "personas.create.replay-wallet",
                  text: `${walletSelect} FOR UPDATE`,
                  values: [accountId, row.persona_id],
                  readonly: false,
                });
                if (existing.rows.length !== 1)
                  return yield* Effect.die("persona replay wallet is missing");
                return yield* Effect.sync(() => preparationFromRow(existing.rows[0] as WalletRow));
              }
              if (replay.rows.length !== 0) return yield* Effect.die("duplicate persona replay");

              const capacity = yield* transaction.execute<{
                slot_count: string;
                recent_count: string;
                retry_after_seconds: string | null;
              }>({
                label: "personas.create.capacity",
                text: `SELECT count(*)::text AS slot_count,
                              count(*) FILTER (
                                WHERE NOT persona.is_first_persona
                                  AND assignment.created_at > clock_timestamp() - interval '86400 seconds'
                              )::text AS recent_count,
                              CASE WHEN count(*) FILTER (
                                WHERE NOT persona.is_first_persona
                                  AND assignment.created_at > clock_timestamp() - interval '86400 seconds'
                              ) >= 3 THEN ceil(extract(epoch FROM (
                                min(assignment.created_at) FILTER (
                                  WHERE NOT persona.is_first_persona
                                    AND assignment.created_at > clock_timestamp() - interval '86400 seconds'
                                ) + interval '86400 seconds' - clock_timestamp()
                              )))::bigint::text ELSE NULL END AS retry_after_seconds
                         FROM persona_wallet_assignments AS assignment
                         JOIN personas AS persona USING (persona_id)
                        WHERE assignment.account_id=$1
                          AND assignment.chain_account_kind='evm'`,
                values: [accountId],
                readonly: false,
              });
              const capacityRow = capacity.rows[0];
              if (numberValue(capacityRow?.slot_count) >= 10) {
                return yield* new PersonaStoreConflict({ reason: "slot-limit" });
              }
              if (numberValue(capacityRow?.recent_count) >= 3) {
                const retryAfterSeconds = Math.max(
                  1,
                  numberValue(capacityRow?.retry_after_seconds),
                );
                return yield* new PersonaStoreRateLimited({ retryAfterSeconds });
              }

              const next = yield* transaction.execute<{ hd_wallet_index: string }>({
                label: "personas.create.allocate-index",
                text: `SELECT (COALESCE(max(hd_wallet_index), -1) + 1)::text AS hd_wallet_index
                         FROM persona_wallet_assignments
                        WHERE account_id=$1 AND chain_account_kind='evm'`,
                values: [accountId],
                readonly: false,
              });
              const hdWalletIndex = numberValue(next.rows[0]?.hd_wallet_index);

              yield* transaction.execute({
                label: "personas.create.persona",
                text: `INSERT INTO personas (
                       persona_id, account_id, status, is_first_persona,
                       created_at, retired_at
                       ) VALUES ($1,$2,'pending_wallet',false,$3::timestamptz,NULL)`,
                values: [personaId, accountId, createdAt],
                readonly: false,
              });
              yield* transaction.execute({
                label: "personas.create.pending-profile",
                text: `INSERT INTO persona_pending_profiles (
                       persona_id,display_name,avatar_ref,cover_ref,bio,
                       preferred_locale,created_at
                     ) VALUES ($1,$2,NULL,NULL,$3,$4,$5::timestamptz)`,
                values: [
                  personaId,
                  intent.displayName,
                  intent.bio,
                  intent.preferredLocale,
                  createdAt,
                ],
                readonly: false,
              });
              const assignmentId = `persona_wallet_${crypto.randomUUID().replaceAll("-", "")}`;
              yield* transaction.execute({
                label: "personas.create.wallet-reservation",
                text: `INSERT INTO persona_wallet_assignments (
                         assignment_id,persona_id,account_id,chain_account_kind,
                         privy_wallet_id,hd_wallet_index,address,status,
                         reservation_idempotency_key,assigned_at,tombstoned_at,
                         created_at,updated_at
                       ) VALUES ($1,$2,$3,'evm',NULL,$4,NULL,'pending',$5,NULL,NULL,
                                 clock_timestamp(),clock_timestamp())`,
                values: [assignmentId, personaId, accountId, hdWalletIndex, idempotencyKey],
                readonly: false,
              });
              yield* transaction.execute({
                label: "personas.create.action",
                text: `INSERT INTO persona_create_actions (
                       account_id,endpoint_template,idempotency_key,request_hash,
                       persona_id,created_at
                     ) VALUES ($1,'/personas',$2,$3,$4,$5::timestamptz)`,
                values: [accountId, idempotencyKey, requestHash, personaId, createdAt],
                readonly: false,
              });
              return {
                persona_id: personaId,
                chain_account_kind: "evm" as const,
                hd_wallet_index: hdWalletIndex,
                status: "pending" as const,
                assignment: null,
              };
            }),
          )
          .pipe(Effect.mapError(mapStorageConflict));
      }),
  };
}

type WalletRow = Readonly<Record<string, unknown>>;

const preparationFromRow = (row: WalletRow) => {
  const personaId = row.persona_id;
  const status = row.status;
  if (typeof personaId !== "string" || (status !== "pending" && status !== "active")) {
    throw new Error("invalid wallet preparation row");
  }
  const index = numberValue(row.hd_wallet_index);
  return status === "pending"
    ? {
        persona_id: personaId,
        chain_account_kind: "evm" as const,
        hd_wallet_index: index,
        status: "pending" as const,
        assignment: null,
      }
    : {
        persona_id: personaId,
        chain_account_kind: "evm" as const,
        hd_wallet_index: index,
        status: "active" as const,
        assignment: {
          chain_account_kind: "evm" as const,
          hd_wallet_index: index,
          address:
            nullableString(row.address) ??
            (() => {
              throw new Error("active wallet address missing");
            })(),
          assigned_at: iso(row.assigned_at),
        },
      };
};

const walletConflict = (
  error: ControlPlaneError | PersonaWalletStoreConflict,
): PersonaWalletStoreConflict | ControlPlaneError => {
  if (error instanceof PersonaWalletStoreConflict) return error;
  if (error._tag !== "ControlPlaneStatementFailed" || error.sqlState !== "23505") return error;
  if (error.constraint === "persona_wallet_assignments_address_uidx") {
    return new PersonaWalletStoreConflict({ reason: "wallet-address-collision" });
  }
  if (error.constraint === "persona_wallet_assignments_index_ledger_unique") {
    return new PersonaWalletStoreConflict({ reason: "wallet-index-collision" });
  }
  return new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
};

const walletSelect = `SELECT persona_id,status,hd_wallet_index,address,assigned_at,
                             privy_wallet_id,reservation_idempotency_key
                        FROM persona_wallet_assignments
                       WHERE account_id=$1 AND persona_id=$2
                         AND chain_account_kind='evm'
                         AND status IN ('pending','active')`;

export function makeControlPlanePersonaWalletRepository() {
  const personas = makeControlPlanePersonaRepository();
  return {
    findOwned: personas.findOwned,

    getEvmPreparation: ({
      accountId,
      personaId,
    }: Parameters<PersonaWalletStoreService["getEvmPreparation"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<WalletRow>({
          label: "persona-wallets.read-live",
          text: walletSelect,
          values: [accountId, personaId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* Effect.die("duplicate live persona wallet");
        return yield* Effect.sync(() => preparationFromRow(result.rows[0] as WalletRow));
      }),

    reserveEvm: ({
      accountId,
      personaId,
      idempotencyKey,
    }: Parameters<PersonaWalletStoreService["reserveEvm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db
          .withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute({
                label: "persona-wallets.reserve.lock",
                text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000046))",
                values: [JSON.stringify([accountId, "evm"])],
                readonly: false,
              });
              const owned = yield* transaction.execute({
                label: "persona-wallets.reserve.authority",
                text: `SELECT 1 FROM personas
                      WHERE account_id=$1 AND persona_id=$2
                        AND status IN ('pending_wallet','active')
                      FOR UPDATE`,
                values: [accountId, personaId],
                readonly: false,
              });
              if (owned.rows.length !== 1) {
                return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
              }
              const replay = yield* transaction.execute<{ persona_id: string }>({
                label: "persona-wallets.reserve.replay-key",
                text: `SELECT persona_id FROM persona_wallet_preparation_replays
                        WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
                values: [accountId, idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length === 1 && replay.rows[0]?.persona_id !== personaId) {
                return yield* new PersonaWalletStoreConflict({ reason: "idempotency-mismatch" });
              }
              if (replay.rows.length > 1) return yield* Effect.die("duplicate wallet replay");
              const existing = yield* transaction.execute<WalletRow>({
                label: "persona-wallets.reserve.replay",
                text: `${walletSelect} FOR UPDATE`,
                values: [accountId, personaId],
                readonly: false,
              });
              if (existing.rows.length === 1) {
                const row = existing.rows[0] as WalletRow;
                if (replay.rows.length === 0) {
                  yield* transaction.execute({
                    label: "persona-wallets.reserve.record-replay",
                    text: `INSERT INTO persona_wallet_preparation_replays (
                             account_id,idempotency_key,persona_id
                           ) VALUES ($1,$2,$3)`,
                    values: [accountId, idempotencyKey, personaId],
                    readonly: false,
                  });
                }
                return yield* Effect.sync(() => preparationFromRow(row));
              }
              if (existing.rows.length !== 0)
                return yield* Effect.die("duplicate live persona wallet");
              return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
            }),
          )
          .pipe(Effect.mapError(walletConflict));
      }),

    retire: ({
      accountId,
      personaId,
      idempotencyKey,
    }: Parameters<PersonaWalletStoreService["retire"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db
          .withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute({
                label: "personas.retire.lock",
                text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000046))",
                values: [JSON.stringify([accountId, "evm"])],
                readonly: false,
              });
              const replay = yield* transaction.execute<{
                persona_id: string;
                retired_at: Date | string;
              }>({
                label: "personas.retire.replay",
                text: `SELECT persona_id,retired_at FROM persona_retirement_replays
                        WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
                values: [accountId, idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length === 1) {
                const row = replay.rows[0];
                if (row?.persona_id !== personaId) {
                  return yield* new PersonaWalletStoreConflict({ reason: "idempotency-mismatch" });
                }
                return {
                  persona_id: personaId,
                  status: "retired" as const,
                  retired_at: iso(row.retired_at),
                };
              }
              if (replay.rows.length !== 0) return yield* Effect.die("duplicate retirement replay");

              const owned = yield* transaction.execute<{
                status: string;
                retired_at: Date | string | null;
                is_first_persona: boolean;
              }>({
                label: "personas.retire.authority",
                text: `SELECT status,retired_at,is_first_persona FROM personas
                        WHERE account_id=$1 AND persona_id=$2 FOR UPDATE`,
                values: [accountId, personaId],
                readonly: false,
              });
              if (owned.rows.length === 0) return null;
              if (owned.rows.length !== 1) return yield* Effect.die("duplicate owned persona");
              const existing = owned.rows[0];
              if (existing?.is_first_persona === true) {
                return yield* new PersonaWalletStoreConflict({
                  reason: "first-persona-required",
                });
              }
              let retiredAt = existing?.retired_at;
              if (existing?.status !== "retired") {
                const tombstoned = yield* transaction.execute({
                  label: "personas.retire.tombstone-wallet",
                  text: `UPDATE persona_wallet_assignments
                            SET status='tombstoned',tombstoned_at=clock_timestamp(),
                                updated_at=clock_timestamp()
                          WHERE account_id=$1 AND persona_id=$2
                            AND chain_account_kind='evm' AND status IN ('pending','active')`,
                  values: [accountId, personaId],
                  readonly: false,
                });
                if (tombstoned.rowCount !== 1) {
                  return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
                }
                const retired = yield* transaction.execute<{ retired_at: Date | string }>({
                  label: "personas.retire.commit",
                  text: `UPDATE personas SET status='retired',retired_at=clock_timestamp()
                          WHERE account_id=$1 AND persona_id=$2
                          RETURNING retired_at`,
                  values: [accountId, personaId],
                  readonly: false,
                });
                retiredAt = retired.rows[0]?.retired_at ?? null;
              }
              if (retiredAt === null || retiredAt === undefined) {
                return yield* Effect.die("retired persona timestamp missing");
              }
              yield* transaction.execute({
                label: "personas.retire.record-replay",
                text: `INSERT INTO persona_retirement_replays (
                         account_id,idempotency_key,persona_id,retired_at
                       ) VALUES ($1,$2,$3,$4::timestamptz)`,
                values: [accountId, idempotencyKey, personaId, iso(retiredAt)],
                readonly: false,
              });
              return {
                persona_id: personaId,
                status: "retired" as const,
                retired_at: iso(retiredAt),
              };
            }),
          )
          .pipe(Effect.mapError(walletConflict));
      }),

    confirmEvm: ({
      accountId,
      personaId,
      attestation,
    }: Parameters<PersonaWalletStoreService["confirmEvm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db
          .withTransaction((transaction) =>
            Effect.gen(function* () {
              const owned = yield* transaction.execute<{
                status: string;
                is_first_persona: boolean;
              }>({
                label: "persona-wallets.confirm.authority",
                text: `SELECT status,is_first_persona FROM personas
                      WHERE account_id=$1 AND persona_id=$2
                        AND status IN ('pending_wallet','active')
                      FOR UPDATE`,
                values: [accountId, personaId],
                readonly: false,
              });
              if (owned.rows.length !== 1) {
                return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
              }
              const existing = yield* transaction.execute<WalletRow>({
                label: "persona-wallets.confirm.read",
                text: `${walletSelect} FOR UPDATE`,
                values: [accountId, personaId],
                readonly: false,
              });
              if (existing.rows.length !== 1) {
                return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
              }
              const row = existing.rows[0] as WalletRow;
              if (numberValue(row.hd_wallet_index) !== attestation.hdWalletIndex) {
                return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
              }
              if (row.status === "active") {
                if (
                  row.address !== attestation.address ||
                  row.privy_wallet_id !== attestation.privyWalletId
                ) {
                  return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
                }
                const preparation = preparationFromRow(row);
                if (preparation.assignment === null)
                  return yield* Effect.die("active wallet assignment is missing");
                return preparation.assignment;
              }
              const confirmed = yield* transaction.execute<WalletRow>({
                label: "persona-wallets.confirm.commit",
                text: `UPDATE persona_wallet_assignments
                        SET privy_wallet_id=$3,address=$4,status='active',
                            assigned_at=clock_timestamp(),updated_at=clock_timestamp()
                      WHERE account_id=$1 AND persona_id=$2
                        AND chain_account_kind='evm' AND status='pending'
                      RETURNING persona_id,status,hd_wallet_index,address,assigned_at,
                                privy_wallet_id,reservation_idempotency_key`,
                values: [accountId, personaId, attestation.privyWalletId, attestation.address],
                readonly: false,
              });
              if (confirmed.rows.length !== 1) {
                return yield* new PersonaWalletStoreConflict({ reason: "reservation-mismatch" });
              }
              const preparation = preparationFromRow(confirmed.rows[0] as WalletRow);
              if (preparation.assignment === null)
                return yield* Effect.die("confirmed wallet assignment is missing");
              const personaState = owned.rows[0];
              if (personaState?.status === "pending_wallet") {
                yield* transaction.execute({
                  label: "persona-wallets.confirm.profile",
                  text: `INSERT INTO persona_profiles (
                           persona_id,revision,display_name,avatar_ref,cover_ref,bio,
                           preferred_locale,created_at,updated_at
                         ) SELECT persona_id,1,display_name,avatar_ref,cover_ref,bio,
                                  preferred_locale,created_at,clock_timestamp()
                             FROM persona_pending_profiles WHERE persona_id=$1`,
                  values: [personaId],
                  readonly: false,
                });
                if (personaState.is_first_persona) {
                  yield* transaction.execute({
                    label: "persona-wallets.confirm.first-handle",
                    text: `INSERT INTO public_handle_index (
                             handle_id,label_normalized,label_display,status,
                             owner_user_id,owner_persona_id,redirect_target_handle_id
                           ) SELECT handle_id,label_normalized,label_display,'active',$2,$1,NULL
                               FROM persona_pending_first_handles WHERE persona_id=$1`,
                    values: [personaId, accountId],
                    readonly: false,
                  });
                }
                yield* transaction.execute({
                  label: "persona-wallets.confirm.activate",
                  text: "UPDATE personas SET status='active' WHERE persona_id=$1 AND account_id=$2 AND status='pending_wallet'",
                  values: [personaId, accountId],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "persona-wallets.confirm.clear-handle-draft",
                  text: "DELETE FROM persona_pending_first_handles WHERE persona_id=$1",
                  values: [personaId],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "persona-wallets.confirm.clear-profile-draft",
                  text: "DELETE FROM persona_pending_profiles WHERE persona_id=$1",
                  values: [personaId],
                  readonly: false,
                });
              }
              return preparation.assignment;
            }),
          )
          .pipe(Effect.mapError(walletConflict));
      }),
  };
}

const bind = <A, E>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  effect: Effect.Effect<A, E, ControlPlaneDb>,
): Effect.Effect<A, E | ControlPlaneError> => Effect.provide(runtime)(effect);

export function makeControlPlanePersonaStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): PersonaStoreService {
  const repository = makeControlPlanePersonaRepository();
  return {
    listByAccount: (accountId) => bind(runtime, repository.listByAccount(accountId)),
    findOwned: (input) => bind(runtime, repository.findOwned(input)),
    create: (input) => bind(runtime, repository.create(input)),
  };
}

export function makeControlPlanePersonaWalletStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): PersonaWalletStoreService {
  const repository = makeControlPlanePersonaWalletRepository();
  return {
    findOwned: (input) => bind(runtime, repository.findOwned(input)),
    reserveEvm: (input) => bind(runtime, repository.reserveEvm(input)),
    getEvmPreparation: (input) => bind(runtime, repository.getEvmPreparation(input)),
    confirmEvm: (input) => bind(runtime, repository.confirmEvm(input)),
    retire: (input) => bind(runtime, repository.retire(input)),
  };
}
