// Genuine HNS fixture is shared with the canonical default managed journey.
import { describe, expect, test } from "bun:test";
import { servingHnsHarness } from "./guest-study-serving.hns.fixture.ts";

describe("Guest Study serving real HNS trust dependencies", () => {
  test("actual Worker accepts RSA Access and HMAC; safe reads replay while unsafe replay and expired Access refuse", async () => {
    const f = await servingHnsHarness();
    const good = await f.signed("/api/health");
    const response = await f.worker.fetch(
      new Request(good.url, { method: good.method, headers: good.headers }),
    );
    expect(response.status).toBe(200);
    expect(f.keyReads()).toBe(1);
    expect(
      (await f.worker.fetch(new Request(good.url, { method: good.method, headers: good.headers })))
        .status,
    ).toBe(200);
    const unsafe = await f.signed("/api/auth/session/logout", "POST");
    const replay = () =>
      new Request(unsafe.url, { method: unsafe.method, headers: unsafe.headers });
    expect((await f.worker.fetch(replay())).status).toBe(200);
    expect((await f.worker.fetch(replay())).status).toBe(400);
    const expired = await f.signed("/api/health", "GET", await f.token(now - 300));
    expect((await f.worker.fetch(expired)).status).toBe(401);
    const altered = await f.signed("/api/health");
    altered.headers.set("origin", "https://app.attacker");
    expect((await f.worker.fetch(altered)).status).not.toBe(200);
  });
  test("uncomposed Guest learning refuses before Access or HNS body work even with an actual signed envelope", async () => {
    const f = await servingHnsHarness();
    const request = await f.signed("/api/guest/bootstrap", "POST");
    let bodyReads = 0;
    const read = request.arrayBuffer.bind(request);
    Object.defineProperty(request, "arrayBuffer", {
      configurable: true,
      value: async () => {
        bodyReads++;
        return read();
      },
    });
    const response = await f.worker.fetch(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(bodyReads).toBe(0);
    expect(f.keyReads()).toBe(0);
  });
});
