import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type PublicSongOwnerPolicy,
  type SongOwnerPolicyManagement,
  SongOwnerPolicyStoreError,
  type SongOwnerPolicyStoreFailure,
  type SongOwnerPolicyStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const invalidRow = (operation: "get-management" | "update" | "get-public") =>
  new SongOwnerPolicyStoreError({ operation, reason: "invalid-row" });

const notFound = (operation: "get-management" | "update" | "get-public") =>
  new SongOwnerPolicyStoreError({ operation, reason: "not-found" });

const conflict = () => new SongOwnerPolicyStoreError({ operation: "update", reason: "conflict" });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

const policyHash = (row: Row): string => {
  const value = text(row, "policy_hash");
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("invalid policy_hash");
  return value;
};

const integer = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${key}`);
  return value;
};

const instant = (row: Row, key: string): string => {
  const value = row[key];
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid ${key}`);
  return parsed.toISOString();
};

const thirdPartyRewardLegs = (row: Row): "allowed" | "owner_only" => {
  const value = row.third_party_reward_legs;
  if (value !== "allowed" && value !== "owner_only")
    throw new Error("invalid third_party_reward_legs");
  return value;
};

const poolLeg = (row: Row): "allowed" | "declined" => {
  const value = row.pool_leg;
  if (value !== "allowed" && value !== "declined") throw new Error("invalid pool_leg");
  return value;
};

const derivativeVideo = (row: Row): "allowed" | "owner_only" | "blocked" => {
  const value = row.derivative_video;
  if (value !== "allowed" && value !== "owner_only" && value !== "blocked") {
    throw new Error("invalid derivative_video");
  }
  return value;
};

const boolean = (row: Row, key: string): boolean => {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`invalid ${key}`);
  return value;
};

const managementFromRow = (row: Row): SongOwnerPolicyManagement => ({
  object: "song_owner_policy",
  community_id: text(row, "community_id"),
  post_id: text(row, "post_id"),
  audio_revision: integer(row, "audio_revision"),
  owner_account_id: text(row, "owner_account_id"),
  policy_revision: integer(row, "policy_revision"),
  third_party_reward_legs: thirdPartyRewardLegs(row),
  pool_leg: poolLeg(row),
  derivative_video: derivativeVideo(row),
  policy_hash: policyHash(row),
  effective_at: instant(row, "effective_at"),
});

const publicFromRow = (row: Row): PublicSongOwnerPolicy => ({
  object: "song_owner_policy",
  community_id: text(row, "community_id"),
  post_id: text(row, "post_id"),
  policy_revision: integer(row, "policy_revision"),
  derivative_video: derivativeVideo(row),
  can_post_with_song: boolean(row, "can_post_with_song"),
});

const mapUpdateFailure = (error: SongOwnerPolicyStoreFailure | ControlPlaneError) => {
  if (error instanceof ControlPlaneStatementFailed && error.sqlState === "P0001") {
    return conflict();
  }
  return error;
};

const MANAGEMENT_SELECT = `
  SELECT head.community_id, head.post_id, head.audio_revision,
         head.owner_account_id, revision.policy_revision,
         revision.third_party_reward_legs, revision.pool_leg,
         revision.derivative_video, revision.policy_hash, revision.effective_at
    FROM song_owner_policies AS head
    JOIN song_owner_policy_revisions AS revision
      ON revision.community_id = head.community_id
     AND revision.post_id = head.post_id
     AND revision.audio_revision = head.audio_revision
     AND revision.owner_account_id = head.owner_account_id
     AND revision.policy_revision = head.current_policy_revision
     AND revision.policy_hash = head.current_policy_hash
    JOIN posts AS post
      ON post.community_id = head.community_id
     AND post.post_id = head.post_id
     AND post.post_type = 'song'
     AND post.status = 'published'
   WHERE head.community_id = $1
     AND head.post_id = $2
     AND head.owner_account_id = $3
     AND active_owned_persona($3, $4)
   FOR SHARE`;

