import { describe, expect, test } from "bun:test";
import {
  CommunityModerationStoreError,
  type CommunityModerationStoreService,
} from "@pirate/application/use-cases/content/community-moderation-runtime";
import { type Conflict, IdempotencyConflict, ModerateCaseAction } from "@pirate/contracts";
import { Effect } from "effect";
import { makeLegacyModerationActionCompatibility } from "./community-moderation-compatibility.ts";

const store = (
  replayLegacyAction: CommunityModerationStoreService["replayLegacyAction"],
): CommunityModerationStoreService => ({
  getCapabilities: () => Effect.die("unexpected capability read"),
  listCases: () => Effect.die("unexpected case list"),
  getCase: () => Effect.die("unexpected case detail"),
  getPolicy: () => Effect.die("unexpected policy read"),
  updatePolicy: () => Effect.die("unexpected policy update"),
  reportTarget: () => Effect.die("unexpected report"),
  replayLegacyAction,
  actOnCase: () => Effect.die("unexpected V2 action"),
});

const request = (body: unknown) =>
  new Request("https://api.example/moderation/cases/case-a/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const args = (body: unknown) => ({
  bindingName: "ModerateCaseAction",
  endpoint: ModerateCaseAction,
  principal: { kind: "user" as const, subject: "owner-a" },
  request: request(body),
});

describe("legacy moderation action compatibility", () => {
  test("returns the durable V1 response bytes before V2 decoding", async () => {
    const responseBytes = new TextEncoder().encode(
      '{"action_id":"action-a","case_ref":"case-a","action":"hide","target_status":"hidden"}',
    );
    let observed: unknown;
    const compatibility = makeLegacyModerationActionCompatibility(
      store((input) => {
        observed = input;
        return Effect.succeed({
          action_id: "action-a",
          case_ref: "case-a",
          action: "hide",
          target_status: "hidden",
          responseBytes,
        });
      }),
    );
    const response = await compatibility(args({ idempotency_key: "legacy-key", action: "hide" }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.text()).toBe(new TextDecoder().decode(responseBytes));
    expect(observed).toMatchObject({
      caseRef: "case-a",
      actor: { kind: "user", userId: "owner-a" },
      idempotencyKey: "legacy-key",
    });
  });

  test("refuses a fresh V1 command with the closed compatibility reason", async () => {
    const compatibility = makeLegacyModerationActionCompatibility(
      store(() => Effect.succeed(null)),
    );
    await expect(
      compatibility(args({ idempotency_key: "fresh-key", action: "approve" })),
    ).rejects.toMatchObject({
      _tag: "Conflict",
      details: { reason_code: "contract_version_unsupported" },
    } satisfies Partial<Conflict>);
  });

  test("preserves idempotency conflicts and leaves V2 bodies to the current decoder", async () => {
    const conflicting = makeLegacyModerationActionCompatibility(
      store(() =>
        Effect.fail(
          new CommunityModerationStoreError({
            operation: "legacy-replay",
            reason: "idempotency-conflict",
            resourceId: "case-a",
          }),
        ),
      ),
    );
    await expect(
      conflicting(args({ idempotency_key: "legacy-key", action: "restore" })),
    ).rejects.toBeInstanceOf(IdempotencyConflict);

    const current = makeLegacyModerationActionCompatibility(
      store(() => Effect.die("V2 body must not query the V1 ledger")),
    );
    await expect(
      current(
        args({
          version: "moderation-case-action-v2",
          idempotency_key: "current-key",
          expected_case_revision: 1,
          action: "hide",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
