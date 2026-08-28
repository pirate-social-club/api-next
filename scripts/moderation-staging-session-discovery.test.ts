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
});
