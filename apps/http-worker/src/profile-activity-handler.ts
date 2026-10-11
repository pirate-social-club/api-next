import {
  getPublicProfileActivity,
  type ProfileActivityStore,
} from "@pirate/application/use-cases/profile-activity";
import { Effect } from "effect";
import type { EndpointHandler } from "./transport.ts";

export function makeProfileActivityHandler(
  store: ProfileActivityStore,
  contentStore: Parameters<typeof getPublicProfileActivity>[2],
): EndpointHandler {
  return (request) => {
    const path = request.params as { personaId: string };
    const query = request.query as {
      surface?: "overview" | "posts" | "comments";
      cursor?: string;
      locale?: string;
    };
    const principal = request.principal;
    const viewerId =
      principal !== null && (principal.kind === "user" || principal.kind === "admin")
        ? principal.subject
        : undefined;
    return Effect.runPromise(
      getPublicProfileActivity(
        { ...path, ...query, ...(viewerId === undefined ? {} : { viewerId }) },
        store,
        contentStore,
      ),
    );
  };
}
