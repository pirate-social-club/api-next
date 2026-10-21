import { describe, expect, test } from "bun:test";
import {
  SongContributionFailure,
  type SongContributionPorts,
  type SongContributionReadPorts,
} from "@pirate/application/rewards/song-megapot-contributions";
import { SubmissionClaimReceiptV2 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeSongMegapotContributionHandlers } from "./song-megapot-contribution-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const root = "/communities/community/posts/song";
const stateHref = `${root}/megapot-contributions/contribution`;
const headers = {
  cookie: "__Host-pirate_session=fictional; __Host-pirate_csrf=fictional_csrf",
  origin: "https://app.pirate.test",
  "x-csrf-token": "fictional_csrf",
  "content-type": "application/json",
};
const claimBody = {
  idempotency_key: "submission_claim_key_0001",
  client_instance_id: "client_instance_key_0001",
  submission_attempt_id: "submission_attempt_key_0001",
  purpose: "funding_transfer",
  expected_state_revision: 0,
  instruction_hash: "a".repeat(64),
};
const claim = Schema.decodeUnknownSync(SubmissionClaimReceiptV2)({
  object: "contribution_submission_claim_receipt",
  version: 2,
  command_id: "command",
  request_hash: "b".repeat(64),
  contribution_id: "contribution",
  instruction_hash: claimBody.instruction_hash,
  purpose: "funding_transfer",
  grant_id: "original_grant",
  grant_revision: 1,
  holder_client_instance_id: claimBody.client_instance_id,
  submission_attempt_id: claimBody.submission_attempt_id,
  claimed_at: "2026-10-18T12:00:00.000Z",
  valid_until: "2026-10-18T12:01:00.000Z",
  current_state_href: stateHref,
  cancellation_preparation_id: null,
  cancellation_preparation_revision: null,
});

/** Offline HTTP/application boundary only. These ports never implement a
 * database, nonce allocator, grant issuer, observer or financial interpreter.
 */
