import { describe, expect, test } from "bun:test";
import { GetPublicCommunityThreads, NotFound } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makePublicCommunityThreadsHandler } from "./public-community-threads-handler.ts";
import type { DecodedRequest } from "./transport.ts";

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: undefined,
  params: { communityRef: "alpha-community" },
  query: { surface: "threads", sort: "new", locale: "ka" },
  principal: null,
  ...overrides,
});

describe("public community threads handler", () => {
  test("passes the raw ref and closed query to the use case", async () => {
    let observed: unknown;
    const handler = makePublicCommunityThreadsHandler({
      publicCommunityThreadsStore: {
        listPublicCommunityThreads: (input) => {
          observed = input;
          return Effect.succeed(null);
        },
      },
    });

    await expect(handler(request())).rejects.toBeInstanceOf(NotFound);
    expect(observed).toEqual({
      communityRef: "alpha-community",
      slugCandidate: "alpha-community",
      query: { surface: "threads", sort: "new", locale: "ka" },
    });
  });

  test("returns the repository document without adding viewer state", async () => {
    const document = Schema.decodeUnknownSync(GetPublicCommunityThreads.response)({
      community: {
        id: "community-a",
        object: "community_preview",
        route_slug: "alpha",
        display_name: "Alpha",
        membership_mode: "open",
        human_verification_lane: null,
        moderators: [],
        membership_gate_summaries: [],
        rules: [],
        created: 1,
      },
      items: [],
      next_cursor: null,
    });
    const handler = makePublicCommunityThreadsHandler({
      publicCommunityThreadsStore: {
        listPublicCommunityThreads: () => Effect.succeed(document),
      },
    });

    await expect(handler(request())).resolves.toEqual(document);
  });
});
