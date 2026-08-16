import {
  type CommunityPreviewDocument,
  CommunityRepositoryError,
  type CommunityStore,
  type CommunityStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type MembershipStatus,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type CommunityRow = {
  readonly community_id: unknown;
  readonly display_name: unknown;
  readonly membership_mode: unknown;
  readonly human_verification_lane: unknown;
  readonly created_at: unknown;
  readonly member_count?: unknown;
  readonly follower_count?: unknown;
  readonly viewer_membership_status?: unknown;
  readonly viewer_following?: unknown;
};

type MembershipRow = {
  readonly status: unknown;
};

type JoinCommunityRow = {
  readonly community_id: unknown;
  readonly membership_mode: unknown;
  readonly human_verification_lane?: unknown;
};

type FollowCountRow = {
  readonly follower_count: unknown;
};

const validId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

const invalid = (
  operation: "membership" | "preview" | "eligibility" | "join" | "follow" | "unfollow",
) => new CommunityRepositoryError({ operation, reason: "invalid-row" });

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asCount = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
};

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const asTimestamp = (value: unknown): number | null => {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
};

const membershipMode = (value: unknown): "open" | "request" | "gated" | null =>
  value === "open" || value === "request" || value === "gated" ? value : null;

const verificationLane = (value: unknown): "very" | "self" | null =>
  value === "very" || value === "self" ? value : null;

const parseMembershipStatus = (value: unknown): MembershipStatus | null =>
  value === "missing" ||
  value === "pending" ||
  value === "member" ||
  value === "left" ||
  value === "banned"
    ? value
    : null;

const viewerMembershipStatus = (value: unknown): "member" | "not_member" | "banned" | null => {
  if (value === "member") return "member";
  if (value === "banned") return "banned";
  if (value === "missing" || value === "pending" || value === "left") return "not_member";
  return null;
};

const row = <T>(rows: readonly T[]): T | undefined => rows[0];

const communityLookup = (communityId: string, viewerUserId?: string) => ({
  label: "community.communities.get-preview",
  text: `SELECT c.community_id,
                c.display_name,
                c.membership_mode,
                c.human_verification_lane,
                c.created_at,
                (SELECT COUNT(*)
                   FROM community_memberships AS member_count
                  WHERE member_count.community_id = c.community_id
                    AND member_count.status = 'member') AS member_count,
                (SELECT COUNT(*)
                   FROM community_follows AS follower_count
                  WHERE follower_count.community_id = c.community_id
                    AND follower_count.status = 'active') AS follower_count,
                CASE WHEN $2::text IS NULL THEN NULL
                     ELSE COALESCE((SELECT membership.status
                                      FROM community_memberships AS membership
                                     WHERE membership.community_id = c.community_id
                                       AND membership.user_id = $2), 'missing')
                END AS viewer_membership_status,
                CASE WHEN $2::text IS NULL THEN NULL
                     ELSE EXISTS (SELECT 1
                                    FROM community_follows AS following
                                   WHERE following.community_id = c.community_id
                                     AND following.user_id = $2
                                     AND following.status = 'active')
                END AS viewer_following
           FROM communities AS c
          WHERE c.community_id = $1
            AND c.status = 'active'`,
  values: [communityId, viewerUserId ?? null],
  readonly: true,
});

interface CommunityRepository {
  readonly membershipStatus: CommunityStoreService["membershipStatus"];
  readonly getPreview: CommunityStoreService["getPreview"];
  readonly getJoinEligibility: CommunityStoreService["getJoinEligibility"];
  readonly join: CommunityStoreService["join"];
  readonly follow: CommunityStoreService["follow"];
  readonly unfollow: CommunityStoreService["unfollow"];
}

/**
 * SQL repository for the M2 community/membership vertical.
 *
 * It intentionally returns the frozen application documents rather than
 * exposing driver rows. Every write is transaction-scoped and every query is
 * tenant-scoped by community_id.
 */
