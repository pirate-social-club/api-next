import { describe, expect, test } from "bun:test";
import { AuthError } from "../../../packages/contracts/src/errors.ts";
import { makeSharedSongMegapotParticipationHandler } from "./shared-song-megapot-participation-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const root = "/communities/test-community/posts/test-song/megapot-participation";
const headers = { cookie: "__Host-pirate_session=fictional", origin: "https://app.pirate.test" };
function fixture(
  options: { enabled?: boolean; anonymous?: boolean; missing?: boolean; failed?: boolean } = {},
) {
  const seen: string[][] = [];
  const worker = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers: {
      GetSharedSongMegapotParticipationV2: makeSharedSongMegapotParticipationHandler(
        async (account, community, post) => {
          seen.push([account, community, post]);
          if (options.failed) throw new Error("private storage/provider details");
          return options.missing
            ? { status: "not_found" }
            : { status: "found", participation: null };
        },
        options.enabled ?? true,
      ),
    },
    authenticate: () => {
      if (options.anonymous) throw new AuthError({ message: "Authentication required" });
      return { kind: "user", subject: "signed-in-account" };
    },
    authorize: () => undefined,
  });
  return { worker, calls: seen };
}

describe("shared song participant HTTP boundary", () => {
  test("reads the signed-in account without a persona, wallet or membership input", async () => {
    const f = fixture();
    const response = await f.worker.request(root, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(f.calls).toEqual([["signed-in-account", "test-community", "test-song"]]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  test("does not accept a query account as authority", async () => {
    const f = fixture();
    const response = await f.worker.request(`${root}?account_id=foreign&persona_id=foreign`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(f.calls).toEqual([["signed-in-account", "test-community", "test-song"]]);
  });
  test("keeps Rewards-off from reading or advertising a ready shared summary", async () => {
    const f = fixture({ enabled: false });
    const response = await f.worker.request(root, { headers });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(f.calls).toHaveLength(0);
  });
  test("requires a browser session before any private read", async () => {
    const f = fixture({ anonymous: true });
    const response = await f.worker.request(root);
    expect(response.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  test("refuses bearer credentials at the browser-session boundary", async () => {
    const f = fixture();
    const response = await f.worker.request(root, {
      headers: { ...headers, authorization: "Bearer fictional" },
    });
    expect(response.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  test("makes restricted and absent content the same declared not-found result", async () => {
    const f = fixture({ missing: true });
    const response = await f.worker.request(root, { headers });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
  test("does not expose raw storage or provider errors", async () => {
    const f = fixture({ failed: true });
    const response = await f.worker.request(root, { headers });
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("private storage/provider details");
    expect(body).toContain("Shared pot participation unavailable");
  });
});
