import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { CommunityNavigationStore } from "@pirate/application/use-cases/community-navigation";
import { BadRequest, InternalError, NavigationCommunityV1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const item = `jsonb_build_object('community_id',c.community_id,'display_name',c.display_name,
  'resource_href','/c/'||c.community_id,'member_count',COALESCE(m.members,0)) AS item`;
const members = `LEFT JOIN (SELECT community_id,COUNT(*) AS members FROM community_memberships
  WHERE status='member' GROUP BY community_id) m ON m.community_id=c.community_id`;
const allowed = `c.status='active' AND EXISTS (SELECT 1 FROM community_role_assignments a
  WHERE a.community_id=c.community_id AND a.account_id=$1 AND a.status='active')
  AND has_community_moderation_capability_v1($1,c.community_id,'moderation.view')`;

export const communityNavigationStatements = {
  popular: `SELECT ${item} FROM communities c ${members} WHERE c.status='active'
    ORDER BY COALESCE(m.members,0) DESC,c.community_id ASC LIMIT $1`,
  cursor: `SELECT c.community_id FROM communities c WHERE c.community_id=$2 AND ${allowed}`,
  moderated: `SELECT ${item} FROM communities c ${members} WHERE ${allowed}
    AND ($2::text IS NULL OR c.community_id>$2) ORDER BY c.community_id ASC LIMIT 101`,
} as const;

const failure = (cause: unknown) =>
  new InternalError({ message: "Community navigation could not be loaded", cause });

export function makeControlPlaneCommunityNavigationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): CommunityNavigationStore {
  return {
    popular: (limit) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<{ item: unknown }>({
          label: "community-navigation.popular",
          text: communityNavigationStatements.popular,
          values: [limit],
          readonly: true,
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(NavigationCommunityV1))(
          result.rows.map((row) => row.item),
        );
      }).pipe(Effect.provide(runtime), Effect.mapError(failure)),
    moderated: (accountId, cursor) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            if (cursor !== undefined) {
              const valid = yield* tx.execute({
                label: "community-navigation.cursor",
                text: communityNavigationStatements.cursor,
                values: [accountId, cursor],
                readonly: true,
              });
              if (valid.rows.length !== 1)
                return yield* new BadRequest({ message: "Invalid moderation community cursor" });
            }
            const result = yield* tx.execute<{ item: unknown }>({
              label: "community-navigation.moderated",
              text: communityNavigationStatements.moderated,
              values: [accountId, cursor ?? null],
              readonly: true,
            });
            return yield* Schema.decodeUnknownEffect(Schema.Array(NavigationCommunityV1))(
              result.rows.map((row) => row.item),
            );
          }),
        );
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) => (error instanceof BadRequest ? error : failure(error))),
      ),
  };
}
