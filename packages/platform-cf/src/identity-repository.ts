import {
  ControlPlaneDb,
  type ControlPlaneError,
  type IdentityRegistrationStore,
  IdentityRegistrationStoreFailure,
  IdentityResolutionError,
  type IdentityStore,
  MAX_CANONICAL_ALIAS_HOPS,
} from "@pirate/application";
import { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import {
  type PrivySessionCredentialStore,
  SessionIdentityRejected,
} from "@pirate/application/use-cases/session-exchange";
import { PersonaEvmWalletPreparationV1 } from "@pirate/contracts";
import { platformPirateHandleStateV1Hash } from "@pirate/domain";
import { Data, Effect, type Layer, Result, Schema } from "effect";

export class IdentityRepositoryError extends Data.TaggedError("IdentityRepositoryError")<{
  readonly reason: "missing" | "deleted" | "cyclic" | "invalid";
}> {}

export type IdentityUser = {
  readonly userId: string;
  /** Account response data is owned by the application contract layer. */
  readonly account: unknown;
};

export type CanonicalIdentity = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly aliasPath: readonly string[];
};

export interface IdentityRepository {
  readonly findUser: (
    userId: string,
  ) => Effect.Effect<IdentityUser | null, ControlPlaneError, ControlPlaneDb>;
  readonly resolveCanonical: (input: {
    readonly sourceUserId: string;
  }) => Effect.Effect<
    CanonicalIdentity,
    ControlPlaneError | IdentityRepositoryError,
    ControlPlaneDb
  >;
  readonly resolveCredentialCanonical: (input: {
    readonly provider: string;
    readonly providerAppId: string;
    readonly providerSubject: string;
  }) => Effect.Effect<
    CanonicalIdentity,
    ControlPlaneError | IdentityRepositoryError,
    ControlPlaneDb
  >;
  readonly upsertAccount: (input: {
    readonly userId: string;
    readonly account: unknown;
  }) => Effect.Effect<void, ControlPlaneError | IdentityRepositoryError, ControlPlaneDb>;
  readonly registerCredential: (
    input: IdentityRegistrationInput,
  ) => Effect.Effect<
    IdentityRegistrationOutcome,
    ControlPlaneError | IdentityRepositoryError,
    ControlPlaneDb
  >;
}

export type IdentityRegistrationInput = {
  readonly provider: "privy";
  readonly providerAppId: string;
  readonly providerSubject: string;
  readonly minimumAgeAttestation: {
    readonly version: "minimum-age-attestation-v1";
    readonly minimum_age: 16;
    readonly affirmed: true;
  };
  readonly credentialId: string;
  readonly userId: string;
  readonly account: unknown;
};

export type IdentityRegistrationOutcome =
  | {
      readonly kind: "created";
      readonly canonicalUserId: string;
      readonly account: IdentityAccountDocument;
    }
  | {
      readonly kind: "already_registered";
      readonly canonicalUserId: string;
      readonly account: IdentityAccountDocument;
    }
  | { readonly kind: "tombstoned" }
  | {
      readonly kind: "candidate_collision";
      readonly field: "credential_id" | "user_id" | "handle";
    };

type ExistingCredentialOutcome = Exclude<
  IdentityRegistrationOutcome,
  { readonly kind: "candidate_collision" }
>;

type UserRow = {
  readonly user_id: unknown;
  readonly account: unknown;
  readonly platform_handle_id: unknown;
  readonly owner_persona_id: unknown;
  readonly generation: unknown;
  readonly cleanup_rename_consumed: unknown;
  readonly label_normalized: unknown;
};

type AliasRow = {
  readonly source_user_id: unknown;
  readonly canonical_user_id: unknown;
  readonly kind: unknown;
  readonly status: unknown;
};

type CredentialRow = {
  readonly canonical_user_id: unknown;
  readonly status: unknown;
  readonly user_status: unknown;
  readonly account: unknown;
};

