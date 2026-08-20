import {
  type CommunityPreviewDocument,
  CommunityRepositoryError,
  type CommunityRepositoryFailure,
  type CommunityStore,
  type CommunityStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type FollowDocument,
  type JoinDocument,
  type JoinEligibilityDocument,
  type MembershipStatus,
  type UnfollowDocument,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import {
  CURATED_AGE_GATE_SUMMARY,
  GatesV2CommunityDataInvalid,
  gateEvaluationDetails,
  loadCuratedAgeEvaluation,
  persistEnforceDecision,
} from "./gates-v2-community.ts";

type CommunityRow = {
  readonly community_id: unknown;
  readonly display_name: unknown;
  readonly description?: unknown;
  readonly route_slug?: unknown;
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
  readonly request_note?: unknown;
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

const asNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return asString(value) ?? undefined;
};

const asPersistedId = (value: unknown): string | null => {
  const parsed = asString(value);
  return parsed !== null && validId(parsed) ? parsed : null;
};

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
    return Number.isFinite(time) ? Math.floor(time / 1_000) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // pg returns TIMESTAMPTZ as Date, while test doubles and alternate
    // drivers may expose epoch milliseconds or seconds directly.
    return Math.floor(Math.abs(value) >= 100_000_000_000 ? value / 1_000 : value);
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor(time / 1_000) : null;
  }
  return null;
};

const membershipMode = (value: unknown): "open" | "request" | "gated" | null =>
  value === "open" || value === "request" || value === "gated" ? value : null;

const verificationLane = (value: unknown): "very" | "self" | null | undefined => {
  if (value === null) return null;
  if (value === "very" || value === "self") return value;
  return undefined;
};

const parseMembershipStatus = (value: unknown): MembershipStatus | null =>
  value === "missing" ||
  value === "pending" ||
  value === "member" ||
  value === "left" ||
  value === "banned"
    ? value
    : null;

const viewerMembershipStatus = (value: unknown): "member" | "not_member" | "banned" | undefined => {
  if (value === "member") return "member";
  if (value === "banned") return "banned";
  if (value === "missing" || value === "pending" || value === "left") return "not_member";
  return undefined;
};

const generatedId = (kind: "membership" | "follow"): string =>
  `${kind}_${globalThis.crypto.randomUUID()}`;

type JoinTransactionOutcome =
  | { readonly kind: "joined"; readonly document: JoinDocument }
  | { readonly kind: "gated-rejected"; readonly reason: "membership-required" | "invalid-row" };

const joined = (document: JoinDocument): JoinTransactionOutcome => ({
  kind: "joined",
  document,
});

const row = <T>(rows: readonly T[]): T | undefined => rows[0];

