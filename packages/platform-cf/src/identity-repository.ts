import {
  ControlPlaneDb,
  type ControlPlaneError,
  IdentityResolutionError,
  type IdentityStore,
} from "@pirate/application";
import { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { Data, Effect, type Layer, Schema } from "effect";

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
}

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

const validId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

const invalid = (): IdentityRepositoryError => new IdentityRepositoryError({ reason: "invalid" });

const missing = (deleted = false): IdentityRepositoryError =>
  new IdentityRepositoryError({ reason: deleted ? "deleted" : "missing" });

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

  return { findUser, resolveCanonical, upsertAccount };
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