type SessionCredentialRow = {
  readonly canonical_user_id: unknown;
  readonly status: unknown;
};

class IdentityRegistrationRace extends Data.TaggedError("IdentityRegistrationRace")<{
  readonly reason: "provider_subject" | "credential_id" | "user_id" | "handle";
}> {}

const validId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

const invalid = (): IdentityRepositoryError => new IdentityRepositoryError({ reason: "invalid" });

const missing = (deleted = false): IdentityRepositoryError =>
  new IdentityRepositoryError({ reason: deleted ? "deleted" : "missing" });

const enrichPlatformPirateHandle = (row: UserRow): unknown => {
  if (
    typeof row.platform_handle_id !== "string" ||
    typeof row.owner_persona_id !== "string" ||
    typeof row.label_normalized !== "string" ||
    typeof row.cleanup_rename_consumed !== "boolean"
  ) {
    return row.account;
  }
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) return row.account;

  try {
    const document = Schema.decodeUnknownSync(IdentityAccountDocument)(row.account);
    if (
      document.global_handle.global_handle_id !== row.platform_handle_id ||
      document.global_handle.label_display !== `${row.label_normalized}.pirate`
    ) {
      return row.account;
    }
    const stateHash = platformPirateHandleStateV1Hash({
      platform_handle_id: row.platform_handle_id,
      owner_persona_id: row.owner_persona_id,
      generation,
      handle_label: row.label_normalized,
      state: "active",
      cleanup_rename_consumed: row.cleanup_rename_consumed,
      redirect_to_label: null,
    }).sha256;
    return {
      ...document,
      global_handle: {
        ...document.global_handle,
        platform_handle_id: row.platform_handle_id,
        owner_persona_id: row.owner_persona_id,
        generation,
        state_hash: stateHash,
        cleanup_rename_available: !row.cleanup_rename_consumed,
      },
    };
  } catch {
    return row.account;
  }
};

const credentialOutcome = (
  row: CredentialRow | undefined,
): Effect.Effect<ExistingCredentialOutcome, IdentityRepositoryError> => {
  if (row === undefined || typeof row.canonical_user_id !== "string") {
    return Effect.fail(invalid());
  }
  if (row.status === "tombstoned") return Effect.succeed({ kind: "tombstoned" });
  if (row.status !== "active" || row.user_status !== "active" || !validId(row.canonical_user_id)) {
    return Effect.fail(invalid());
  }
  return Effect.try({
    try: () => Schema.decodeUnknownSync(IdentityAccountDocument)(row.account),
    catch: () => invalid(),
  }).pipe(
    Effect.flatMap((account) =>
      account.user.user_id !== row.canonical_user_id
        ? Effect.fail(invalid())
        : Effect.succeed({
            kind: "already_registered" as const,
            canonicalUserId: row.canonical_user_id,
            account,
          }),
    ),
  );
};

const persistedPirateLabel = (
  value: string,
): { readonly normalized: string; readonly display: string } | null => {
  if (
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 0x20 ||
        character.charCodeAt(0) === 0x7f ||
        character.charCodeAt(0) > 0x7f,
    )
  ) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.endsWith(".pirate")) return null;
  const stem = normalized.slice(0, -".pirate".length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stem) || stem.length > 32) return null;
  return { normalized: stem, display: `${stem}.pirate` };
};

/**
 * Postgres repository implementation. It only knows the ControlPlaneDb port,
 * so its identity semantics are shared by direct Postgres and Hyperdrive
 * deployments without importing a driver.
 */
