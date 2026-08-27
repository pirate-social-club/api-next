import type { CommunityModerationStoreService } from "@pirate/application";
import { NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeLegacyModerationActionCompatibility } from "../../apps/http-worker/src/community-moderation-compatibility.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const legacyResponse =
  '{"action_id":"legacy-action","case_ref":"case-owner","action":"hide","target_status":"hidden"}';

const moderationStore: CommunityModerationStoreService = {
  getCapabilities: () => Effect.die("unused capability store"),
  listCases: () => Effect.die("unused list store"),
  getCase: () => Effect.die("unused detail store"),
  getPolicy: () => Effect.die("unused policy store"),
  updatePolicy: () => Effect.die("unused policy update store"),
  reportTarget: () => Effect.die("unused report store"),
  replayLegacyAction: ({ idempotencyKey }) =>
    Effect.succeed(
      idempotencyKey === "legacy-existing"
        ? {
            action_id: "legacy-action",
            case_ref: "case-owner",
            action: "hide" as const,
            target_status: "hidden" as const,
            responseBytes: new TextEncoder().encode(legacyResponse),
          }
        : null,
    ),
  actOnCase: () => Effect.die("unused action store"),
};

const app = createHttpWorker({
  config: { corsOrigin: "https://solid.test" },
  handlers: {
    GetCommunityModerationCapabilities: ({ principal, params }) => {
      if (principal?.subject !== "owner-account") {
        throw new NotFound({ message: "Moderation resource not found" });
      }
      return {
        object: "community_moderation_capabilities",
        community_id: String((params as { readonly communityId: string }).communityId),
        role: "owner",
        role_assignment_id: "owner-assignment",
        capabilities: ["moderation.view", "moderation.act"],
      };
    },
    ModerateCaseAction: ({ principal, params, body }) => {
      if (principal?.subject !== "owner-account") {
        throw new NotFound({ message: "Moderation case not found" });
      }
      const action = body as {
        readonly action: "hide";
      };
      return {
        version: "moderation-case-action-result-v2",
        action_id: "current-action",
        case_ref: String((params as { readonly caseRef: string }).caseRef),
        action: action.action,
        target_status: "hidden",
      };
    },
  },
  beforeDecode: makeLegacyModerationActionCompatibility(moderationStore),
  authenticate: ({ credentials }) => ({
    kind: "user",
    subject: credentials.authorization === "Bearer owner" ? "owner-account" : "foreign-account",
  }),
  authorize: () => undefined,
});

const headers = (token: "owner" | "foreign") => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

describe("owner-only community moderation HTTP", () => {
  it("projects owner capability and redacts the same route from another account", async () => {
    const owner = await app.request("https://worker.test/communities/community-a/me/capabilities", {
      headers: headers("owner"),
    });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({
      role: "owner",
      capabilities: ["moderation.view", "moderation.act"],
    });

    const foreign = await app.request(
      "https://worker.test/communities/community-a/me/capabilities",
      { headers: headers("foreign") },
    );
    expect(foreign.status).toBe(404);
  });

  it("replays committed V1 bytes, refuses fresh V1, and accepts the V2 wire", async () => {
    const replay = await app.request("https://worker.test/moderation/cases/case-owner/actions", {
      method: "POST",
      headers: headers("foreign"),
      body: JSON.stringify({ idempotency_key: "legacy-existing", action: "hide" }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(legacyResponse);

    const freshV1 = await app.request("https://worker.test/moderation/cases/case-owner/actions", {
      method: "POST",
      headers: headers("owner"),
      body: JSON.stringify({ idempotency_key: "legacy-fresh", action: "hide" }),
    });
    expect(freshV1.status).toBe(409);
    expect(await freshV1.json()).toMatchObject({
      error: { code: "conflict", details: { reason_code: "contract_version_unsupported" } },
    });

    const current = await app.request("https://worker.test/moderation/cases/case-owner/actions", {
      method: "POST",
      headers: headers("owner"),
      body: JSON.stringify({
        version: "moderation-case-action-v2",
        idempotency_key: "current-action",
        expected_case_revision: 4,
        action: "hide",
      }),
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      version: "moderation-case-action-result-v2",
      action_id: "current-action",
      case_ref: "case-owner",
      action: "hide",
      target_status: "hidden",
    });
  });

  it("does not expose an operator moderation route", async () => {
    const response = await app.request("https://worker.test/operator/moderation/cases", {
      headers: headers("owner"),
    });
    expect(response.status).toBe(404);
  });
});
