/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const document = {
  community: {
    id: "community-workerd",
    object: "community_preview" as const,
    route_slug: "music",
    display_name: "Music",
    membership_mode: "open" as const,
    human_verification_lane: null,
    moderators: [],
    membership_gate_summaries: [],
    rules: [],
    created: 1,
  },
  items: [],
  next_cursor: null,
};

describe("exact raw path parameters in workerd", () => {
  it("rejects encoded and Unicode aliases while leaving query decoding alone", async () => {
    let calls = 0;
    const app = createHttpWorker({
      handlers: {
        GetPublicCommunityThreads: () => {
          calls += 1;
          return document;
        },
      },
    });

    const exact = await app.request(
      "https://worker.test/public-communities/music/feed?surface=threads&sort=new&locale=en%2DUS",
    );
    expect(exact.status).toBe(200);

    for (const alias of ["%6Dusic", "%256Dusic", "%40music", "ｍｕｓｉｃ", "ⓜⓤⓢⓘⓒ"]) {
      const response = await app.request(
        `https://worker.test/public-communities/${alias}/feed?surface=threads&sort=new`,
      );
      expect(response.status, alias).toBe(400);
    }
    expect(calls).toBe(1);
  });
});