const PUBLIC_SELECT = `
  SELECT head.community_id, head.post_id,
         revision.policy_revision, revision.derivative_video,
         CASE
           WHEN $3::text IS NULL OR $4::text IS NULL THEN false
           WHEN NOT active_owned_persona($3::text, $4::text) THEN false
           WHEN NOT active_community_effect($1::text, $3::text) THEN false
           WHEN revision.derivative_video = 'allowed' THEN true
           WHEN revision.derivative_video = 'owner_only'
             AND head.owner_account_id = $3::text THEN true
           ELSE false
         END AS can_post_with_song
    FROM song_owner_policies AS head
    JOIN song_owner_policy_revisions AS revision
      ON revision.community_id = head.community_id
     AND revision.post_id = head.post_id
     AND revision.audio_revision = head.audio_revision
     AND revision.owner_account_id = head.owner_account_id
     AND revision.policy_revision = head.current_policy_revision
     AND revision.policy_hash = head.current_policy_hash
    JOIN posts AS post
      ON post.community_id = head.community_id
     AND post.post_id = head.post_id
     AND post.post_type = 'song'
     AND post.status = 'published'
     AND post.visibility = 'public'
   WHERE head.community_id = $1
     AND head.post_id = $2`;

export interface SongOwnerPolicyRepository {
  readonly getManagement: (
    input: Parameters<SongOwnerPolicyStoreService["getManagement"]>[0],
  ) => Effect.Effect<
    SongOwnerPolicyManagement,
    SongOwnerPolicyStoreFailure | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly update: (
    input: Parameters<SongOwnerPolicyStoreService["update"]>[0],
  ) => Effect.Effect<
    SongOwnerPolicyManagement,
    SongOwnerPolicyStoreFailure | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly getPublic: (
    input: Parameters<SongOwnerPolicyStoreService["getPublic"]>[0],
  ) => Effect.Effect<
    PublicSongOwnerPolicy,
    SongOwnerPolicyStoreFailure | ControlPlaneError,
    ControlPlaneDb
  >;
}

export const makeControlPlaneSongOwnerPolicyRepository = (): SongOwnerPolicyRepository => ({
  getManagement: (input) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "song-owner-policy.management.read",
        text: MANAGEMENT_SELECT,
        values: [input.communityId, input.postId, input.accountId, input.personaId],
        readonly: true,
      });
      if (result.rows.length !== 1) return yield* notFound("get-management");
      try {
        return managementFromRow(result.rows[0] as Row);
      } catch {
        return yield* invalidRow("get-management");
      }
    }),

  update: (input) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const persona = yield* transaction.execute({
            label: "song-owner-policy.persona.authority",
            text: `SELECT 1
                     FROM personas
                    WHERE persona_id = $1
                      AND account_id = $2
                      AND status = 'active'
                    FOR SHARE`,
            values: [input.update.persona_id, input.accountId],
            readonly: true,
          });
          if (persona.rows.length !== 1) return yield* notFound("update");

          const song = yield* transaction.execute({
            label: "song-owner-policy.owner.authority",
            text: `SELECT 1
                     FROM song_owner_policies
                    WHERE community_id = $1
                      AND post_id = $2
                      AND owner_account_id = $3
                    FOR SHARE`,
            values: [input.communityId, input.postId, input.accountId],
            readonly: true,
          });
          if (song.rows.length !== 1) return yield* notFound("update");

          const result = yield* transaction.execute<Row>({
            label: "song-owner-policy.revision.append",
            text: `SELECT *
                     FROM append_song_owner_policy_revision_v1($1, $2, $3, $4, $5, $6, $7)`,
            values: [
              input.communityId,
              input.postId,
              input.accountId,
              input.update.expected_policy_revision,
              input.update.third_party_reward_legs,
              input.update.pool_leg,
              input.update.derivative_video,
            ],
            readonly: false,
          });
          if (result.rows.length !== 1) return yield* invalidRow("update");
          try {
            return managementFromRow(result.rows[0] as Row);
          } catch {
            return yield* invalidRow("update");
          }
        }),
      );
    }).pipe(Effect.mapError(mapUpdateFailure)),

  getPublic: (input) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "song-owner-policy.public.read",
        text: PUBLIC_SELECT,
        values: [input.communityId, input.postId, input.accountId, input.personaId],
        readonly: true,
      });
      if (result.rows.length !== 1) return yield* notFound("get-public");
      try {
        return publicFromRow(result.rows[0] as Row);
      } catch {
        return yield* invalidRow("get-public");
      }
    }),
});

export const makeControlPlaneSongOwnerPolicyStore = (
  database: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SongOwnerPolicyStoreService => {
  const repository = makeControlPlaneSongOwnerPolicyRepository();
  return {
    getManagement: (input) => Effect.provide(database)(repository.getManagement(input)),
    update: (input) => Effect.provide(database)(repository.update(input)),
    getPublic: (input) => Effect.provide(database)(repository.getPublic(input)),
  };
};
