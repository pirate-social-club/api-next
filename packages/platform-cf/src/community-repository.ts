import {
  type AccountCommunityMembershipPage,
  type CommunityPreviewDocument,
  CommunityRepositoryError,
  type CommunityRepositoryFailure,
  type CommunityStore,
  type CommunityStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type FollowDocument,
  type JoinDocument,
  type JoinEligibilityDocument,
  type MembershipStatus,
  type UnfollowDocument,
} from "@pirate/application";
import { decodeCommunityCanonicalRouteV2 } from "@pirate/contracts";
import { Effect, type Layer } from "effect";
import {
  CommunityJoinIntentDataInvalid,
  resolveOrIssueCommunityJoinIntent,
} from "./community-join-intent-store.ts";
import {
  type CommunityGateEvaluation,
  CURATED_AGE_GATE_SUMMARY,
  CURATED_HUMAN_GATE_SUMMARY,
  GatesV2CommunityDataInvalid,
  gateEvaluationDetails,
  loadCuratedAgeEvaluation,
  loadCuratedHumanMembershipEvaluation,
  persistEnforceDecision,
} from "./gates-v2-community.ts";
import { PLATFORM_AGE_18_VERIFICATION_INTENT_ID } from "./verification-intent-resolver.ts";

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

type AccountCommunityMembershipRow = {
  readonly community_id: unknown;
  readonly display_name: unknown;
  readonly route_authority_version: unknown;
  readonly membership_status: unknown;
  readonly membership_created_at: unknown;
  readonly cursor_as_of: unknown;
  readonly cursor_created_at: unknown;
  readonly route_family: unknown;
  readonly route_root_label: unknown;
  readonly route_root_label_display: unknown;
  readonly route_path_segment: unknown;
  readonly route_href: unknown;
  readonly route_app_host: unknown;
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
  operation:
    | "membership"
    | "list-memberships"
    | "preview"
    | "eligibility"
    | "join"
    | "follow"
    | "unfollow",
) => new CommunityRepositoryError({ operation, reason: "invalid-row" });

const invalidCursor = () =>
  new CommunityRepositoryError({ operation: "list-memberships", reason: "invalid-cursor" });

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

const generatedId = (kind: "membership" | "follow" | "persona"): string =>
  `${kind}_${globalThis.crypto.randomUUID()}`;

const ACCOUNT_MEMBERSHIP_CURSOR_PREFIX = "acm1.";
const POSTGRES_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;

type AccountMembershipCursor = Readonly<{
  readonly version: 1;
  readonly accountBinding: string;
  readonly asOf: string;
  readonly createdAt: string;
  readonly communityId: string;
}>;

const accountCursorBinding = (userId: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`acm1\u0000${userId}`)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );

const exactPostgresTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = POSTGRES_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;
  const millisecondPrefix = `${match[1]}.${match[2]?.slice(0, 3)}Z`;
  return Number.isFinite(Date.parse(millisecondPrefix)) ? value : null;
};

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): string => {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
};

const encodeAccountMembershipCursor = (cursor: AccountMembershipCursor): string =>
  `${ACCOUNT_MEMBERSHIP_CURSOR_PREFIX}${base64UrlEncode(
    JSON.stringify({
      v: cursor.version,
      u: cursor.accountBinding,
      a: cursor.asOf,
      t: cursor.createdAt,
      c: cursor.communityId,
    }),
  )}`;

const decodeAccountMembershipCursor = (
  value: string | undefined,
  expectedAccountBinding: string,
): AccountMembershipCursor | null => {
  if (value === undefined) return null;
  if (value.length > 1_024 || !value.startsWith(ACCOUNT_MEMBERSHIP_CURSOR_PREFIX)) {
    throw invalidCursor();
  }
  try {
    const parsed: unknown = JSON.parse(
      base64UrlDecode(value.slice(ACCOUNT_MEMBERSHIP_CURSOR_PREFIX.length)),
    );
    if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
    const record = parsed as Record<string, unknown>;
    const asOf = exactPostgresTimestamp(record.a);
    const createdAt = exactPostgresTimestamp(record.t);
    if (
      record.v !== 1 ||
      record.u !== expectedAccountBinding ||
      asOf === null ||
      createdAt === null ||
      createdAt > asOf ||
      typeof record.c !== "string" ||
      !validId(record.c)
    ) {
      throw invalidCursor();
    }
    return {
      version: 1,
      accountBinding: expectedAccountBinding,
      asOf,
      createdAt,
      communityId: record.c,
    };
  } catch (error) {
    if (error instanceof CommunityRepositoryError) throw error;
    throw invalidCursor();
  }
};

