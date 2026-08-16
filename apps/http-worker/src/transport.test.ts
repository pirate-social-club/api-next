import { describe, expect, it } from "bun:test";
import { createHttpWorker } from "./transport.ts";

describe("contracts-generated HTTP worker", () => {
  it("serves the health contract without a product handler", async () => {
    const response = await createHttpWorker().request("http://worker.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("decodes query values before an uninstalled handler can run", async () => {
    const response = await createHttpWorker().request(
      "http://worker.test/feed/home/public?sort=unsupported",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "bad_request",
      details: { location: "query" },
    });
  });

  it("decodes request bodies before an uninstalled handler can run", async () => {
    const response = await createHttpWorker().request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 0 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "bad_request",
      details: { location: "body" },
    });
  });

  it("returns the frozen error envelope for a route without a product handler", async () => {
    const response = await createHttpWorker().request("http://worker.test/posts/post_1");

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "not_implemented",
      message: "Endpoint handler is not installed",
    });
  });

  it("passes decoded contract input to an installed handler", async () => {
    let received: unknown;
    const app = createHttpWorker({
      handlers: {
        GetPublicHomeFeed: (input) => {
          received = input.query;
          return { items: [], top_communities: [], next_cursor: null };
        },
      },
    });

    const response = await app.request("http://worker.test/feed/home/public?sort=best");

    expect(response.status).toBe(200);
    expect(received).toEqual({ sort: "best" });
    expect(await response.json()).toEqual({ items: [], top_communities: [], next_cursor: null });
  });
});