export function makeControlPlaneIdentityRepository(): IdentityRepository {
  const findUser: IdentityRepository["findUser"] = (userId) =>
    Effect.gen(function* () {
      if (!validId(userId)) return null;
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<UserRow>({
        label: "identity.users.find-active",
        text: `SELECT account.user_id,account.account,
                      stable.platform_handle_id,stable.owner_persona_id,
                      stable.generation,stable.cleanup_rename_consumed,
                      active.label_normalized
                 FROM users AS account
                 LEFT JOIN platform_pirate_handles AS stable
                   ON stable.actor_account_id=account.user_id
                 LEFT JOIN public_handle_index AS active
                   ON active.handle_id=stable.active_handle_id
                  AND active.platform_handle_id=stable.platform_handle_id
                  AND active.status='active'
                WHERE account.user_id=$1 AND account.status='active'`,
        values: [userId],
        readonly: true,
      });
      const row = result.rows[0];
      if (row === undefined || typeof row.user_id !== "string") return null;
      return { userId: row.user_id, account: enrichPlatformPirateHandle(row) };
    });

  const resolveCanonical: IdentityRepository["resolveCanonical"] = ({ sourceUserId }) =>
    Effect.gen(function* () {
      if (!validId(sourceUserId)) return yield* Effect.fail(invalid());
      const source = yield* findUser(sourceUserId);
      if (source === null) return yield* Effect.fail(missing());

      const visited = new Set<string>();
      const aliasPath: string[] = [];
      let current = source.userId;

      for (let depth = 0; depth < MAX_CANONICAL_ALIAS_HOPS; depth += 1) {
        if (visited.has(current))
          return yield* Effect.fail(new IdentityRepositoryError({ reason: "cyclic" }));
        visited.add(current);

        const db = yield* ControlPlaneDb;
        const aliases = yield* db.execute<AliasRow>({
          label: "identity.aliases.find-active",
          text: `SELECT source_user_id, canonical_user_id, kind, status
                 FROM account_aliases
                 WHERE source_user_id = $1
                   AND ((kind = 'alias' AND status = 'active')
                     OR (kind = 'merge' AND status IN ('finalizing', 'completed')))`
            .replace(/\s+/gu, " ")
            .trim(),
          values: [current],
          readonly: true,
        });
        if (aliases.rows.length === 0) {
          const terminal = yield* findUser(current);
          if (terminal === null) return yield* Effect.fail(missing());
          return { sourceUserId, canonicalUserId: current, aliasPath };
        }
        if (aliases.rows.length !== 1) return yield* Effect.fail(invalid());

        const alias = aliases.rows[0];
        if (
          alias === undefined ||
          typeof alias.source_user_id !== "string" ||
          typeof alias.canonical_user_id !== "string" ||
          !validId(alias.source_user_id) ||
          !validId(alias.canonical_user_id) ||
          (alias.kind !== "alias" && alias.kind !== "merge") ||
          (alias.kind === "alias" && alias.status !== "active") ||
          (alias.kind === "merge" && alias.status !== "finalizing" && alias.status !== "completed")
        ) {
          return yield* Effect.fail(invalid());
        }
        aliasPath.push(current);
        current = alias.canonical_user_id;
      }

      return yield* Effect.fail(new IdentityRepositoryError({ reason: "cyclic" }));
    });

  const resolveCredentialCanonical: IdentityRepository["resolveCredentialCanonical"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.provider) ||
        !validId(input.providerAppId) ||
        !validId(input.providerSubject)
      ) {
        return yield* Effect.fail(invalid());
      }
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<{ canonical_user_id: unknown }>({
        label: "identity.credentials.resolve-canonical",
        text: `SELECT canonical_user_id
                 FROM identity_credentials
                WHERE provider=$1 AND provider_app_id=$2 AND provider_subject=$3
                  AND status='active'`,
        values: [input.provider, input.providerAppId, input.providerSubject],
        readonly: true,
      });
      if (result.rows.length === 0) return yield* Effect.fail(missing());
      const canonicalUserId = result.rows[0]?.canonical_user_id;
      if (result.rows.length !== 1 || typeof canonicalUserId !== "string") {
        return yield* Effect.fail(invalid());
      }
      return yield* resolveCanonical({ sourceUserId: canonicalUserId });
    });

  const upsertAccount: IdentityRepository["upsertAccount"] = ({ userId, account }) =>
    Effect.gen(function* () {
      if (!validId(userId)) return yield* Effect.fail(invalid());
      const document = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(IdentityAccountDocument)(account),
        catch: () => invalid(),
      });
      if (
        document.user.user_id !== userId ||
        document.profile.user_id !== userId ||
        document.profile.global_handle_id !== document.global_handle.global_handle_id ||
        document.global_handle.status !== "active"
      ) {
        return yield* Effect.fail(invalid());
      }
      const label = persistedPirateLabel(document.global_handle.label_display);
      if (label === null || !Number.isFinite(Date.parse(document.user.created_at))) {
        return yield* Effect.fail(invalid());
      }
      const encodedAccount = yield* Effect.try({
        try: () => JSON.stringify(account),
        catch: () => invalid(),
      });
      const db = yield* ControlPlaneDb;
      yield* db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "identity.users.upsert-account",
              text: `INSERT INTO users (user_id, status, account, created_at)
                   VALUES ($1, 'active', $2::jsonb, $3::timestamptz)
                   ON CONFLICT (user_id) DO UPDATE
                     SET status = 'active', account = EXCLUDED.account`,
              values: [userId, encodedAccount, document.user.created_at],
              readonly: false,
            });
            yield* transaction.execute({
              label: "identity.personas.sync-first-profile",
              text: `UPDATE persona_profiles AS profile
                      SET display_name=$2::jsonb #>> '{profile,display_name}',
                          avatar_ref=$2::jsonb #>> '{profile,avatar_ref}',
                          cover_ref=$2::jsonb #>> '{profile,cover_ref}',
                          bio=$2::jsonb #>> '{profile,bio}',
                          preferred_locale=$2::jsonb #>> '{profile,preferred_locale}',
                          revision=profile.revision+1,
                          updated_at=clock_timestamp()
                     FROM personas AS persona
                    WHERE persona.persona_id=profile.persona_id
                      AND persona.account_id=$1
                      AND persona.is_first_persona`,
              values: [userId, encodedAccount],
              readonly: false,
            });
            const currentHandle = yield* transaction.execute({
              label: "identity.public-handles.assert-current",
              text: `SELECT 1
                       FROM platform_pirate_handles AS stable
                       JOIN public_handle_index AS active
                         ON active.handle_id=stable.active_handle_id
                        AND active.platform_handle_id=stable.platform_handle_id
                        AND active.status='active'
                       JOIN personas AS persona
                         ON persona.persona_id=stable.owner_persona_id
                        AND persona.account_id=stable.actor_account_id
                      WHERE stable.actor_account_id=$4
                        AND stable.platform_handle_id=$1
                        AND active.label_normalized=$2
                        AND active.label_display=$3
                        AND persona.status='active'
                        AND persona.is_first_persona`,
              values: [
                document.global_handle.global_handle_id,
                label.normalized,
                label.display,
                userId,
              ],
              readonly: false,
            });
            if (currentHandle.rowCount !== 1) return yield* Effect.fail(invalid());
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ControlPlaneStatementFailed" &&
            error.sqlState === "23505" &&
            error.constraint === "first_persona_handle_reservation_unique"
              ? invalid()
              : error,
          ),
        );
    });

  const registerCredential = Effect.fn("IdentityRepository.registerCredential")(function* (
    input: IdentityRegistrationInput,
  ): Effect.fn.Return<
    IdentityRegistrationOutcome,
    ControlPlaneError | IdentityRepositoryError,
    ControlPlaneDb
  > {
    if (
      input.provider !== "privy" ||
      !validId(input.providerAppId) ||
      !validId(input.providerSubject) ||
      !validId(input.credentialId) ||
      !validId(input.userId)
    ) {
      return yield* Effect.fail(invalid());
    }
    const document = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(IdentityAccountDocument)(input.account),
      catch: () => invalid(),
    });
    if (
      document.user.user_id !== input.userId ||
      document.profile.user_id !== input.userId ||
      document.profile.global_handle_id !== document.global_handle.global_handle_id ||
      document.global_handle.status !== "active"
    ) {
      return yield* Effect.fail(invalid());
    }
    const label = persistedPirateLabel(document.global_handle.label_display);
    if (label === null || !Number.isFinite(Date.parse(document.user.created_at))) {
      return yield* Effect.fail(invalid());
    }
    const encodedAccount = yield* Effect.try({
      try: () => JSON.stringify(document),
      catch: () => invalid(),
    });
    const db = yield* ControlPlaneDb;

    const readCredential = () =>
      db.execute<CredentialRow>({
        label: "identity.credentials.read",
        text: `SELECT credential.canonical_user_id, credential.status,
                        account.status AS user_status, account.account
                 FROM identity_credentials AS credential
                 LEFT JOIN users AS account
                   ON account.user_id = credential.canonical_user_id
                 WHERE credential.provider = $1
                   AND credential.provider_app_id = $2
                   AND credential.provider_subject = $3`,
        values: [input.provider, input.providerAppId, input.providerSubject],
        readonly: true,
      });

    const registrationAttempt: Effect.Effect<
      ExistingCredentialOutcome,
      ControlPlaneError | IdentityRegistrationRace | IdentityRepositoryError
    > = db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const existing = yield* transaction.execute<CredentialRow>({
          label: "identity.registration.lock-credential",
          text: `SELECT credential.canonical_user_id, credential.status,
                          account.status AS user_status, account.account
                   FROM identity_credentials AS credential
                   LEFT JOIN users AS account
                     ON account.user_id = credential.canonical_user_id
                   WHERE credential.provider = $1
                     AND credential.provider_app_id = $2
                     AND credential.provider_subject = $3
                   FOR UPDATE OF credential`,
          values: [input.provider, input.providerAppId, input.providerSubject],
          readonly: false,
        });
        if (existing.rows.length > 1) return yield* Effect.fail(invalid());
        if (existing.rows.length === 1) {
          const outcome = yield* credentialOutcome(existing.rows[0]);
          if (outcome.kind === "already_registered") {
            yield* transaction.execute({
              label: "identity.registration.backfill-minimum-age-attestation",
              text: `INSERT INTO account_minimum_age_attestations
                      (account_id, version, minimum_age, affirmed)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (account_id) DO NOTHING`,
              values: [
                outcome.canonicalUserId,
                input.minimumAgeAttestation.version,
                input.minimumAgeAttestation.minimum_age,
                input.minimumAgeAttestation.affirmed,
              ],
              readonly: false,
            });
          }
          return outcome;
        }

        const handleCollision = yield* transaction.execute({
          label: "identity.registration.check-handle",
          text: `SELECT 1 FROM public_handle_index
                  WHERE handle_id=$1 OR label_normalized=$2
                  LIMIT 1`,
          values: [document.global_handle.global_handle_id, label.normalized],
          readonly: false,
        });
        if (handleCollision.rows.length !== 0) {
          return yield* Effect.fail(new IdentityRegistrationRace({ reason: "handle" }));
        }

        const insertedUser = yield* transaction.execute({
          label: "identity.registration.insert-user",
          text: `INSERT INTO users (user_id, status, account, created_at)
                     VALUES ($1, 'active', $2::jsonb, $3::timestamptz)
                     ON CONFLICT (user_id) DO NOTHING`,
          values: [input.userId, encodedAccount, document.user.created_at],
          readonly: false,
        });
        if (insertedUser.rowCount !== 1) {
          return yield* Effect.fail(new IdentityRegistrationRace({ reason: "user_id" }));
        }

        yield* transaction.execute({
          label: "identity.registration.insert-minimum-age-attestation",
          text: `INSERT INTO account_minimum_age_attestations
                  (account_id, version, minimum_age, affirmed, attested_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
          values: [
            input.userId,
            input.minimumAgeAttestation.version,
            input.minimumAgeAttestation.minimum_age,
            input.minimumAgeAttestation.affirmed,
            document.user.created_at,
          ],
          readonly: false,
        });

        const insertedCredential = yield* transaction.execute({
          label: "identity.registration.insert-credential",
          text: `INSERT INTO identity_credentials (
                       credential_id, provider, provider_app_id, provider_subject,
                       canonical_user_id, status
                     ) VALUES ($1, $2, $3, $4, $5, 'active')
                     ON CONFLICT DO NOTHING`,
          values: [
            input.credentialId,
            input.provider,
            input.providerAppId,
            input.providerSubject,
            input.userId,
          ],
          readonly: false,
        });
        if (insertedCredential.rowCount !== 1) {
          return yield* Effect.fail(new IdentityRegistrationRace({ reason: "provider_subject" }));
        }
        return {
          kind: "created",
          canonicalUserId: input.userId,
          account: document,
        } as const;
      }),
    );
    const attempted = yield* registrationAttempt.pipe(Effect.result);

    if (Result.isSuccess(attempted)) return attempted.success;
    const failure = attempted.failure;
    if (
      !(failure instanceof IdentityRegistrationRace) &&
      failure._tag === "ControlPlaneStatementFailed" &&
      failure.sqlState === "23505" &&
      (failure.constraint === "persona_pending_first_handles_handle_id_key" ||
        failure.constraint === "persona_pending_first_handles_label_normalized_key" ||
        failure.constraint === "first_persona_handle_reservation_unique")
    ) {
      return { kind: "candidate_collision", field: "handle" };
    }
    if (!(failure instanceof IdentityRegistrationRace)) return yield* Effect.fail(failure);
    if (failure.reason !== "provider_subject") {
      return {
        kind: "candidate_collision",
        field: failure.reason,
      };
    }
    const winner = yield* readCredential();
    if (winner.rows.length === 0) {
      return { kind: "candidate_collision", field: "credential_id" };
    }
    if (winner.rows.length !== 1) return yield* Effect.fail(invalid());
    return yield* credentialOutcome(winner.rows[0]);
  });

  return {
    findUser,
    resolveCanonical,
    resolveCredentialCanonical,
    upsertAccount,
    registerCredential,
  };
}

export function makeControlPlaneCredentialCanonicalResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  identity: Readonly<{ provider: string; providerAppId: string }>,
) {
  const repository = makeControlPlaneIdentityRepository();
  return (providerSubject: string) =>
    repository
      .resolveCredentialCanonical({ ...identity, providerSubject })
      .pipe(Effect.provide(runtime));
}

/** Bind the SQL repository to one request-scoped ControlPlaneDb layer. */
export function makeControlPlaneIdentityStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): IdentityStore["Service"] {
  const repository = makeControlPlaneIdentityRepository();
  const provide = <A, E>(
    effect: Effect.Effect<A, E, ControlPlaneDb>,
  ): Effect.Effect<A, E | ControlPlaneError> => Effect.provide(runtime)(effect);

  return {
    findUser: (userId) => provide(repository.findUser(userId)),
    resolveCanonical: (input) =>
      provide(repository.resolveCanonical(input)).pipe(
        Effect.mapError((error) =>
          error instanceof IdentityRepositoryError
            ? new IdentityResolutionError({ reason: error.reason })
            : error,
        ),
      ),
    upsertAccount: (input) =>
      provide(repository.upsertAccount(input)).pipe(
        Effect.mapError((error) =>
          error instanceof IdentityRepositoryError
            ? new IdentityResolutionError({ reason: error.reason })
            : error,
        ),
      ),
  };
}

/** Exact Privy-app credential lookup for returning browser sessions. */
export function makeControlPlanePrivySessionCredentialStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): PrivySessionCredentialStore {
  const resolveCanonicalUserId = Effect.fn(
    "ControlPlanePrivySessionCredentialStore.resolveCanonicalUserId",
  )(function* ({
    providerAppId,
    providerSubject,
  }: {
    readonly providerAppId: string;
    readonly providerSubject: string;
  }) {
    if (!validId(providerAppId) || !validId(providerSubject)) {
      return yield* new SessionIdentityRejected({ reason: "invalid" });
    }
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<SessionCredentialRow>({
      label: "identity.session.resolve-privy-credential",
      text: `SELECT canonical_user_id,status
               FROM identity_credentials
              WHERE provider='privy'
                AND provider_app_id=$1
                AND provider_subject=$2`,
      values: [providerAppId, providerSubject],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      return yield* new SessionIdentityRejected({ reason: "invalid" });
    }
    const row = result.rows[0];
    if (row?.status === "tombstoned") {
      return yield* new SessionIdentityRejected({ reason: "deleted" });
    }
    if (
      row?.status !== "active" ||
      typeof row.canonical_user_id !== "string" ||
      !validId(row.canonical_user_id)
    ) {
      return yield* new SessionIdentityRejected({ reason: "invalid" });
    }
    return row.canonical_user_id;
  });
  return {
    resolveCanonicalUserId: (input) => resolveCanonicalUserId(input).pipe(Effect.provide(runtime)),
  };
}

/** Registration-specific adapter with a closed, non-driver error vocabulary. */
export function makeControlPlaneIdentityRegistrationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): IdentityRegistrationStore {
  const repository = makeControlPlaneIdentityRepository();
  return {
    registerCredential: (input) =>
      repository.registerCredential(input).pipe(
        Effect.provide(runtime),
        Effect.mapError(
          (error) =>
            new IdentityRegistrationStoreFailure({
              reason: error instanceof IdentityRepositoryError ? "identity-conflict" : "storage",
            }),
        ),
      ),
    getFirstPersonaWalletPreparation: (accountId) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Record<string, unknown>>({
          label: "identity.registration.first-persona-wallet",
          text: `SELECT persona.persona_id,assignment.hd_wallet_index
                   FROM personas AS persona
                   JOIN persona_wallet_assignments AS assignment
                     ON assignment.persona_id=persona.persona_id
                    AND assignment.account_id=persona.account_id
                    AND assignment.chain_account_kind='evm'
                  WHERE persona.account_id=$1 AND persona.is_first_persona
                    AND persona.status='pending_wallet' AND assignment.status='pending'`,
          values: [accountId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* Effect.die("duplicate first persona wallet");
        const row = result.rows[0];
        return yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(PersonaEvmWalletPreparationV1)({
              persona_id: row?.persona_id,
              chain_account_kind: "evm",
              hd_wallet_index: Number(row?.hd_wallet_index),
              status: "pending",
              assignment: null,
            }),
          catch: () => new IdentityRepositoryError({ reason: "invalid" }),
        });
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => new IdentityRegistrationStoreFailure({ reason: "storage" })),
      ),
  };
}

export function makeControlPlaneSessionProductReadiness(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  return {
    isReady: (accountId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<{ ready: boolean }>({
          label: "identity.session.product-readiness",
          text: `SELECT EXISTS (
                   SELECT 1 FROM personas AS persona
                    JOIN persona_profiles AS profile USING (persona_id)
                   WHERE persona.account_id=$1 AND persona.is_first_persona
                     AND persona.status='active'
                     AND 1 = (
                       SELECT count(*) FROM persona_wallet_assignments AS assignment
                        WHERE assignment.persona_id=persona.persona_id
                          AND assignment.chain_account_kind='evm'
                          AND assignment.status='active'
                     )
                 ) AS ready`,
          values: [accountId],
          readonly: true,
        });
        return result.rows[0]?.ready === true;
      }).pipe(Effect.provide(runtime)),
  };
}