const accountMembershipsStatement = (
  userId: string,
  cursor: AccountMembershipCursor | null,
  limit: number,
) =>
  ({
    label: "community.memberships.list-account",
    text: `WITH db_clock AS MATERIALIZED (
           SELECT COALESCE($2::timestamptz, clock_timestamp()) AS now
         )
         SELECT community.community_id,
                community.display_name,
                community.route_authority_version,
                membership.status AS membership_status,
                membership.created_at AS membership_created_at,
                to_char(db_clock.now AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_as_of,
                to_char(membership.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
                route.family AS route_family,
                route.root_label AS route_root_label,
                route.root_label_display AS route_root_label_display,
                route.public_path_segment AS route_path_segment,
                route.public_href AS route_href,
                CASE
                  WHEN route.family = 'hns' AND health.health_status = 'healthy'
                    THEN 'app.' || route.root_label
                  ELSE NULL
                END AS route_app_host
           FROM db_clock
           JOIN community_memberships AS membership
             ON membership.user_id = $1
            AND membership.status = 'member'
            AND membership.created_at <= db_clock.now
           JOIN communities AS community
             ON community.community_id = membership.community_id
            AND community.status = 'active'
           LEFT JOIN LATERAL effective_public_community_route_v2(
             community.community_id,
             db_clock.now
           ) AS route ON TRUE
           LEFT JOIN community_route_app_host_health AS health
             ON health.route_binding_id = route.route_binding_id
            AND health.family = 'hns'
            AND health.health_generation = route.binding_generation
          WHERE ($3::timestamptz IS NULL
            OR membership.created_at > $3::timestamptz
            OR (membership.created_at = $3::timestamptz
                AND community.community_id COLLATE "C" > $4::text COLLATE "C"))
          ORDER BY membership.created_at ASC, community.community_id COLLATE "C" ASC
          LIMIT $5`,
    values: [
      userId,
      cursor?.asOf ?? null,
      cursor?.createdAt ?? null,
      cursor?.communityId ?? null,
      limit + 1,
    ],
    readonly: true,
  }) as const;

type JoinTransactionOutcome =
  | { readonly kind: "joined"; readonly document: JoinDocument }
  | { readonly kind: "gated-rejected"; readonly reason: "membership-required" | "invalid-row" };

const joined = (document: JoinDocument): JoinTransactionOutcome => ({
  kind: "joined",
  document,
});

const joinPersonaConflict = () =>
  new CommunityRepositoryError({ operation: "join", reason: "constraint" });

/**
 * Spec 014 section 10.2: the terminal membership commit resolves exactly one
 * of three server-validated cases — an active owned persona already bound to
 * the target community, a bind-once unbound persona serialized on the persona
 * row, or a new persona minted with its target-community binding in this
 * transaction. A persona bound elsewhere is a typed conflict and no membership
 * row is left behind without an eligible persona. A minted persona follows
 * the additional-persona lifecycle: it is born pending_wallet with its
 * reserved HD index and private profile draft, and becomes an eligible public
 * persona only when the account confirms that wallet.
 */
