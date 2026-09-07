import { expect, test } from "bun:test";
import { Effect } from "effect";
import { listPersonaSongs, type SongLibraryStore } from "./song-library.ts";

const at = "2026-09-08T00:00:00.123456Z";
test("bounded keyset pagination preserves microseconds and rejects a cursor for another persona", async () => {
  let reads = 0;
  const store: SongLibraryStore = {
    list: (input) => {
      reads++;
      return Effect.succeed(
        Array.from({ length: input.cursor ? 1 : 26 }, (_, i) => ({
          community_id: "crew",
          post_id: `song-${i}`,
          title: "Song",
          artist: null,
          activities: ["study"] as const,
          last_activity_at: at,
        })),
      );
    },
    trending: () => Effect.succeed([]),
  };
  const page = await Effect.runPromise(
    listPersonaSongs({ accountId: "account", personaId: "persona" }, store),
  );
  expect(page.songs).toHaveLength(25);
  if (page.next_cursor === null) throw new Error("Missing next cursor");
  expect(JSON.parse(page.next_cursor)).toEqual({
    persona_id: "persona",
    community_id: "crew",
    post_id: "song-24",
    at,
  });
  const next = await Effect.runPromise(
    listPersonaSongs(
      { accountId: "account", personaId: "persona", cursor: page.next_cursor },
      store,
    ),
  );
  expect(next.next_cursor).toBeNull();
  for (const cursor of ["garbage", page.next_cursor.replace('"persona"', '"other"')]) {
    await expect(
      Effect.runPromise(
        listPersonaSongs({ accountId: "account", personaId: "persona", cursor }, store),
      ),
    ).rejects.toMatchObject({ _tag: "BadRequest" });
  }
  expect(reads).toBe(2);
});
