import {
  listPersonaSongs,
  type SongLibraryStore,
} from "@pirate/application/use-cases/song-library";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";

export function makeSongLibraryHandlers(
  store: SongLibraryStore,
): Readonly<Record<"ListPersonaSongs" | "GetTrendingSongs", EndpointHandler>> {
  return {
    ListPersonaSongs: async (request) => {
      const principal = request.principal;
      if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
        throw new AuthError({ message: "Authentication required" });
      const path = request.params as { personaId: string };
      const query = request.query as { cursor?: string };
      return Effect.runPromise(
        listPersonaSongs(
          {
            accountId: principal.subject,
            personaId: path.personaId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          store,
        ),
      );
    },
    GetTrendingSongs: async () => ({
      songs: await Effect.runPromise(store.trending()),
      window_days: 7,
    }),
  };
}
