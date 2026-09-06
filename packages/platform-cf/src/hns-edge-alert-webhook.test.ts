import { expect, test } from "bun:test";
import { makeHnsEdgeAlertService } from "@pirate/application/use-cases/hns-edge-alerts";
import { Effect } from "effect";
import { type HnsAlertFetch, makeHnsEdgeWebhookAlertSink } from "./hns-edge-alert-webhook.ts";

test("interruption cancels an in-flight webhook request", async () => {
  let aborted = false;
  const fetchImpl: HnsAlertFetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("transport-secret"));
        },
        { once: true },
      );
    });
  await Effect.runPromiseExit(
    makeHnsEdgeWebhookAlertSink("https://operator.invalid/secret", fetchImpl)
      .deliver({ text: "test" })
      .pipe(Effect.timeout("10 millis")),
  );
  expect(aborted).toBe(true);
});

test("HNS webhook sends only text, refuses redirects, and cancels response bodies", async () => {
  let called = false;
  const fetchImpl = (async (_url, init) => {
    called = true;
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBe(JSON.stringify({ text: "fixture alert" }));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(null, { status: 204 });
  }) as HnsAlertFetch;
  await Effect.runPromise(
    makeHnsEdgeAlertService(
      makeHnsEdgeWebhookAlertSink("https://operator.invalid/secret", fetchImpl),
    ).deliver({ text: "fixture alert" }),
  );
  expect(called).toBe(true);
});

test("invalid destinations and provider errors never expose the endpoint credential", async () => {
  for (const url of [
    "http://operator.invalid/secret",
    "https://user:secret@operator.invalid/",
    "https://operator.invalid/#secret",
  ])
    expect(() => makeHnsEdgeWebhookAlertSink(url)).toThrow("HNS webhook configuration invalid");
  for (const fetchImpl of [
    (async () => {
      throw new Error("https://operator.invalid/fixture-secret");
    }) as HnsAlertFetch,
    (async () => new Response("fixture-secret", { status: 503 })) as HnsAlertFetch,
    (async () => new Response(null, { status: 302 })) as HnsAlertFetch,
  ]) {
    const result = await Effect.runPromise(
      makeHnsEdgeWebhookAlertSink("https://operator.invalid/fixture-secret", fetchImpl)
        .deliver({ text: "test" })
        .pipe(Effect.flip),
    );
    expect(result.reason).toBe("delivery-unavailable");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  }
});
