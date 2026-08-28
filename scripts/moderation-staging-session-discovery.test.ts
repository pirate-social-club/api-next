import { describe, expect, test } from "bun:test";
import { discoverModerationStagingSessions } from "./moderation-staging-session-discovery";

const environment = {
  MODERATION_E2E_OWNER_EMAIL: "owner@test.invalid",
  MODERATION_E2E_OWNER_OTP: "111111",
  MODERATION_E2E_MEMBER_EMAIL: "member@test.invalid",
  MODERATION_E2E_MEMBER_OTP: "222222",
  MODERATION_E2E_VIEWER_EMAIL: "viewer@test.invalid",
  MODERATION_E2E_VIEWER_OTP: "333333",
};

describe("moderation staging session discovery", () => {
  test("authenticates three distinct test accounts and emits only digests and statuses", async () => {
    const calls: string[] = [];
    const request = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/passwordless/authenticate")) {
        return Response.json({ token: `token-${calls.length}` });
      }
      if (url.endsWith("/auth/session/exchange")) {
        return Response.json(
          { user: {} },
          {
            headers: {
              "set-cookie":
                "__Host-pirate_session=session; Secure, __Host-pirate_csrf=csrf; Secure",
            },
          },
        );
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await discoverModerationStagingSessions(environment, request);
    expect(result.roles).toHaveLength(3);
    expect(result.roles.every((role) => role.account_sha256.length === 64)).toBe(true);
    expect(result.roles.map(({ session_exchange_status }) => session_exchange_status)).toEqual([
      200, 200, 200,
    ]);
    expect(JSON.stringify(result)).not.toContain("@test.invalid");
    expect(calls).toHaveLength(12);
  });

  test("refuses sentinels and reports rejected fixed credentials before session exchange", async () => {
    await expect(
      discoverModerationStagingSessions({ ...environment, MODERATION_E2E_OWNER_OTP: "PENDING" }),
    ).rejects.toThrow("still PENDING");

    const request = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/passwordless/authenticate")) {
        return new Response(null, { status: 401 });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;
    await expect(
      discoverModerationStagingSessions(
        { ...environment, MODERATION_E2E_OWNER_OTP: "999999" },
        request,
      ),
    ).rejects.toThrow("Privy authentication failed with HTTP 401");
  });

  test("confirms a pending registration wallet with CSRF and exchanges a full session", async () => {
    const exchanges = new Map<string, number>();
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/passwordless/authenticate")) {
        const body = JSON.parse(String(init?.body)) as { email: string };
        return Response.json({ token: `token-${body.email}` });
      }
      if (url.endsWith("/auth/session/exchange")) {
        const body = JSON.parse(String(init?.body)) as {
          proof: { privy_access_token: string };
        };
        const token = body.proof.privy_access_token;
        const count = (exchanges.get(token) ?? 0) + 1;
        exchanges.set(token, count);
        if (count === 1) return new Response(null, { status: 401 });
        return Response.json(
          { user: {} },
          {
            headers: {
              "set-cookie":
                "__Host-pirate_session=full; Secure, __Host-pirate_csrf=full-csrf; Secure",
            },
          },
        );
      }
      if (url.endsWith("/auth/register")) {
        return Response.json(
          {
            status: "wallet_setup_required",
            wallet: { persona_id: "persona-test", status: "pending" },
          },
          {
            status: 201,
            headers: {
              "set-cookie":
                "__Host-pirate_session=setup; Secure, __Host-pirate_csrf=setup-csrf; Secure",
            },
          },
        );
      }
      if (url.includes("/wallets/evm/confirm")) {
        expect(new Headers(init?.headers).get("x-csrf-token")).toBe("setup-csrf");
        return Response.json({ status: "active" });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await discoverModerationStagingSessions(environment, request);
    expect(
      result.roles.every(({ wallet_confirmation_status }) => wallet_confirmation_status === 200),
    ).toBe(true);
    expect(result.roles.every(({ current_user_status }) => current_user_status === 200)).toBe(true);
  });
});
