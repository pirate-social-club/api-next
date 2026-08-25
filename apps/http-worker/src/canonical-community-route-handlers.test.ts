import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeCanonicalCommunityRouteHandlers } from "./canonical-community-route-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const canonicalRoute = {
  family: "hns" as const,
  root_label: "xn--mnchen-3ya",
  root_label_display: "münchen",
  path_segment: "xn--mnchen-3ya",
  href: "/c/xn--mnchen-3ya",
  app_host: null,
};

function worker(observed: string[]) {
  return createHttpWorker({
    handlers: makeCanonicalCommunityRouteHandlers({
      canonicalCommunityRouteStore: {
        resolveCanonicalRoute: ({ path_segment }) => {
          observed.push(path_segment);
          return Effect.succeed({
            community_id: "community-route-hns",
            canonical_route: canonicalRoute,
          });
        },
      },
    }),
  });
}

describe("canonical community route HTTP adapter", () => {
  test("serves the exact canonical ACE path", async () => {
    const observed: string[] = [];
    const response = await worker(observed).request("http://worker.test/c/xn--mnchen-3ya");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      community_id: "community-route-hns",
      canonical_route: canonicalRoute,
    });
    expect(observed).toEqual(["xn--mnchen-3ya"]);
  });

  test("rejects encoded, double-encoded, case, and Unicode aliases before storage", async () => {
    const observed: string[] = [];
    const app = worker(observed);
    for (const alias of [
      "%78n--mnchen-3ya",
      "%2578n--mnchen-3ya",
      "XN--MNCHEN-3YA",
      "m%C3%BCnchen",
    ]) {
      const response = await app.request(`http://worker.test/c/${alias}`);
      expect(response.status).toBe(400);
    }
    expect(observed).toEqual([]);
  });
});
