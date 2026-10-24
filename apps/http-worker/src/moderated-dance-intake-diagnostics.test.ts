import { expect, spyOn, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { ControlPlaneDb } from "../../../packages/application/src/ports.ts";
import { DanceReviewServiceFailure } from "../../../packages/application/src/use-cases/dance/moderator-review-services.ts";
import { CreateModeratedDanceSessionBody } from "../../../packages/contracts/src/dance-moderated-intake.ts";
import { makeControlPlaneModeratedDanceIntakeStore } from "../../../packages/platform-cf/src/dance-moderated-intake-repository.ts";
import { makeModeratedDanceIntakeHandlers } from "./moderated-dance-intake-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const body = {
  version: "dance-moderated-intake-v1",
  idempotency_key: "command",
  community_id: "community",
  operation: "create",
  song_post_id: "song",
  persona_id: "persona",
  choreography_id: "dance",
  choreography_revision: 1,
  expected_policy_hash: "a".repeat(64),
};
const headers = {
  cookie: "__Host-pirate_session=fictional; __Host-pirate_csrf=fictional_csrf",
  origin: "https://app.pirate.test",
  "x-csrf-token": "fictional_csrf",
  "content-type": "application/json",
};
const serializedBody = JSON.stringify(
  Schema.decodeUnknownSync(CreateModeratedDanceSessionBody)(body),
);
function worker(failure: DanceReviewServiceFailure) {
  const layer = Layer.succeed(ControlPlaneDb, {
    execute: () => Effect.die(new Error("Unexpected diagnostic fixture database call")),
    withTransaction: () => Effect.die(new Error("Unexpected diagnostic fixture transaction")),
  });
  const handlers = makeModeratedDanceIntakeHandlers((accountId) => ({
    ...makeControlPlaneModeratedDanceIntakeStore(layer, accountId, {
      signer: null,
      admitNewCapture: () => Effect.void,
    }),
    command: () => Effect.fail(failure),
  }));
  return createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => ({ kind: "user", subject: "account" }),
    authorize: () => undefined,
  });
}

test("a fixed Dance intake stage survives the server boundary while the wire remains generic", async () => {
  const logs: unknown[][] = [];
  const logging = spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args);
  });
  try {
    const app = worker(
      new DanceReviewServiceFailure({
        reason: "unavailable",
        diagnosticCode: "dance_network_rpc",
      }),
    );
    const response = await app.request("/communities/community/dance/moderated-sessions", {
      method: "POST",
      headers,
      body: serializedBody,
    });
    const wire = await response.json();
    expect(wire).toMatchObject({ error: { message: "Private Dance intake unavailable" } });
    expect(response.status).toBe(500);
    expect(wire).toMatchObject({
      error: { code: "internal_error", message: "Private Dance intake unavailable" },
    });
    expect(JSON.stringify(wire)).not.toContain("dance_network_rpc");
    const boundary = logs.find((entry) => entry[0] === "http_boundary_failure")?.[1];
    expect(boundary).toMatchObject({
      endpoint: "CreateModeratedDanceSession",
      causes: [{ error_name: "Error", error_message: "dance_network_rpc" }],
    });
  } finally {
    logging.mockRestore();
  }
});

test("an unrecognized internal diagnostic value cannot enter the wire or boundary log", async () => {
  const logs: unknown[][] = [];
  const logging = spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args);
  });
  const privateText = "https://private.invalid/source?signature=fictional-secret";
  try {
    const app = worker(
      new DanceReviewServiceFailure({
        reason: "unavailable",
        diagnosticCode: privateText as never,
      }),
    );
    const response = await app.request("/communities/community/dance/moderated-sessions", {
      method: "POST",
      headers,
      body: serializedBody,
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(privateText);
    expect(JSON.stringify(logs)).not.toMatch(/private\.invalid|fictional-secret/u);
    const boundary = logs.find((entry) => entry[0] === "http_boundary_failure")?.[1];
    expect(boundary).not.toHaveProperty("causes");
  } finally {
    logging.mockRestore();
  }
});
