import { describe, expect, test } from "bun:test";

import {
  exchangeInfisicalOidcToken,
  requestGitHubOidcToken,
  resolveInfisicalAuditToken,
} from "./infisical-oidc-auth";

describe("Infisical GitHub OIDC authentication", () => {
  test("requests the exact audience without exposing the GitHub credential", async () => {
    const token = await requestGitHubOidcToken({
      audience: "https://github.com/pirate-social-club",
      requestUrl: "https://github.example/oidc?existing=true",
      requestToken: "request-credential",
      request: async (url, init) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("existing")).toBe("true");
        expect(parsed.searchParams.get("audience")).toBe("https://github.com/pirate-social-club");
        expect(init.headers).toMatchObject({ authorization: "Bearer request-credential" });
        return Response.json({ value: "short-lived-github-token" });
      },
    });

    expect(token).toBe("short-lived-github-token");
  });

  test("exchanges the GitHub token for a short-lived Infisical token", async () => {
    const token = await exchangeInfisicalOidcToken({
      baseUrl: "https://infisical.example/api/",
      identityId: "identity-id",
      oidcToken: "short-lived-github-token",
      request: async (url, init) => {
        expect(url).toBe("https://infisical.example/api/v1/auth/oidc-auth/login");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
          identityId: "identity-id",
          jwt: "short-lived-github-token",
        });
        return Response.json({ accessToken: "short-lived-infisical-token" });
      },
    });

    expect(token).toBe("short-lived-infisical-token");
  });

  test("prefers an explicit local audit token without making a request", async () => {
    const token = await resolveInfisicalAuditToken({
      baseUrl: "https://infisical.example/api",
      environment: { INFISICAL_AUDIT_TOKEN: "local-audit-token" },
      request: async () => {
        throw new Error("request should not run");
      },
    });

    expect(token).toBe("local-audit-token");
  });

  test("performs the complete GitHub-to-Infisical exchange", async () => {
    const requests: string[] = [];
    const token = await resolveInfisicalAuditToken({
      baseUrl: "https://infisical.example/api",
      environment: {
        INFISICAL_MACHINE_IDENTITY_ID: "identity-id",
        INFISICAL_OIDC_AUDIENCE: "https://github.com/pirate-social-club",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-credential",
      },
      request: async (url) => {
        requests.push(url);
        if (url.startsWith("https://github.example/oidc")) {
          return Response.json({ value: "short-lived-github-token" });
        }
        return Response.json({ accessToken: "short-lived-infisical-token" });
      },
    });

    expect(token).toBe("short-lived-infisical-token");
    expect(requests).toHaveLength(2);
  });
});