function fixture(options: { unknownLookup?: boolean; foreignRead?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = makeSongMegapotContributionHandlers({
    commands: (authorization) => {
      calls.push("commands");
      const ports: SongContributionPorts = {
        authorize: (scope) =>
          authorization.authorize(scope).pipe(
            Effect.tap((actor) =>
              Effect.sync(() => {
                calls.push(`account:${actor.accountId}`);
              }),
            ),
          ),
        lookup: (identity) => {
          calls.push("lookup");
          return options.unknownLookup
            ? Effect.fail(new SongContributionFailure({ code: "outcome_unknown" }))
            : Effect.succeed({
                requestHash: identity.hash,
                receipt: { ...claim, request_hash: identity.hash },
              });
        },
        preflight: () => {
          calls.push("preflight");
          return Effect.fail(new SongContributionFailure({ code: "outcome_unknown" }));
        },
        transaction: () => {
          calls.push("transaction");
          return Effect.fail(new SongContributionFailure({ code: "outcome_unknown" }));
        },
      };
      return ports;
    },
    reads: (authorization) => {
      calls.push("reads");
      const ports: SongContributionReadPorts = {
        authorize: authorization.authorize,
        context: (_scope, accountId, personaId) => {
          calls.push(`context:${accountId}:${personaId}`);
          return Effect.succeed({
            object: "song_megapot_funding_context",
            version: 2,
            readiness: "unavailable",
            target: {
              kind: "empty",
              community_id: "community",
              post_id: "song",
              canonical_song_id: "canonical",
              audio_revision: 1,
              slot_id: "slot",
              slot_generation: 0,
              offer_id: null,
              pool_leg_id: null,
            },
            persona_id: personaId,
            reason: "mixed_objective_unavailable",
            retry_after_seconds: null,
            own_recovery_href: null,
          });
        },
        current: (_scope, accountId) => {
          calls.push(`current:${accountId}`);
          return Effect.succeed(null);
        },
        command: (scope, accountId, operation, key) => {
          calls.push(`receipt:${accountId}`);
          return Effect.succeed({
            accountId: options.foreignRead ? "other" : accountId,
            communityId: scope.communityId,
            postId: scope.postId,
            operation,
            key,
            requestHash: claim.request_hash,
            receipt: claim,
          });
        },
      };
      return ports;
    },
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => ({ kind: "user", subject: "account" }),
    authorize: () => undefined,
  });
  return { worker, calls };
}

describe("V5 contribution HTTP consumers", () => {
  test("requires a browser session and exact Origin/CSRF before constructing command ports", async () => {
    const f = fixture();
    const uri = `${stateHref}/submission-claims`;
    for (const overrides of [
      { cookie: "", authorization: "Bearer machine" },
      { origin: "https://foreign.invalid" },
      { "x-csrf-token": "mismatch" },
    ]) {
      const response = await f.worker.request(uri, {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: JSON.stringify(claimBody),
      });
      expect(response.status).toBe(401);
    }
    expect(f.calls).toEqual([]);
  });
  test("exact JSON and closed bodies reject duplicate, escaped duplicate and actor input before the application", async () => {
    const f = fixture();
    const body = JSON.stringify(claimBody);
    for (const invalid of [
      `{"idempotency_key":"different_valid_key_0001",${body.slice(1)}`,
      `{"idempotency_\\u006bey":"different_valid_key_0001",${body.slice(1)}`,
      JSON.stringify({ ...claimBody, actor_account_id: "other" }),
    ]) {
      const response = await f.worker.request(`${stateHref}/submission-claims`, {
        method: "POST",
        headers,
        body: invalid,
      });
      expect(response.status).toBe(400);
    }
    expect(f.calls).toEqual([]);
  });
  test("same-key submission replay is recovery_only and performs no fresh preflight, transaction or wallet invocation", async () => {
    const f = fixture();
    const response = await f.worker.request(`${stateHref}/submission-claims`, {
      method: "POST",
      headers,
      body: JSON.stringify(claimBody),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      receipt: { grant_id: "original_grant" },
      delivery: { kind: "recovery_only", replayed: true },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.calls).toEqual(["commands", "account:account", "lookup"]);
  });
  test("unknown lookup stays unknown without a refusal allocation:none assertion or automatic retry", async () => {
    const f = fixture({ unknownLookup: true });
    const response = await f.worker.request(`${stateHref}/submission-claims`, {
      method: "POST",
      headers,
      body: JSON.stringify(claimBody),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: {
        details: { object: "contribution_error", code: "outcome_unknown", refusal_receipt: null },
      },
    });
    expect(f.calls).toEqual(["commands", "account:account", "lookup"]);
  });
  test("GET returns immutable own command evidence without a delivery grant; foreign provenance is concealed", async () => {
    for (const foreignRead of [false, true]) {
      const f = fixture({ foreignRead });
      const response = await f.worker.request(
        `${root}/megapot-contribution-commands/ClaimSongMegapotContributionSubmissionV2/${claimBody.idempotency_key}`,
        { headers },
      );
      expect(response.status).toBe(foreignRead ? 404 : 200);
      const body = await response.json();
      if (!foreignRead) {
        expect(body).toEqual(claim);
        expect(body).not.toHaveProperty("delivery");
      }
      expect(f.calls).toEqual(["reads", "receipt:account"]);
    }
  });
  test("context remains explicitly unavailable without allocating a slot or accepting browser policy/persona authority", async () => {
    const f = fixture();
    const response = await f.worker.request(`${root}/megapot-funding-context?persona_id=persona`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readiness: "unavailable",
      reason: "mixed_objective_unavailable",
    });
    expect(f.calls).toEqual(["reads", "context:account:persona"]);
    f.calls.length = 0;
    const forged = await f.worker.request(
      `${root}/megapot-funding-context?persona_id=persona&account_id=other`,
      { headers },
    );
    expect(forged.status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("own current-state absence remains404 and does not fall back to V1 or enqueue recovery", async () => {
    const f = fixture();
    const response = await f.worker.request(stateHref, { headers });
    expect(response.status).toBe(404);
    expect(f.calls).toEqual(["reads", "current:account"]);
  });
});
