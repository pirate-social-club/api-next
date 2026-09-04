import type { Client } from "pg";

export async function insertActiveCommunityMembershipFixture(
  admin: Pick<Client, "query">,
  input: Readonly<{
    communityId: string;
    membershipId: string;
    userId: string;
    joinedAt?: string;
  }>,
): Promise<void> {
  const joinedAt = input.joinedAt ?? new Date().toISOString();
  await admin.query(
    `WITH inserted_membership AS (
       INSERT INTO community_memberships (
         community_id, membership_id, user_id, status, joined_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'member', $4::timestamptz, $4::timestamptz, $4::timestamptz)
       RETURNING community_id, user_id
     )
     INSERT INTO community_follows (
       community_follow_id, community_id, user_id, status,
       unfollowed_at, created_at, updated_at
     )
     SELECT $5, community_id, user_id, 'active', NULL, $4::timestamptz, $4::timestamptz
       FROM inserted_membership`,
    [
      input.communityId,
      input.membershipId,
      input.userId,
      joinedAt,
      `follow_fixture_${crypto.randomUUID()}`,
    ],
  );
}
