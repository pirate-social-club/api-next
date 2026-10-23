import { describe, expect, test } from "bun:test";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import {
  installModeratedDancePrivateMedia,
  makeModeratedDanceMediaLeaseHandler,
} from "./moderated-dance-private-media.ts";
import { createHttpWorker } from "./transport.ts";

const lease = "a".repeat(43),
  path = `/api/communities/community/dance/reviews/review/media/${lease}`;
const grant = {
  expiresAtMs: Date.now() + 60000,
  object: {
    key: "moderated-dance/originals/upload/source",
    identity: "upload_version" as const,
    version: "v1",
    etag: "etag",
    size: 3,
    contentType: "video/mp4" as const,
    canonicalSha256: "a".repeat(64),
  },
};
function fixture() {
  const calls: string[] = [];
  let allowed = true,
    revokeAfterStorage = false,
    setup = false;
  const store = {
    issue: async () => ({
      version: "dance-private-media-access-v1" as const,
      lease_id: lease,
      expires_at_ms: grant.expiresAtMs,
      url: path,
    }),
    resolve: async (_c: string, _r: string, _l: string, charge: boolean) => {
      calls.push(charge ? "authorize-use" : "reauthorize-delivery");
      return allowed ? grant : null;
    },
  };
  const app = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    authenticate: () => {
      calls.push("authenticate");
      return {
        kind: "user",
        subject: "owner",
        ...(setup ? { scopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE] } : {}),
      };
    },
    authorize: () => undefined,
    handlers: {
      CreateModeratedDanceMediaAccess: makeModeratedDanceMediaLeaseHandler(() => store, true),
    },
  });
  const metadata = {
    key: grant.object.key,
    version: grant.object.version,
    etag: grant.object.etag,
    size: 3,
    httpMetadata: { contentType: "video/mp4" },
  };
  installModeratedDancePrivateMedia({
    app,
    authenticate: () => {
      calls.push("authenticate");
      return {
        kind: "user",
        subject: "owner",
        ...(setup ? { scopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE] } : {}),
      };
    },
    forAccount: () => store,
    bucket: {
      head: async () => {
        calls.push("storage-head");
        return metadata;
      },
      get: async () => {
        calls.push("storage-get");
        if (revokeAfterStorage) allowed = false;
        return {
          ...metadata,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]));
              c.close();
            },
          }),
        };
      },
    },
  });
  return {
    app,
    calls,
    deny: () => {
      allowed = false;
    },
    revokeWhileReading: () => {
      revokeAfterStorage = true;
    },
    setup: () => {
      setup = true;
    },
  };
}
describe("session-bound private Dance byte resource", () => {
  test("uses current audience authorization and exact R2 identity, no cache or direct R2 URL", async () => {
    const f = fixture(),
      r = await f.app.request(path, { headers: { cookie: "__Host-pirate_session=token" } });
    expect(r.status).toBe(200);
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(f.calls).toEqual([
      "authenticate",
      "authorize-use",
      "storage-head",
      "storage-get",
      "reauthorize-delivery",
    ]);
  });
  test("missing/mixed/bearer/duplicate credentials never touch private authority or storage", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer machine" },
      { cookie: "__Host-pirate_session=a", authorization: "" },
      { cookie: "__Host-pirate_session=a; __Host-pirate_session=b" },
      { cookie: "__Host-pirate_session=a; __Host-pirate_csrf=a; __Host-pirate_csrf=b" },
    ]) {
      const f = fixture(),
        r = await f.app.request(path, { headers });
      expect(r.status).toBe(401);
      expect(f.calls).toEqual([]);
    }
  });
  test("wallet-setup sessions cannot access a recording", async () => {
    const f = fixture();
    f.setup();
    const r = await f.app.request(path, { headers: { cookie: "__Host-pirate_session=token" } });
    expect(r.status).toBe(401);
    expect(f.calls).toEqual(["authenticate"]);
  });
  test("current private resolver denial prevents reading bytes (SQL predicates are separate proof)", async () => {
    const f = fixture();
    f.deny();
    const r = await f.app.request(path, { headers: { cookie: "__Host-pirate_session=token" } });
    expect(r.status).toBe(404);
    expect(f.calls).toEqual(["authenticate", "authorize-use"]);
  });
  test("a lifecycle change while storage waits cancels delivery after the second check", async () => {
    const f = fixture();
    f.revokeWhileReading();
    const r = await f.app.request(path, { headers: { cookie: "__Host-pirate_session=token" } });
    expect(r.status).toBe(404);
    expect((await r.arrayBuffer()).byteLength).toBe(0);
    expect(f.calls.at(-1)).toBe("reauthorize-delivery");
  });
  test("authenticated same-origin lease creation returns an opaque same-origin resource", async () => {
    const f = fixture();
    const r = await f.app.request("/communities/community/dance/reviews/review/media-access", {
      method: "POST",
      headers: {
        cookie: "__Host-pirate_session=token; __Host-pirate_csrf=csrf",
        origin: "https://app.pirate.test",
        "x-csrf-token": "csrf",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: "dance-private-media-access-v1",
        expected_review_revision: 1,
        audience: "owner",
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      version: "dance-private-media-access-v1",
      lease_id: lease,
      expires_at_ms: grant.expiresAtMs,
      url: path,
    });
  });
  test("lease creation retains ordinary cookie Origin/CSRF boundary", async () => {
    const f = fixture();
    const r = await f.app.request("/communities/community/dance/reviews/review/media-access", {
      method: "POST",
      headers: { cookie: "__Host-pirate_session=token", "content-type": "application/json" },
      body: JSON.stringify({
        version: "dance-private-media-access-v1",
        expected_review_revision: 1,
        audience: "owner",
      }),
    });
    expect(r.status).toBe(401);
  });
});
