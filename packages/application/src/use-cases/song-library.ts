import {
  type ActivitySong,
  BadRequest,
  type InternalError,
  type NotFound,
  type PersonaActivitySong,
  PersonaIdV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";

const Cursor = Schema.Struct({
  persona_id: PersonaIdV1,
  community_id: PersonaIdV1,
  post_id: PersonaIdV1,
  at: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)),
});
export type SongLibraryCursor = Schema.Schema.Type<typeof Cursor>;
export interface SongLibraryStore {
  list: (input: {
    accountId: string;
    personaId: string;
    cursor: SongLibraryCursor | null;
  }) => Effect.Effect<readonly PersonaActivitySong[], InternalError | NotFound>;
  trending: () => Effect.Effect<readonly ActivitySong[], InternalError>;
}
export const SONG_LIBRARY_PAGE_SIZE = 25;

export const listPersonaSongs = Effect.fn("listPersonaSongs")(function* (
  input: { accountId: string; personaId: string; cursor?: string },
  store: SongLibraryStore,
) {
  const cursor = yield* Effect.try({
    try: () => {
      if (input.cursor === undefined) return null;
      const parsed = Schema.decodeUnknownSync(Cursor)(JSON.parse(input.cursor));
      if (parsed.persona_id !== input.personaId || !isCursorTimestamp(parsed.at))
        throw new Error("invalid cursor");
      return parsed;
    },
    catch: () => new BadRequest({ message: "Invalid song library cursor" }),
  });
  const rows = yield* store.list({
    accountId: input.accountId,
    personaId: input.personaId,
    cursor,
  });
  const songs = rows.slice(0, SONG_LIBRARY_PAGE_SIZE);
  const last = songs.at(-1);
  const next_cursor =
    rows.length > SONG_LIBRARY_PAGE_SIZE && last
      ? JSON.stringify({
          persona_id: input.personaId,
          community_id: last.community_id,
          post_id: last.post_id,
          at: last.last_activity_at,
        })
      : null;
  return { songs, next_cursor };
});

/** A cursor carries the exact microsecond UTC timestamp this read emits. Reject
 * any other shape, and any calendar-invalid date that Date.parse would roll
 * over, so a tampered cursor is a 400 rather than a database cast failure. */
function isCursorTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)) return false;
  const millis = Date.parse(`${value.slice(0, 23)}Z`);
  return (
    Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 23) === value.slice(0, 23)
  );
}
