import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  SONG_LIBRARY_PAGE_SIZE,
  type SongLibraryStore,
} from "@pirate/application/use-cases/song-library";
import { ActivitySong, InternalError, NotFound, PersonaActivitySong } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

// Existing session records are the source of truth. No page views, purchases or
// client-side save operations can create library entries.
const sessions = (recent: boolean) =>
  [
    ["study_sessions", "post_id", "study", "GREATEST(created_at, completed_at)"],
    [
      "study_sessions_v2",
      "post_id",
      "study",
      "GREATEST(created_at, completed_at, current_presented_at)",
    ],
    ["karaoke_sessions", "post_id", "karaoke", "GREATEST(created_at, completed_at)"],
    ["dance_sessions", "song_post_id", "dance", "GREATEST(created_at, terminal_at)"],
  ]
    .map(
      ([
        table,
        post,
        activity,
        at,
      ]) => `SELECT account_id, persona_id, community_id, ${post} AS post_id,
  '${activity}'::text AS activity, ${recent ? "created_at" : at} AS at FROM ${table}
  WHERE ${recent ? "created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days' AND created_at <= CURRENT_TIMESTAMP" : "account_id = $1 AND persona_id = $2"}`,
    )
    .join(" UNION ALL ");

const songColumns = `p.community_id, p.post_id, COALESCE(p.title, 'Untitled song') AS title,
  public_persona_projection(p.author_persona_id)->>'display_name' AS artist`;
const visibleSong = `c.status = 'active' AND p.status = 'published' AND p.post_type = 'song'`;
const failure = () => new InternalError({ message: "Song collection could not be loaded" });

export function makeControlPlaneSongLibraryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): SongLibraryStore {
  return {
    list: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const owner = yield* db.execute<{ persona_id: string }>({
          label: "song-library.owner",
          text: `SELECT persona_id FROM personas JOIN users ON users.user_id = personas.account_id WHERE persona_id = $2 AND account_id = $1 AND personas.status = 'active' AND users.status = 'active'`,
          values: [input.accountId, input.personaId],
          readonly: true,
        });
        if (owner.rows.length !== 1) return yield* new NotFound({ message: "Persona not found" });
        const result = yield* db.execute({
          label: "song-library.list",
          text: `WITH sessions AS (${sessions(false)}), history AS (
          SELECT community_id, post_id, MAX(at) AS at, array_agg(DISTINCT activity ORDER BY activity) AS activities
          FROM sessions GROUP BY community_id, post_id
        ) SELECT ${songColumns}, h.activities,
          to_char(h.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at
          FROM history h JOIN posts p USING (community_id, post_id) JOIN communities c USING (community_id)
          WHERE ${visibleSong}
          AND EXISTS (SELECT 1 FROM personas owned JOIN users account ON account.user_id=owned.account_id
            WHERE owned.persona_id=$2 AND owned.account_id=$1 AND owned.status='active' AND account.status='active')
          AND can_account_view_content_rating_v1($1, p.content_rating)
          AND (p.visibility='public' OR EXISTS (SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id AND m.user_id=$1 AND m.status='member'))
          AND ($3::timestamptz IS NULL OR (h.at, p.community_id, p.post_id) < ($3::timestamptz, $4::text, $5::text))
          ORDER BY h.at DESC, p.community_id DESC, p.post_id DESC LIMIT $6`,
          values: [
            input.accountId,
            input.personaId,
            input.cursor?.at ?? null,
            input.cursor?.community_id ?? null,
            input.cursor?.post_id ?? null,
            SONG_LIBRARY_PAGE_SIZE + 1,
          ],
          readonly: true,
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(PersonaActivitySong))(result.rows);
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) => (error instanceof NotFound ? error : failure())),
      ),
    trending: () =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "song-library.trending",
          text: `WITH sessions AS (${sessions(true)}), ranking AS (
          SELECT s.community_id, s.post_id, COUNT(DISTINCT s.account_id) AS participants, MAX(s.at) AS latest
          FROM sessions s JOIN personas owner ON owner.persona_id=s.persona_id AND owner.account_id=s.account_id AND owner.status='active'
          JOIN users account ON account.user_id=s.account_id AND account.status='active'
          GROUP BY s.community_id, s.post_id HAVING COUNT(DISTINCT s.account_id) >= 3
        ) SELECT ${songColumns} FROM ranking r JOIN posts p USING (community_id, post_id) JOIN communities c USING (community_id)
          WHERE ${visibleSong} AND p.visibility='public' AND p.content_rating='general'
          ORDER BY r.participants DESC, r.latest DESC, p.community_id DESC, p.post_id DESC LIMIT 12`,
          values: [],
          readonly: true,
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(ActivitySong))(result.rows);
      }).pipe(Effect.provide(runtime), Effect.mapError(failure)),
  };
}
