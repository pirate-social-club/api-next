import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  makeSpacesTaprootHandlers,
  type SpacesTaprootHandlerServices,
} from "./spaces-taproot-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const request = (body: unknown): DecodedRequest => ({
  body,
  params: { personaId: "persona_one" },
  query: {},
  principal: { kind: "user", subject: "account_one" },
});
const proof = { type: "privy_access_token", privy_access_token: "signed-token" };
const makeServices = (events: string[], accountId = "account_one") =>
  ({
    enabled: true,
    readInventory: () => {
      events.push("provider-inventory");
      return Effect.succeed({ sourceUserId: "privy_one", wallets: [] });
    },
    canonicalAccountId: () => Effect.succeed(accountId),
    preparations: {
      prepare: () => {
        events.push("assignment-prepare");
        return Effect.succeed({ assignmentId: "assignment_one" });
      },
      read: () =>
        Effect.succeed({ assignmentId: "assignment_one", address: null, outputScriptHex: null }),
    },
    intents: {
      prepare: () => {
        events.push("intent-prepare");
        return Effect.succeed({ state: "prepared" });
      },
      beginCreate: () => {
        events.push("create-marked");
        return Effect.succeed({ mayCreate: true });
      },
      status: () => Effect.succeed({ kind: "pending" }),
      confirm: () =>
        Effect.succeed({
          assignmentId: "assignment_one",
          address: "bc1p...",
          outputScriptHex: "5120...",
          replay: false,
        }),
    },
  }) as unknown as SpacesTaprootHandlerServices;

describe("Spaces Taproot browser boundary", () => {
  test("disabled routes never read proof or grant browser provider creation", async () => {
    const events: string[] = [];
    const handlers = makeSpacesTaprootHandlers({ ...makeServices(events), enabled: false });
    await expect(handlers.PreparePersonaSpacesTaproot(request({ proof }))).rejects.toThrow();
    expect(events).toEqual([]);
  });

  test("provider identity must resolve to the cookie account before any DB write", async () => {
    const events: string[] = [];
    const handlers = makeSpacesTaprootHandlers(makeServices(events, "different_account"));
    await expect(
      handlers.PreparePersonaSpacesTaproot(request({ idempotency_key: "once", proof })),
    ).rejects.toThrow();
    expect(events).toEqual(["provider-inventory"]);
  });

  test("prepare grants create only after durable assignment, baseline and one-way mark", async () => {
    const events: string[] = [];
    const handlers = makeSpacesTaprootHandlers(makeServices(events));
    expect(
      await handlers.PreparePersonaSpacesTaproot(request({ idempotency_key: "once", proof })),
    ).toEqual({
      assignment_id: "assignment_one",
      network: "mainnet",
      may_create: true,
    });
    expect(events).toEqual([
      "provider-inventory",
      "assignment-prepare",
      "intent-prepare",
      "create-marked",
    ]);
  });
});