const communityLookup = (communityId: string, viewerUserId?: string) => ({
  label: "community.communities.get-preview",
  text: `SELECT c.community_id,
                c.display_name,
                c.description,
                c.route_slug,
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
  /** Internal methods retain their database requirement until the wrapper provisions it. */
  readonly membershipStatus: (
    input: Parameters<CommunityStoreService["membershipStatus"]>[0],
  ) => Effect.Effect<MembershipStatus, CommunityRepositoryFailure, ControlPlaneDb>;
  readonly getPreview: (
    input: Parameters<CommunityStoreService["getPreview"]>[0],
  ) => Effect.Effect<CommunityPreviewDocument | null, CommunityRepositoryFailure, ControlPlaneDb>;
  readonly getJoinEligibility: (
    input: Parameters<CommunityStoreService["getJoinEligibility"]>[0],
  ) => Effect.Effect<JoinEligibilityDocument | null, CommunityRepositoryFailure, ControlPlaneDb>;
  readonly join: (
    input: Parameters<CommunityStoreService["join"]>[0],
  ) => Effect.Effect<JoinDocument, CommunityRepositoryFailure, ControlPlaneDb>;
  readonly follow: (
    input: Parameters<CommunityStoreService["follow"]>[0],
  ) => Effect.Effect<FollowDocument, CommunityRepositoryFailure, ControlPlaneDb>;
  readonly unfollow: (
    input: Parameters<CommunityStoreService["unfollow"]>[0],
  ) => Effect.Effect<UnfollowDocument, CommunityRepositoryFailure, ControlPlaneDb>;
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
      if (result.rows.length > 1) return yield* Effect.fail(invalid("membership"));
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
      if (result.rows.length > 1) return yield* Effect.fail(invalid("preview"));
      const community = row(result.rows);
      if (community === undefined) return null;

      const id = asPersistedId(community.community_id);
      const displayName = asString(community.display_name);
      const description = asNullableString(community.description);
      const routeSlug = asNullableString(community.route_slug);
      const mode = membershipMode(community.membership_mode);
      const created = asTimestamp(community.created_at);
      const memberCount = asCount(community.member_count);
      const followerCount = asCount(community.follower_count);
      const verification = verificationLane(community.human_verification_lane);
      if (
        id === null ||
        id !== input.communityId ||
        displayName === null ||
        (community.description !== undefined && description === undefined) ||
        (community.route_slug !== undefined && routeSlug === undefined) ||
        mode === null ||
        created === null ||
        memberCount === null ||
        followerCount === null ||
        verification === undefined
      ) {
        return yield* Effect.fail(invalid("preview"));
      }

      let viewerStatus: "member" | "not_member" | "banned" | undefined;
      let viewerFollowing: boolean | undefined;
      if (input.viewerUserId !== undefined) {
        viewerStatus = viewerMembershipStatus(community.viewer_membership_status);
        viewerFollowing = asBoolean(community.viewer_following) ?? undefined;
        if (viewerStatus === undefined || viewerFollowing === undefined) {
          return yield* Effect.fail(invalid("preview"));
        }
      }

      const preview: CommunityPreviewDocument = {
        id,
        object: "community_preview" as const,
        display_name: displayName,
        ...(description === undefined ? {} : { description }),
        ...(routeSlug === undefined ? {} : { route_slug: routeSlug }),
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
              viewer_membership_status: viewerStatus,
              viewer_following: viewerFollowing,
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
      const result = yield* db.execute<JoinCommunityRow & { readonly status: unknown }>({
        label: "community.memberships.get-eligibility",
        text: `SELECT c.community_id,
                      c.membership_mode,
                      c.human_verification_lane,
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
      if (result.rows.length > 1) return yield* Effect.fail(invalid("eligibility"));
      const community = row(result.rows);
      if (community === undefined) return null;
      const id = asPersistedId(community.community_id);
      const mode = membershipMode(community.membership_mode);
      const verification = verificationLane(community.human_verification_lane);
      if (id === null || id !== input.communityId || mode === null || verification === undefined) {
        return yield* Effect.fail(invalid("eligibility"));
      }

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
        const evaluation = yield* loadCuratedAgeEvaluation(db, {
          communityId: input.communityId,
          userId: input.userId,
        }).pipe(
          Effect.mapError((error) =>
            error instanceof GatesV2CommunityDataInvalid ? invalid("eligibility") : error,
          ),
        );
        const gateEvaluation = gateEvaluationDetails(evaluation);
        if (evaluation.outcome === "indeterminate") {
          return yield* Effect.fail(invalid("eligibility"));
        }
        if (evaluation.outcome === "pass") {
          return {
            community: id,
            membership_mode: mode,
            human_verification_lane: verification,
            joinable_now: true,
            status: "joinable" as const,
            membership_gate_summaries: [CURATED_AGE_GATE_SUMMARY],
            gate_evaluation: gateEvaluation,
          };
        }
        if (evaluation.outcome === "needs_evidence") {
          return {
            community: id,
            membership_mode: mode,
            human_verification_lane: verification,
            joinable_now: false,
            status: "gate_failed" as const,
            membership_gate_summaries: [CURATED_AGE_GATE_SUMMARY],
            missing_capabilities: ["age_over_18" as const],
            suggested_verification_provider: "zkpassport" as const,
            suggested_verification_intent: "community_join" as const,
            failure_reason: "missing_verification" as const,
            gate_evaluation: gateEvaluation,
          };
        }
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          joinable_now: false,
          status: "gate_failed" as const,
          membership_gate_summaries: [CURATED_AGE_GATE_SUMMARY],
          failure_reason:
            evaluation.reason === "age_below_threshold"
              ? ("minimum_age_mismatch" as const)
              : ("unsupported" as const),
          gate_evaluation: gateEvaluation,
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
      const result = yield* db.withTransaction((transaction) =>
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
          if (communityResult.rows.length > 1) return yield* Effect.fail(invalid("join"));
          const community = row(communityResult.rows);
          const communityId =
            community === undefined ? null : asPersistedId(community.community_id);
          const mode = community === undefined ? null : membershipMode(community.membership_mode);
          if (community === undefined) {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "join", reason: "not-found" }),
            );
          }
          if (communityId === null || mode === null || communityId !== input.communityId) {
            return yield* Effect.fail(invalid("join"));
          }

          const existingResult = yield* transaction.execute<MembershipRow>({
            label: "community.memberships.lock-member",
            text: `SELECT status, request_note
                     FROM community_memberships
                    WHERE community_id = $1
                      AND user_id = $2
                    FOR UPDATE`,
            values: [input.communityId, input.actor.userId],
            readonly: false,
          });
          if (existingResult.rows.length > 1) return yield* Effect.fail(invalid("join"));
          const existing = row(existingResult.rows);
          const existingStatus =
            existing === undefined ? null : parseMembershipStatus(existing.status);
          if (existing !== undefined && existingStatus === null) {
            return yield* Effect.fail(invalid("join"));
          }
          if (
            existing !== undefined &&
            existing.request_note !== undefined &&
            existing.request_note !== null &&
            typeof existing.request_note !== "string"
          ) {
            return yield* Effect.fail(invalid("join"));
          }

          const requestNote = input.body.note ?? null;
          if (existingStatus === "member") {
            if (mode === "open") {
              yield* transaction.execute({
                label: "community.follows.activate",
                text: `INSERT INTO community_follows
                          (community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at)
                        VALUES ($1, $2, $3, 'active', NULL, now(), now())
                        ON CONFLICT (community_id, user_id)
                        DO UPDATE SET status = 'active', unfollowed_at = NULL, updated_at = now()`,
                values: [generatedId("follow"), input.communityId, input.actor.userId],
                readonly: false,
              });
            }
            return joined({ community: communityId, status: "joined" as const });
          }
          if (existingStatus === "pending") {
            if (
              requestNote !== null &&
              (existing?.request_note === null || existing?.request_note === undefined)
            ) {
              yield* transaction.execute({
                label: "community.memberships.update-request-note",
                text: `UPDATE community_memberships
                           SET request_note = $3, updated_at = now()
                         WHERE community_id = $1
                           AND user_id = $2`,
                values: [input.communityId, input.actor.userId, requestNote],
                readonly: false,
              });
            }
            // A pending request never activates a follow. An explicit prior
            // follow remains active until the user explicitly unfollows.
            return joined({ community: communityId, status: "requested" as const });
          }
          if (existingStatus === "banned") {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "join", reason: "membership-required" }),
            );
          }

          if (mode === "gated") {
            const evaluation = yield* loadCuratedAgeEvaluation(transaction, {
              communityId: input.communityId,
              userId: input.actor.userId,
            }).pipe(
              Effect.mapError((error) =>
                error instanceof GatesV2CommunityDataInvalid ? invalid("join") : error,
              ),
            );
            yield* persistEnforceDecision(transaction, {
              communityId: input.communityId,
              userId: input.actor.userId,
              requestId: `join-${globalThis.crypto.randomUUID()}`,
              evaluation,
            });
            if (evaluation.outcome !== "pass") {
              return {
                kind: "gated-rejected" as const,
                reason:
                  evaluation.outcome === "indeterminate"
                    ? ("invalid-row" as const)
                    : ("membership-required" as const),
              };
            }
          }

          const status = mode === "request" ? "pending" : "member";
          if (existingStatus === "left") {
            yield* transaction.execute({
              label: "community.memberships.reactivate",
              text: `UPDATE community_memberships
                        SET status = $3,
                            joined_at = CASE WHEN $3 = 'member' THEN now() ELSE NULL END,
                            left_at = NULL,
                            request_note = $4,
                            updated_at = now()
                      WHERE community_id = $1
                        AND user_id = $2`,
              values: [
                input.communityId,
                input.actor.userId,
                status,
                status === "pending" ? requestNote : null,
              ],
              readonly: false,
            });
          } else {
            yield* transaction.execute({
              label: "community.memberships.insert",
              text: `INSERT INTO community_memberships
                        (community_id, membership_id, user_id, status, joined_at, request_note, created_at, updated_at)
                      VALUES ($1, $2, $3, $4,
                              CASE WHEN $4 = 'member' THEN now() ELSE NULL END,
                              $5, now(), now())`,
              values: [
                input.communityId,
                generatedId("membership"),
                input.actor.userId,
                status,
                status === "pending" ? requestNote : null,
              ],
              readonly: false,
            });
          }
          if (status === "member") {
            yield* transaction.execute({
              label: "community.follows.activate",
              text: `INSERT INTO community_follows
                        (community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at)
                      VALUES ($1, $2, $3, 'active', NULL, now(), now())
                      ON CONFLICT (community_id, user_id)
                      DO UPDATE SET status = 'active', unfollowed_at = NULL, updated_at = now()`,
              values: [generatedId("follow"), input.communityId, input.actor.userId],
              readonly: false,
            });
          }
          return joined({
            community: communityId,
            status: status === "member" ? ("joined" as const) : ("requested" as const),
          });
        }),
      );
      if (result.kind === "gated-rejected") {
        return yield* Effect.fail(
          new CommunityRepositoryError({ operation: "join", reason: result.reason }),
        );
      }
      return result.document;
    });

  const follow: CommunityRepository["follow"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId) || !validId(input.actor.userId)) {
        return yield* Effect.fail(invalid("follow"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const community = yield* transaction.execute<{ readonly community_id: unknown }>({
            label: "community.follows.lock-community",
            text: `SELECT community_id
                     FROM communities
                    WHERE community_id = $1
                      AND status = 'active'
                    FOR UPDATE`,
            values: [input.communityId],
            readonly: false,
          });
          if (community.rows.length === 0) {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "follow", reason: "not-found" }),
            );
          }
          if (community.rows.length !== 1) return yield* Effect.fail(invalid("follow"));
          const lockedCommunityId = asPersistedId(row(community.rows)?.community_id);
          if (lockedCommunityId !== input.communityId) return yield* Effect.fail(invalid("follow"));

          yield* transaction.execute({
            label: "community.follows.activate",
            text: `INSERT INTO community_follows
                      (community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at)
                    VALUES ($1, $2, $3, 'active', NULL, now(), now())
                    ON CONFLICT (community_id, user_id)
                    DO UPDATE SET status = 'active', unfollowed_at = NULL, updated_at = now()`,
            values: [generatedId("follow"), input.communityId, input.actor.userId],
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
          if (count.rows.length !== 1) return yield* Effect.fail(invalid("follow"));
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
          const community = yield* transaction.execute<{ readonly community_id: unknown }>({
            label: "community.follows.lock-community-unfollow",
            text: `SELECT community_id
                     FROM communities
                    WHERE community_id = $1
                      AND status = 'active'
                    FOR UPDATE`,
            values: [input.communityId],
            readonly: false,
          });
          if (community.rows.length === 0) {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "unfollow", reason: "not-found" }),
            );
          }
          if (community.rows.length !== 1) return yield* Effect.fail(invalid("unfollow"));
          const lockedCommunityId = asPersistedId(row(community.rows)?.community_id);
          if (lockedCommunityId !== input.communityId) {
            return yield* Effect.fail(invalid("unfollow"));
          }

          const membership = yield* transaction.execute<MembershipRow>({
            label: "community.follows.require-member-unfollow",
            text: `SELECT status
                     FROM community_memberships
                    WHERE community_id = $1
                      AND user_id = $2
                    FOR UPDATE`,
            values: [input.communityId, input.actor.userId],
            readonly: false,
          });
          if (membership.rows.length > 1) return yield* Effect.fail(invalid("unfollow"));
          const membershipRow = row(membership.rows);
          if (membershipRow !== undefined) {
            const parsedMembership = parseMembershipStatus(membershipRow.status);
            if (parsedMembership === null) return yield* Effect.fail(invalid("unfollow"));
            if (parsedMembership === "member") {
              return yield* Effect.fail(
                new CommunityRepositoryError({ operation: "unfollow", reason: "constraint" }),
              );
            }
          }

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
          if (count.rows.length !== 1) return yield* Effect.fail(invalid("unfollow"));
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
