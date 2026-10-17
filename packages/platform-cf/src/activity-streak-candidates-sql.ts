/** One admitted population for public ranks and private viewer standing.
 * Parameter markers are owned by the calling query, never request SQL text.
 */
export const activityStreakCandidatesSql = (
  scope: "song" | "community",
  parameters: {
    readonly communityId: "$1" | "$2";
    readonly postId: "$2" | "$3";
    readonly readAt: "$2" | "$3" | "$4";
  },
): string => `SELECT streak.community_id,streak.account_id,streak.current_count,
    streak.best_count,streak.started_day,streak.last_day,streak.total_days,
    presentation.persona_id,profile.display_name,profile.avatar_ref
  FROM ${scope === "song" ? "song_streaks" : "community_streaks"} AS streak
  JOIN persona_activity_presentations AS presentation
    ON presentation.community_id=streak.community_id
    AND presentation.account_id=streak.account_id
  JOIN persona_profiles AS profile ON profile.persona_id=presentation.persona_id
  WHERE streak.community_id=${parameters.communityId}
    ${scope === "song" ? `AND streak.post_id=${parameters.postId}` : ""}
    AND streak.active_until_at>${parameters.readAt}::timestamptz
    AND active_activity_persona(streak.account_id,presentation.persona_id,streak.community_id)`;
