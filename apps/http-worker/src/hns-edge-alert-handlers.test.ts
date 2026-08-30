import { describe, expect, test } from "bun:test";
import {
  HnsEdgeAlertFailed,
  type HnsEdgeAlertSink,
} from "@pirate/application/use-cases/hns-edge-alerts";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { hnsEdgeAlertBearerMatches } from "./hns-edge-alert-auth.ts";
import { makeHnsEdgeAlertHandlers } from "./hns-edge-alert-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const token = "a".repeat(48);

const worker = (sink: HnsEdgeAlertSink) =>
  createHttpWorker({
    handlers: makeHnsEdgeAlertHandlers(sink),
    authenticate: async ({ endpoint, credentials }) => {
      if (
        endpoint.auth.policy.kind !== "sharedSecret" ||
        endpoint.auth.policy.name !== "hns-edge-alert" ||
        !(await hnsEdgeAlertBearerMatches(credentials.authorization, token))
      ) {
        throw new AuthError({ message: "Authentication failed" });
      }
      return {
        kind: "device",
        subject: "hns-edge-alert",
        scopes: ["hns-edge-alert:deliver"],
      };
    },
    authorize: ({ endpoint, input }) => {
      if (
        endpoint.auth.policy.kind !== "sharedSecret" ||
        input.principal?.subject !== "hns-edge-alert" ||
        input.principal.scopes?.includes("hns-edge-alert:deliver") !== true
      ) {
        throw new AuthError({ message: "Authorization failed" });
      }
    },
  });

const request = (authorization: string, body: string) =>
  new Request("https://worker.test/internal/hns-edge-alerts", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });

describe("HNS edge alert HTTP ingress", () => {
  test("authenticates, validates, delivers, and returns 202", async () => {
    const delivered: string[] = [];
    const response = await worker({
      deliver: ({ text }) => Effect.sync(() => delivered.push(text)).pipe(Effect.asVoid),
    }).request(request(`Bearer ${token}`, '{"text":"jazleeuw RRSIG check failed"}'));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(delivered).toEqual(["jazleeuw RRSIG check failed"]);
  });

  test("rejects invalid credentials before invalid JSON is decoded", async () => {
    let deliveries = 0;
    const response = await worker({
      deliver: () => Effect.sync(() => deliveries++).pipe(Effect.asVoid),
    }).request(request(`Bearer ${"b".repeat(48)}`, "not-json"));

    expect(response.status).toBe(401);
    expect(deliveries).toBe(0);
  });

  test("refuses non-canonical or over-limit input", async () => {
    let deliveries = 0;
    const app = worker({
      deliver: () => Effect.sync(() => deliveries++).pipe(Effect.asVoid),
    });

    const spaced = await app.request(request(`Bearer ${token}`, '{ "text": "drift" }'));
    const extra = await app.request(request(`Bearer ${token}`, '{"text":"drift","extra":true}'));
    const oversized = await app.request(
      request(`Bearer ${token}`, JSON.stringify({ text: "é".repeat(2_049) })),
    );

    expect([spaced.status, extra.status, oversized.status]).toEqual([400, 400, 400]);
    expect(deliveries).toBe(0);
  });

  test("does not acknowledge a failed provider delivery", async () => {
    const response = await worker({
      deliver: () => Effect.fail(new HnsEdgeAlertFailed({ reason: "delivery-unavailable" })),
    }).request(request(`Bearer ${token}`, '{"text":"jazleeuw RRSIG check failed"}'));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "provider_unavailable", retryable: true },
    });
  });
});
