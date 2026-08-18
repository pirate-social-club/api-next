import {
  ControlPlaneDb,
  type ControlPlaneError,
  IdentityResolutionError,
  type IdentityStore,
} from "@pirate/application";
import { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { Data, Effect, type Layer, Result, Schema } from "effect";

export const MAX_CANONICAL_ALIAS_HOPS = 8;

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
  readonly credentialId: string;
  readonly userId: string;
  readonly account: unknown;
};

export type IdentityRegistrationOutcome =
  | { readonly kind: "created"; readonly canonicalUserId: string }
  | { readonly kind: "already_registered"; readonly canonicalUserId: string }
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
};

class IdentityRegistrationRace extends Data.TaggedError("IdentityRegistrationRace")<{
  readonly reason: "provider_subject" | "credential_id" | "user_id" | "handle";
}> {}

const validId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

const invalid = (): IdentityRepositoryError => new IdentityRepositoryError({ reason: "invalid" });

const missing = (deleted = false): IdentityRepositoryError =>
  new IdentityRepositoryError({ reason: deleted ? "deleted" : "missing" });

const credentialOutcome = (row: CredentialRow | undefined): ExistingCredentialOutcome => {
  if (row === undefined || typeof row.canonical_user_id !== "string") throw invalid();
  if (row.status === "tombstoned") return { kind: "tombstoned" };
  if (row.status !== "active" || row.user_status !== "active" || !validId(row.canonical_user_id)) {
    throw invalid();
  }
  return { kind: "already_registered", canonicalUserId: row.canonical_user_id };
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
        text: "SELECT user_id, account FROM users WHERE user_id = $1 AND status = 'active'",
        values: [userId],
        readonly: true,
      });
      const row = result.rows[0];
      if (row === undefined || typeof row.user_id !== "string") return null;
      return { userId: row.user_id, account: row.account };
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
      yield* db.withTransaction((transaction) =>
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
            label: "identity.public-handles.redirect-previous",
            text: `UPDATE public_handle_index
                      SET status = 'redirect',
                          redirect_target_handle_id = $2,
                          updated_at = now()
                    WHERE owner_user_id = $1
                      AND status IN ('active', 'redirect')
                      AND handle_id <> $2`,
            values: [userId, document.global_handle.global_handle_id],
            readonly: false,
          });
          const currentHandle = yield* transaction.execute({
            label: "identity.public-handles.upsert-current",
            text: `INSERT INTO public_handle_index (
                     handle_id, label_normalized, label_display, status,
                     owner_user_id, redirect_target_handle_id
                   ) VALUES ($1, $2, $3, 'active', $4, NULL)
                   ON CONFLICT (handle_id) DO UPDATE
                     SET label_normalized = EXCLUDED.label_normalized,
                         label_display = EXCLUDED.label_display,
                         status = 'active',
                         owner_user_id = EXCLUDED.owner_user_id,
                         redirect_target_handle_id = NULL,
                         updated_at = now()
                   WHERE public_handle_index.owner_user_id = EXCLUDED.owner_user_id`,
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
      try: () => JSON.stringify(input.account),
      catch: () => invalid(),
    });
    const db = yield* ControlPlaneDb;

    const readCredential = () =>
      db.execute<CredentialRow>({
        label: "identity.credentials.read",
        text: `SELECT credential.canonical_user_id, credential.status,
                        account.status AS user_status
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
                          account.status AS user_status
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
        if (existing.rows.length === 1) return credentialOutcome(existing.rows[0]);

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

        const insertedHandle = yield* transaction.execute({
          label: "identity.registration.insert-handle",
          text: `INSERT INTO public_handle_index (
                       handle_id, label_normalized, label_display, status,
                       owner_user_id, redirect_target_handle_id
                     ) VALUES ($1, $2, $3, 'active', $4, NULL)
                     ON CONFLICT DO NOTHING`,
          values: [
            document.global_handle.global_handle_id,
            label.normalized,
            label.display,
            input.userId,
          ],
          readonly: false,
        });
        if (insertedHandle.rowCount !== 1) {
          return yield* Effect.fail(new IdentityRegistrationRace({ reason: "handle" }));
        }

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
        return { kind: "created", canonicalUserId: input.userId } as const;
      }),
    );
    const attempted = yield* registrationAttempt.pipe(Effect.result);

    if (Result.isSuccess(attempted)) return attempted.success;
    const failure = attempted.failure;
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
    return credentialOutcome(winner.rows[0]);
  });

  return { findUser, resolveCanonical, upsertAccount, registerCredential };
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