export function makeControlPlaneCommunityRepository(): CommunityRepository {
  const membershipStatus: CommunityRepository["membershipStatus"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.userId)) {
        return yield* Effect.fail(invalid("membership"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<MembershipRow>({
        label: "community.memberships.status",
        text: `SELECT status
                  FROM community_memberships
                 WHERE community_id = $1
                   AND user_id = $2`,
        values: [input.communityId, input.userId],
        readonly: true,
      });
      const status = row(result.rows);
      if (status === undefined) return "missing";
      const parsed = parseMembershipStatus(status.status);
      if (parsed === null) return yield* Effect.fail(invalid("membership"));
      return parsed;
    });

  const getPreview: CommunityRepository["getPreview"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.communityId) ||
        (input.viewerUserId !== undefined && !validId(input.viewerUserId))
      ) {
        return yield* Effect.fail(invalid("preview"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<CommunityRow>(
        communityLookup(input.communityId, input.viewerUserId),
      );
      const community = row(result.rows);
      if (community === undefined) return null;

      const id = asString(community.community_id);
      const displayName = asString(community.display_name);
      const mode = membershipMode(community.membership_mode);
      const created = asTimestamp(community.created_at);
      const memberCount = asCount(community.member_count);
      const followerCount = asCount(community.follower_count);
      const verification = verificationLane(community.human_verification_lane);
      if (
        id === null ||
        displayName === null ||
        mode === null ||
        created === null ||
        memberCount === null ||
        followerCount === null
      ) {
        return yield* Effect.fail(invalid("preview"));
      }

      const preview: CommunityPreviewDocument = {
        id,
        object: "community_preview" as const,
        display_name: displayName,
        membership_mode: mode,
        human_verification_lane: verification,
        member_count: memberCount,
        follower_count: followerCount,
        moderators: [],
        membership_gate_summaries: [],
        rules: [],
        created,
        ...(input.viewerUserId === undefined
          ? {}
          : {
              viewer_membership_status: viewerMembershipStatus(community.viewer_membership_status),
              viewer_following: asBoolean(community.viewer_following) ?? false,
            }),
      };
      return preview;
    });

  const getJoinEligibility: CommunityRepository["getJoinEligibility"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.userId)) {
        return yield* Effect.fail(invalid("eligibility"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<
        JoinCommunityRow & { readonly status: unknown; readonly created_at: unknown }
      >({
        label: "community.memberships.get-eligibility",
        text: `SELECT c.community_id,
                      c.membership_mode,
                      c.human_verification_lane,
                      c.created_at,
                      COALESCE(m.status, 'missing') AS status
                 FROM communities AS c
                 LEFT JOIN community_memberships AS m
                   ON m.community_id = c.community_id
                  AND m.user_id = $2
                WHERE c.community_id = $1
                  AND c.status = 'active'`,
        values: [input.communityId, input.userId],
        readonly: true,
      });
      const community = row(result.rows);
      if (community === undefined) return null;
      const id = asString(community.community_id);
      const mode = membershipMode(community.membership_mode);
      const verification = verificationLane(community.human_verification_lane);
      if (id === null || mode === null) return yield* Effect.fail(invalid("eligibility"));

      const status = parseMembershipStatus(community.status);
      if (status === null) return yield* Effect.fail(invalid("eligibility"));
      if (status === "banned") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          joinable_now: false,
          status: "banned" as const,
          membership_gate_summaries: [],
          failure_reason: "banned" as const,
        };
      }
      if (status === "member") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          joinable_now: false,
          status: "already_joined" as const,
          membership_gate_summaries: [],
        };
      }
      if (status === "pending") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          joinable_now: false,
          status: "pending_request" as const,
          membership_gate_summaries: [],
        };
      }
      if (mode === "gated") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          joinable_now: false,
          status: "gate_failed" as const,
          membership_gate_summaries: [],
          failure_reason: "unsupported" as const,
        };
      }
      return {
        community: id,
        membership_mode: mode,
        human_verification_lane: verification,
        joinable_now: true,
        status: mode === "request" ? ("requestable" as const) : ("joinable" as const),
        membership_gate_summaries: [],
      };
    });

  const join: CommunityRepository["join"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.actor.userId)) {
        return yield* Effect.fail(invalid("join"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const communityResult = yield* transaction.execute<JoinCommunityRow>({
            label: "community.memberships.join-community",
            text: `SELECT community_id, membership_mode
                     FROM communities
                    WHERE community_id = $1
                      AND status = 'active'
                    FOR UPDATE`,
            values: [input.communityId],
            readonly: false,
          });
          const community = row(communityResult.rows);
          const communityId = community === undefined ? null : asString(community.community_id);
          const mode = community === undefined ? null : membershipMode(community.membership_mode);
          if (communityId === null || mode === null) return yield* Effect.fail(invalid("join"));

          const existingResult = yield* transaction.execute<MembershipRow>({
            label: "community.memberships.lock-member",
            text: `SELECT status
                     FROM community_memberships
                    WHERE community_id = $1
                      AND user_id = $2
                    FOR UPDATE`,
            values: [input.communityId, input.actor.userId],
            readonly: false,
          });
          const existing = row(existingResult.rows);
          const existingStatus =
            existing === undefined ? null : parseMembershipStatus(existing.status);
          if (existing !== undefined && existingStatus === null) {
            return yield* Effect.fail(invalid("join"));
          }
          if (existingStatus === "member")
            return { community: communityId, status: "joined" as const };
          if (existingStatus === "pending") {
            return { community: communityId, status: "requested" as const };
          }
          if (existingStatus === "banned" || mode === "gated") {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "join", reason: "membership-required" }),
            );
          }

          const status = mode === "request" ? "pending" : "member";
          if (existingStatus === "left") {
            yield* transaction.execute({
              label: "community.memberships.reactivate",
              text: `UPDATE community_memberships
                        SET status = $3,
                            joined_at = CASE WHEN $3 = 'member' THEN now() ELSE NULL END,
                            left_at = NULL,
                            updated_at = now()
                      WHERE community_id = $1
                        AND user_id = $2`,
              values: [input.communityId, input.actor.userId, status],
              readonly: false,
            });
          } else {
            yield* transaction.execute({
              label: "community.memberships.insert",
              text: `INSERT INTO community_memberships
                        (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
                      VALUES ($1, $2, $3, $4,
                              CASE WHEN $4 = 'member' THEN now() ELSE NULL END,
                              now(), now())`,
              values: [
                input.communityId,
                `membership:${input.communityId}:${input.actor.userId}`,
                input.actor.userId,
                status,
              ],
              readonly: false,
            });
          }
          return {
            community: communityId,
            status: status === "member" ? ("joined" as const) : ("requested" as const),
          };
        }),
      );
    });

  const follow: CommunityRepository["follow"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.actor.userId)) {
        return yield* Effect.fail(invalid("follow"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const community = yield* transaction.execute({
            label: "community.follows.lock-community",
            text: `SELECT community_id
                     FROM communities
                    WHERE community_id = $1
                      AND status = 'active'
                    FOR UPDATE`,
            values: [input.communityId],
            readonly: false,
          });
          if (community.rowCount !== 1) return yield* Effect.fail(invalid("follow"));

          const membership = yield* transaction.execute<MembershipRow>({
            label: "community.follows.require-member",
            text: `SELECT status
                     FROM community_memberships
                    WHERE community_id = $1
                      AND user_id = $2
                    FOR UPDATE`,
            values: [input.communityId, input.actor.userId],
            readonly: false,
          });
          const status = row(membership.rows);
          if (status === undefined) {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "follow", reason: "membership-required" }),
            );
          }
          const parsedStatus = parseMembershipStatus(status.status);
          if (parsedStatus === null) return yield* Effect.fail(invalid("follow"));
          if (parsedStatus !== "member") {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "follow", reason: "membership-required" }),
            );
          }

          yield* transaction.execute({
            label: "community.follows.activate",
            text: `INSERT INTO community_follows
                      (community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at)
                    VALUES ($1, $2, $3, 'active', NULL, now(), now())
                    ON CONFLICT (community_id, user_id)
                    DO UPDATE SET status = 'active', unfollowed_at = NULL, updated_at = now()`,
            values: [
              `follow:${input.communityId}:${input.actor.userId}`,
              input.communityId,
              input.actor.userId,
            ],
            readonly: false,
          });
          const count = yield* transaction.execute<FollowCountRow>({
            label: "community.follows.count",
            text: `SELECT COUNT(*) AS follower_count
                     FROM community_follows
                    WHERE community_id = $1
                      AND status = 'active'`,
            values: [input.communityId],
            readonly: true,
          });
          const followerCount = asCount(row(count.rows)?.follower_count);
          if (followerCount === null) return yield* Effect.fail(invalid("follow"));
          return { community: input.communityId, following: true, follower_count: followerCount };
        }),
      );
    });

  const unfollow: CommunityRepository["unfollow"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.actor.userId)) {
        return yield* Effect.fail(invalid("unfollow"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const community = yield* transaction.execute({
            label: "community.follows.lock-community-unfollow",
            text: `SELECT community_id
                     FROM communities
                    WHERE community_id = $1
                      AND status = 'active'
                    FOR UPDATE`,
            values: [input.communityId],
            readonly: false,
          });
          if (community.rowCount !== 1) return yield* Effect.fail(invalid("unfollow"));

          yield* transaction.execute({
            label: "community.follows.deactivate",
            text: `UPDATE community_follows
                       SET status = 'inactive', unfollowed_at = now(), updated_at = now()
                     WHERE community_id = $1
                       AND user_id = $2
                       AND status = 'active'`,
            values: [input.communityId, input.actor.userId],
            readonly: false,
          });
          const count = yield* transaction.execute<FollowCountRow>({
            label: "community.follows.count-after-unfollow",
            text: `SELECT COUNT(*) AS follower_count
                     FROM community_follows
                    WHERE community_id = $1
                      AND status = 'active'`,
            values: [input.communityId],
            readonly: true,
          });
          const followerCount = asCount(row(count.rows)?.follower_count);
          if (followerCount === null) return yield* Effect.fail(invalid("unfollow"));
          const following = false;
          return { community: input.communityId, following, follower_count: followerCount };
        }),
      );
    });

  return { membershipStatus, getPreview, getJoinEligibility, join, follow, unfollow };
}

/** Bind the repository's ControlPlaneDb requirement to a request-scoped Layer. */
export function makeControlPlaneCommunityStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityStore["Service"] {
  const repository = makeControlPlaneCommunityRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    membershipStatus: (input) => provide(repository.membershipStatus(input)),
    getPreview: (input) => provide(repository.getPreview(input)),
    getJoinEligibility: (input) => provide(repository.getJoinEligibility(input)),
    join: (input) => provide(repository.join(input)),
    follow: (input) => provide(repository.follow(input)),
    unfollow: (input) => provide(repository.unfollow(input)),
  };
}