const resolveJoinPersona = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly communityId: string;
    readonly accountId: string;
    readonly choice: Parameters<CommunityStoreService["join"]>[0]["body"]["persona"];
  }>,
): Effect.Effect<string, CommunityRepositoryFailure> =>
  Effect.gen(function* () {
    if (input.choice === undefined) return yield* Effect.fail(joinPersonaConflict());
    if (input.choice.kind === "create_new") {
      // Serialize wallet-index allocation with the persona creation store.
      yield* transaction.execute({
        label: "community.join.mint-account-lock",
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 14000046))",
        values: [JSON.stringify([input.accountId, "evm"])],
        readonly: false,
      });
      const capacity = yield* transaction.execute<{
        slot_count: string;
        recent_count: string;
      }>({
        label: "community.join.mint-capacity",
        text: `SELECT count(*)::text AS slot_count,
                      count(*) FILTER (
                        WHERE NOT persona.is_first_persona
                          AND assignment.created_at > clock_timestamp() - interval '86400 seconds'
                      )::text AS recent_count
                 FROM persona_wallet_assignments AS assignment
                 JOIN personas AS persona USING (persona_id)
                WHERE assignment.account_id = $1
                  AND assignment.chain_account_kind = 'evm'`,
        values: [input.accountId],
        readonly: true,
      });
      const capacityRow = capacity.rows[0];
      if (
        capacityRow === undefined ||
        Number(capacityRow.slot_count) >= 10 ||
        Number(capacityRow.recent_count) >= 3
      ) {
        return yield* Effect.fail(joinPersonaConflict());
      }
      const next = yield* transaction.execute<{ hd_wallet_index: string }>({
        label: "community.join.mint-allocate-index",
        text: `SELECT (COALESCE(max(hd_wallet_index), -1) + 1)::text AS hd_wallet_index
                 FROM persona_wallet_assignments
                WHERE account_id = $1 AND chain_account_kind = 'evm'`,
        values: [input.accountId],
        readonly: true,
      });
      const hdWalletIndex = Number(next.rows[0]?.hd_wallet_index);
      if (!Number.isSafeInteger(hdWalletIndex) || hdWalletIndex < 0) {
        return yield* Effect.fail(invalid("join"));
      }
      const personaId = generatedId("persona");
      yield* transaction.execute({
        label: "community.join.mint-persona",
        text: `INSERT INTO personas (
                 persona_id, account_id, status, is_first_persona, created_at, retired_at
               ) VALUES ($1, $2, 'pending_wallet', false, clock_timestamp(), NULL)`,
        values: [personaId, input.accountId],
        readonly: false,
      });
      yield* transaction.execute({
        label: "community.join.mint-persona-pending-profile",
        text: `INSERT INTO persona_pending_profiles (
                 persona_id, display_name, avatar_ref, cover_ref, bio,
                 preferred_locale, created_at
               ) VALUES ($1, NULL, NULL, NULL, NULL, NULL, clock_timestamp())`,
        values: [personaId],
        readonly: false,
      });
      yield* transaction.execute({
        label: "community.join.mint-persona-wallet-reservation",
        text: `INSERT INTO persona_wallet_assignments (
                 assignment_id, persona_id, account_id, chain_account_kind,
                 privy_wallet_id, hd_wallet_index, address, status,
                 reservation_idempotency_key, assigned_at, tombstoned_at,
                 created_at, updated_at
               ) VALUES ($1, $2, $3, 'evm', NULL, $4, NULL, 'pending', $5, NULL, NULL,
                         clock_timestamp(), clock_timestamp())`,
        values: [
          `persona_wallet_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
          personaId,
          input.accountId,
          hdWalletIndex,
          `join-${personaId}`,
        ],
        readonly: false,
      });
      yield* transaction.execute({
        label: "community.join.mint-persona-binding",
        text: `INSERT INTO persona_community_bindings (
                 persona_id, account_id, community_id, binding_source
               ) VALUES ($1, $2, $3, 'first_membership')`,
        values: [personaId, input.accountId, input.communityId],
        readonly: false,
      });
      return personaId;
    }
    const personaId = input.choice.persona_id;
    if (!validId(personaId)) return yield* Effect.fail(invalid("join"));
    // The persona-row lock serializes bind-once: a concurrent join of the
    // same persona to another community cannot also win.
    const locked = yield* transaction.execute<{ readonly persona_id: unknown }>({
      label: "community.join.lock-persona",
      text: `SELECT persona_id
               FROM personas
              WHERE account_id = $1
                AND persona_id = $2
                AND status = 'active'
              FOR UPDATE`,
      values: [input.accountId, personaId],
      readonly: false,
    });
    if (locked.rows.length !== 1 || locked.rows[0]?.persona_id !== personaId) {
      return yield* Effect.fail(joinPersonaConflict());
    }
    const binding = yield* transaction.execute<{ readonly community_id: unknown }>({
      label: "community.join.read-persona-binding",
      text: `SELECT community_id
               FROM persona_community_bindings
              WHERE persona_id = $1`,
      values: [personaId],
      readonly: true,
    });
    if (binding.rows.length > 1) return yield* Effect.fail(invalid("join"));
    const boundCommunity =
      binding.rows.length === 1 ? asPersistedId(row(binding.rows)?.community_id) : null;
    if (boundCommunity === input.communityId) return personaId;
    if (boundCommunity !== null) return yield* Effect.fail(joinPersonaConflict());
    yield* transaction
      .execute({
        label: "community.join.bind-persona",
        text: `INSERT INTO persona_community_bindings (
               persona_id, account_id, community_id, binding_source
             ) VALUES ($1, $2, $3, 'first_membership')`,
        values: [personaId, input.accountId, input.communityId],
        readonly: false,
      })
      .pipe(
        Effect.catchIf(
          (error: ControlPlaneError) =>
            error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505",
          () => joinPersonaConflict(),
        ),
      );
    return personaId;
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
  readonly listAccountMemberships: (
    input: Parameters<CommunityStoreService["listAccountMemberships"]>[0],
  ) => Effect.Effect<AccountCommunityMembershipPage, CommunityRepositoryFailure, ControlPlaneDb>;
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
  const listAccountMemberships: CommunityRepository["listAccountMemberships"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.userId)) return yield* Effect.fail(invalid("list-memberships"));
      const limit = input.query.limit === undefined ? 50 : Number(input.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return yield* Effect.fail(invalidCursor());
      }
      const accountBinding = yield* accountCursorBinding(input.userId);
      let cursor: AccountMembershipCursor | null;
      try {
        cursor = decodeAccountMembershipCursor(input.query.cursor, accountBinding);
      } catch (error) {
        return yield* Effect.fail(
          error instanceof CommunityRepositoryError ? error : invalidCursor(),
        );
      }

      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<AccountCommunityMembershipRow>(
        accountMembershipsStatement(input.userId, cursor, limit),
      );
      const pageRows = result.rows.slice(0, limit);
      const items: AccountCommunityMembershipPage["items"][number][] = [];
      let pageAsOf: string | null = null;
      let lastCursor: AccountMembershipCursor | null = null;
      for (const membership of pageRows) {
        const communityId = asPersistedId(membership.community_id);
        const displayName = asString(membership.display_name);
        const routeAuthorityVersion = asString(membership.route_authority_version);
        const createdAt = exactPostgresTimestamp(membership.cursor_created_at);
        const asOf = exactPostgresTimestamp(membership.cursor_as_of);
        if (
          communityId === null ||
          displayName === null ||
          displayName.length === 0 ||
          displayName.includes("\u0000") ||
          (routeAuthorityVersion !== "legacy_slug_v1" &&
            routeAuthorityVersion !== "route_v1" &&
            routeAuthorityVersion !== "optional_route_v2") ||
          membership.membership_status !== "member" ||
          createdAt === null ||
          asOf === null ||
          createdAt > asOf ||
          (pageAsOf !== null && pageAsOf !== asOf)
        ) {
          return yield* Effect.fail(invalid("list-memberships"));
        }
        pageAsOf = asOf;
        lastCursor = { version: 1, accountBinding, asOf, createdAt, communityId };

        let canonicalRoute: AccountCommunityMembershipPage["items"][number]["canonical_route"] =
          null;
        if (membership.route_path_segment !== null) {
          try {
            canonicalRoute = decodeCommunityCanonicalRouteV2({
              family: membership.route_family,
              root_label: membership.route_root_label,
              root_label_display: membership.route_root_label_display,
              path_segment: membership.route_path_segment,
              href: membership.route_href,
              app_host: membership.route_app_host,
            });
          } catch {
            return yield* Effect.fail(invalid("list-memberships"));
          }
        } else if (
          membership.route_family !== null ||
          membership.route_root_label !== null ||
          membership.route_root_label_display !== null ||
          membership.route_href !== null ||
          membership.route_app_host !== null
        ) {
          return yield* Effect.fail(invalid("list-memberships"));
        }

        items.push({
          object: "account_community_membership",
          community_id: communityId,
          display_name: displayName,
          resource_href: routeAuthorityVersion === "optional_route_v2" ? `/c/${communityId}` : null,
          canonical_route: canonicalRoute,
          membership_status: "member",
          can_post: true,
        });
      }

      const nextCursor =
        result.rows.length > limit && lastCursor !== null
          ? encodeAccountMembershipCursor(lastCursor)
          : null;
      if (nextCursor !== null && nextCursor.length > 1_024) {
        return yield* Effect.fail(invalid("list-memberships"));
      }
      return { object: "account_community_membership_page", items, next_cursor: nextCursor };
    });

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
        membership_gate_summaries:
          mode === "gated" && verification === "very" ? [CURATED_HUMAN_GATE_SUMMARY] : [],
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
      const humanGate = mode === "gated" && verification === "very";
      if (status === "banned") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          ...(humanGate ? { preferred_verification_provider: "very.web" as const } : {}),
          joinable_now: false,
          status: "banned" as const,
          membership_gate_summaries: humanGate ? [CURATED_HUMAN_GATE_SUMMARY] : [],
          failure_reason: "banned" as const,
          next_action: { kind: "blocked" as const, reason: "banned" as const },
        };
      }
      if (status === "member") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          ...(humanGate ? { preferred_verification_provider: "very.web" as const } : {}),
          joinable_now: false,
          status: "already_joined" as const,
          membership_gate_summaries: humanGate ? [CURATED_HUMAN_GATE_SUMMARY] : [],
          next_action: { kind: "none" as const, reason: "already_joined" as const },
        };
      }
      if (status === "pending") {
        return {
          community: id,
          membership_mode: mode,
          human_verification_lane: verification,
          ...(humanGate ? { preferred_verification_provider: "very.web" as const } : {}),
          joinable_now: false,
          status: "pending_request" as const,
          membership_gate_summaries: humanGate ? [CURATED_HUMAN_GATE_SUMMARY] : [],
          next_action: {
            kind: "wait" as const,
            reason_code: "membership_pending" as const,
          },
        };
      }
      if (mode === "gated") {
        if (verification === "very") {
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const lockedCommunity = yield* transaction.execute<JoinCommunityRow>({
                label: "community.memberships.lock-human-eligibility-community",
                text: `SELECT community_id, membership_mode, human_verification_lane
                         FROM communities
                        WHERE community_id = $1
                          AND status = 'active'
                        FOR UPDATE`,
                values: [input.communityId],
                readonly: false,
              });
              if (lockedCommunity.rows.length !== 1) {
                return yield* Effect.fail(invalid("eligibility"));
              }
              const locked = lockedCommunity.rows[0];
              if (
                locked === undefined ||
                locked.community_id !== input.communityId ||
                locked.membership_mode !== "gated" ||
                locked.human_verification_lane !== "very"
              ) {
                return yield* Effect.fail(invalid("eligibility"));
              }
              const membership = yield* transaction.execute<MembershipRow>({
                label: "community.memberships.lock-human-eligibility-membership",
                text: `SELECT status
                         FROM community_memberships
                        WHERE community_id = $1
                          AND user_id = $2
                        FOR UPDATE`,
                values: [input.communityId, input.userId],
                readonly: false,
              });
              if (membership.rows.length > 1) {
                return yield* Effect.fail(invalid("eligibility"));
              }
              const lockedStatus =
                membership.rows[0] === undefined
                  ? "missing"
                  : parseMembershipStatus(membership.rows[0].status);
              if (lockedStatus === null) return yield* Effect.fail(invalid("eligibility"));
              if (lockedStatus === "banned") {
                return {
                  community: id,
                  membership_mode: mode,
                  human_verification_lane: verification,
                  preferred_verification_provider: "very.web" as const,
                  joinable_now: false,
                  status: "banned" as const,
                  membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                  failure_reason: "banned" as const,
                  next_action: { kind: "blocked" as const, reason: "banned" as const },
                };
              }
              if (lockedStatus === "member") {
                return {
                  community: id,
                  membership_mode: mode,
                  human_verification_lane: verification,
                  preferred_verification_provider: "very.web" as const,
                  joinable_now: false,
                  status: "already_joined" as const,
                  membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                  next_action: { kind: "none" as const, reason: "already_joined" as const },
                };
              }
              if (lockedStatus === "pending") {
                return {
                  community: id,
                  membership_mode: mode,
                  human_verification_lane: verification,
                  preferred_verification_provider: "very.web" as const,
                  joinable_now: false,
                  status: "pending_request" as const,
                  membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                  next_action: {
                    kind: "wait" as const,
                    reason_code: "membership_pending" as const,
                  },
                };
              }

              const evaluation = yield* loadCuratedHumanMembershipEvaluation(transaction, {
                communityId: input.communityId,
                userId: input.userId,
                lock: true,
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
                  preferred_verification_provider: "very.web" as const,
                  joinable_now: true,
                  status: "joinable" as const,
                  membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                  gate_evaluation: gateEvaluation,
                  next_action: { kind: "join" as const },
                };
              }
              if (evaluation.outcome === "needs_evidence") {
                const action = yield* resolveOrIssueCommunityJoinIntent(transaction, {
                  communityId: input.communityId,
                  userId: input.userId,
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof CommunityJoinIntentDataInvalid
                      ? invalid("eligibility")
                      : error,
                  ),
                );
                return {
                  community: id,
                  membership_mode: mode,
                  human_verification_lane: verification,
                  preferred_verification_provider: "very.web" as const,
                  joinable_now: false,
                  status: "verification_required" as const,
                  membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                  missing_capabilities: ["human_verification" as const],
                  suggested_verification_provider: "very.web" as const,
                  suggested_verification_intent: "community_join" as const,
                  failure_reason: "missing_verification" as const,
                  gate_evaluation: gateEvaluation,
                  next_action:
                    action.kind === "wait"
                      ? ({
                          kind: "wait" as const,
                          reason_code: "verification_pending" as const,
                        } as const)
                      : ({
                          kind: "start_verification" as const,
                          provider_id: "very.web" as const,
                          intent_id: action.intentId,
                        } as const),
                };
              }
              return {
                community: id,
                membership_mode: mode,
                human_verification_lane: verification,
                preferred_verification_provider: "very.web" as const,
                joinable_now: false,
                status: "gate_failed" as const,
                membership_gate_summaries: [CURATED_HUMAN_GATE_SUMMARY],
                failure_reason: "unsupported" as const,
                gate_evaluation: gateEvaluation,
                next_action: { kind: "blocked" as const, reason: "gate_failed" as const },
              };
            }),
          );
        }
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
            next_action: { kind: "join" as const },
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
            next_action: {
              kind: "start_verification" as const,
              provider_id: "zkpassport" as const,
              intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
            },
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
          next_action: { kind: "blocked" as const, reason: "gate_failed" as const },
        };
      }
      return {
        community: id,
        membership_mode: mode,
        human_verification_lane: verification,
        joinable_now: true,
        status: mode === "request" ? ("requestable" as const) : ("joinable" as const),
        membership_gate_summaries: [],
        next_action:
          mode === "request"
            ? ({ kind: "request_membership" as const } as const)
            : ({ kind: "join" as const } as const),
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
            text: `SELECT community_id, membership_mode, human_verification_lane
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
          const verification =
            community === undefined
              ? undefined
              : verificationLane(community.human_verification_lane);
          if (community === undefined) {
            return yield* Effect.fail(
              new CommunityRepositoryError({ operation: "join", reason: "not-found" }),
            );
          }
          if (
            communityId === null ||
            mode === null ||
            verification === undefined ||
            communityId !== input.communityId
          ) {
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
            let evaluation: CommunityGateEvaluation;
            if (verification === "very") {
              evaluation = yield* loadCuratedHumanMembershipEvaluation(transaction, {
                communityId: input.communityId,
                userId: input.actor.userId,
                lock: true,
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof GatesV2CommunityDataInvalid ? invalid("join") : error,
                ),
              );
            } else {
              evaluation = yield* loadCuratedAgeEvaluation(transaction, {
                communityId: input.communityId,
                userId: input.actor.userId,
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof GatesV2CommunityDataInvalid ? invalid("join") : error,
                ),
              );
            }
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

          if (mode === "request" && input.body.persona !== undefined) {
            // A request-mode intent never pre-binds identity (spec 014
            // section 10.2); the choice is resolved at approval instead.
            return yield* Effect.fail(joinPersonaConflict());
          }

          const status = mode === "request" ? "pending" : "member";
          // The persona choice resolves only at the terminal membership
          // commit, after gate evaluation and before any membership write.
          const joinPersonaId =
            status === "member"
              ? yield* resolveJoinPersona(transaction, {
                  communityId: input.communityId,
                  accountId: input.actor.userId,
                  choice: input.body.persona,
                })
              : undefined;
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
            ...(joinPersonaId === undefined ? {} : { persona_id: joinPersonaId }),
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

  return {
    listAccountMemberships,
    membershipStatus,
    getPreview,
    getJoinEligibility,
    join,
    follow,
    unfollow,
  };
}

/** Bind the repository's ControlPlaneDb requirement to a request-scoped Layer. */
export function makeControlPlaneCommunityStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityStore["Service"] {
  const repository = makeControlPlaneCommunityRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    listAccountMemberships: (input) => provide(repository.listAccountMemberships(input)),
    membershipStatus: (input) => provide(repository.membershipStatus(input)),
    getPreview: (input) => provide(repository.getPreview(input)),
    getJoinEligibility: (input) => provide(repository.getJoinEligibility(input)),
    join: (input) => provide(repository.join(input)),
    follow: (input) => provide(repository.follow(input)),
    unfollow: (input) => provide(repository.unfollow(input)),
  };
}
