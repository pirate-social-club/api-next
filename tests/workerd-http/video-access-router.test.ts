import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("production router authorizes matching poster ETags before any conditional response", async () => {
  const allowed = await SELF.fetch("https://worker.test/posts/allowed/video/poster");
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("content-type")).toBe("image/jpeg");
  expect(allowed.headers.get("cache-control")).toBe("private, no-cache");
  expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]));
  const etag = allowed.headers.get("etag");
  expect(etag).toBe('"same-bytes"');
  const conditional = await SELF.fetch("https://worker.test/posts/allowed/video/poster", {
    headers: { "if-none-match": String(etag) },
  });
  expect(conditional.status).toBe(304);
  const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://solid.test" },
    body: JSON.stringify({
      proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
    }),
  });
  expect(exchange.status).toBe(200);
  const cookie = (exchange.headers.get("set-cookie") ?? "")
    .split(/, (?=__Host-pirate_)/u)
    .map((value) => value.split(";", 1)[0] ?? "")
    .join("; ");
  expect(cookie).toContain("__Host-pirate_");
  const changedEligibility = await SELF.fetch("https://worker.test/posts/allowed/video/poster", {
    headers: { cookie, "if-none-match": String(etag) },
  });
  expect(changedEligibility.status).toBe(404);
  expect(changedEligibility.headers.get("etag")).toBeNull();
  const denialBody = async (response: Response) => {
    const { request_id, ...body } = (await response.json()) as Record<string, unknown>;
    // Request correlation is fresh per request, not an eligibility signal.
    expect(request_id).toEqual(expect.any(String));
    return body;
  };
  const denial = await denialBody(changedEligibility);
  for (const postId of [
    "age-denied",
    "membership-denied",
    "moderation-denied",
    "visibility-denied",
    "absent",
  ]) {
    const response = await SELF.fetch(`https://worker.test/posts/${postId}/video/poster`, {
      headers: { "if-none-match": String(etag) },
    });
    expect(response.status).toBe(404);
    expect(await denialBody(response)).toEqual(denial);
    expect(response.headers.get("etag")).toBeNull();
  }
  const missing = await SELF.fetch("https://worker.test/posts/missing/video/poster", {
    headers: { "if-none-match": String(etag) },
  });
  expect(missing.status).toBe(500);
  expect(await denialBody(missing)).not.toEqual(denial);
});

test("registered playback endpoint allows anonymous public viewing with private no-store", async () => {
  const response = await SELF.fetch("https://worker.test/posts/allowed/video/playback-access", {
    method: "POST",
    headers: { "CF-Connecting-IP": "198.51.100.1" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ expires_at: 1300, renew_after: 1240 });
});
