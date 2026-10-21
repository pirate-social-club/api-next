import { describe, expect, test } from "bun:test";
import { WalletSendVerificationRequired } from "@pirate/platform-cf/wallet-send-palm";
import type { makeWalletSponsoredSendService } from "@pirate/platform-cf/wallet-sponsored-send-service";
import { createHttpWorker } from "./transport.ts";
import { makeWalletSponsoredSendHandlers } from "./wallet-sponsored-send-handlers.ts";

type Service = ReturnType<typeof makeWalletSponsoredSendService>;
const unexpected = async (): Promise<never> => {
  throw Error("unexpected service call");
};

describe("Send Palm HTTP boundary", () => {
  test("returns a typed verification requirement bound to the signed-in account's persona", async () => {
    let calledAccount = "";
    const reserve: Service["reserve"] = async (input) => {
      calledAccount = input.accountId;
      throw new WalletSendVerificationRequired(input.personaId);
    };
    const worker = createHttpWorker({
      authenticate: () => ({ kind: "user", subject: "account" }),
      authorize: () => undefined,
      handlers: makeWalletSponsoredSendHandlers(
        { reserve, submit: unexpected, get: unexpected, getForPersona: unexpected },
        unexpected,
      ),
    });
    const result = await worker.request("/wallet/personas/persona/sponsored-send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        chain_id: 84532,
        recipient: `0x${"d1".repeat(20)}`,
        amount_atomic: "1",
        idempotency_key: "key",
      }),
    });
    expect(calledAccount).toBe("account");
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({
      error: {
        code: "verification_required",
        details: { purpose: "wallet_send", persona_id: "persona", provider_id: "very.web" },
      },
    });
  });

  test("issues a typed intended-persona return and rejects an unauthenticated or admin caller", async () => {
    const calls: string[][] = [];
    const handlers = makeWalletSponsoredSendHandlers(null, async (account, persona) => {
      calls.push([account, persona]);
      return "wallet-send_intent";
    });
    const worker = createHttpWorker({
      authenticate: () => ({ kind: "user", subject: "account" }),
      authorize: () => undefined,
      handlers,
    });
    const result = await worker.request("/wallet/personas/persona/send-verification-intents", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      intent_id: "wallet-send_intent",
      provider_id: "very.web",
      purpose: "wallet_send",
      persona_id: "persona",
    });
    expect(calls).toEqual([["account", "persona"]]);
    const request = {
      body: undefined,
      headers: undefined,
      params: { personaId: "persona" },
      query: {},
      principal: null,
    };
    await expect(handlers.IssueWalletSendVerificationIntent(request)).rejects.toMatchObject({
      code: "auth_error",
    });
    await expect(
      handlers.IssueWalletSendVerificationIntent({
        ...request,
        principal: { kind: "admin", subject: "operator" },
      }),
    ).rejects.toMatchObject({ code: "auth_error" });
    expect(calls).toHaveLength(1);
  });
});
