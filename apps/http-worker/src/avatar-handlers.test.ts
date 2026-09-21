import { describe, expect, test } from "bun:test";
import {
  AvatarFailure,
  type AvatarStorage,
  type AvatarStore,
} from "@pirate/application/use-cases/avatars";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeAvatarHandlers } from "./avatar-handlers.ts";
import { createHttpWorker, type Principal } from "./transport.ts";

const id = "avatar-11111111-1111-4111-8111-111111111111";
function fixture(enabled = true, principal?: Principal) {
  let removed = false,
    reads = 0,
    authorizations = 0;
  const store: AvatarStore = {
    reserve: () => Effect.fail(new AvatarFailure({ reason: "unavailable" })),
    finalize: () => Effect.void,
    delivery: () =>
      Effect.sync(() => {
        authorizations++;
        if (removed) throw new Error("removed");
        return { key: "sealed/internal.jpg", digest: "a".repeat(64) };
      }).pipe(Effect.catchDefect(() => Effect.fail(new AvatarFailure({ reason: "not-found" })))),
    remove: () =>
      Effect.sync(() => {
        removed = true;
      }),
    cleanup: () => Effect.succeed({ removed: 0, failed: 0 }),
  };
  const storage: AvatarStorage = {
    presign: () => Effect.die("not used"),
    seal: () => Effect.die("not used"),
    delete: () => Effect.void,
    read: () =>
      Effect.sync(() => {
        reads++;
        return new Blob([new Uint8Array([255, 216, 255, 217])]).stream();
      }),
  };
  const app = createHttpWorker({
    handlers: makeAvatarHandlers(store, storage, enabled),
    authenticate: () => {
      if (principal) return principal;
      throw new AuthError({ message: "Authentication required" });
    },
    authorize: () => {},
  });
  return { app, store, counts: () => ({ reads, authorizations }) };
}
describe("avatar HTTP delivery", () => {
  test("serves binary image and rechecks revocation before conditional response", async () => {
    const f = fixture();
    const first = await f.app.request(`http://worker.test/avatars/${id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();
    expect(
      (
        await f.app.request(`http://worker.test/avatars/${id}`, {
          headers: { "if-none-match": etag },
        })
      ).status,
    ).toBe(304);
    expect(f.counts()).toEqual({ reads: 1, authorizations: 2 });
    await Effect.runPromise(f.store.remove(id));
    expect(
      (
        await f.app.request(`http://worker.test/avatars/${id}`, {
          headers: { "if-none-match": etag },
        })
      ).status,
    ).toBe(404);
  });
  test("removal requires both admin kind and the exact moderation scope", async () => {
    for (const principal of [
      { kind: "user" as const, subject: "operator", scopes: ["avatars:moderate"] },
      { kind: "admin" as const, subject: "operator", scopes: [] },
    ]) {
      const f = fixture(true, principal);
      expect(
        (
          await f.app.request(`http://worker.test/avatars/${id}`, {
            method: "DELETE",
            headers: { authorization: "Bearer test-operator" },
          })
        ).status,
      ).toBe(401);
      expect((await f.app.request(`http://worker.test/avatars/${id}`)).status).toBe(200);
    }
    const allowed = fixture(true, {
      kind: "admin",
      subject: "operator",
      scopes: ["avatars:moderate"],
    });
    expect(
      (
        await allowed.app.request(`http://worker.test/avatars/${id}`, {
          method: "DELETE",
          headers: { authorization: "Bearer test-operator" },
        })
      ).status,
    ).toBe(200);
    expect((await allowed.app.request(`http://worker.test/avatars/${id}`)).status).toBe(404);
  });
  test("disabling authoring preserves already attached image reads", async () => {
    const f = fixture(false);
    expect((await f.app.request(`http://worker.test/avatars/${id}`)).status).toBe(200);
  });
  test("anonymous users cannot reserve, finalize or remove avatars", async () => {
    const f = fixture();
    for (const [path, method] of [
      ["/avatar-upload-reservations", "POST"],
      [`/avatar-upload-reservations/${id}/finalize`, "POST"],
      [`/avatars/${id}`, "DELETE"],
    ] as const)
      expect((await f.app.request(`http://worker.test${path}`, { method })).status).toBe(401);
  });
});
