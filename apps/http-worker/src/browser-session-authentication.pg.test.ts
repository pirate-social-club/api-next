import { describe, expect, test } from "bun:test";
import {
  BrowserSessionFailure,
  makeBrowserSessionService,
} from "@pirate/application/use-cases/browser-sessions";
import {
  authenticateSession,
  authorizeSession,
} from "@pirate/application/use-cases/session-authentication";
import { Effect, Schema } from "effect";
import { withBrowserSessionFixture } from "../../../packages/platform-cf/src/browser-session.pg-fixture.ts";
import { makeBrowserSessionCrypto } from "../../../packages/platform-cf/src/browser-session-crypto.ts";
import { makeControlPlaneBrowserSessionStore } from "../../../packages/platform-cf/src/browser-session-repository.ts";
import { makeControlPlaneIdentityStore } from "../../../packages/platform-cf/src/identity-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeSessionCrypto } from "../../../packages/platform-cf/src/session-crypto.ts";
import { makeRs256SessionTokenVerifier } from "../../../packages/platform-cf/src/session-tokens.ts";
import { createHttpWorker } from "./transport.ts";

const base = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!base && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Test URL required");
const suite = base ? describe : describe.skip;
const origin = "https://app.example.test";
const pem = (data: ArrayBuffer, kind: string) =>
  `-----BEGIN ${kind} KEY-----\n${Buffer.from(data).toString("base64")}\n-----END ${kind} KEY-----`;

suite("owned cookie renewal with actual RS256 and restricted PostgreSQL", () => {
  test("renews without access/provider state, preserves purpose and revokes access immediately", async () => {
    await withBrowserSessionFixture(base!, async (f) => {
      await f.owner.query(`INSERT INTO users(user_id) VALUES('account-a');
        INSERT INTO identity_credentials(credential_id,provider,provider_app_id,provider_subject,canonical_user_id)
        VALUES('credential-a','privy','privy-test','did:privy:a','account-a')`);
      let now = Math.floor(Date.now() / 1000);
      const keys = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const jwt = await makeSessionCrypto({
        privateKeyPem: pem(await crypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE"),
        publicKeyPem: pem(await crypto.subtle.exportKey("spki", keys.publicKey), "PUBLIC"),
        issuer: "https://api.example.test",
        audience: "browser-test",
        defaultScope: "user",
        nowSeconds: () => now,
      });
      const layer = makeDirectPostgresControlPlaneLayer(f.runtimeUrl);
      const identity = makeControlPlaneIdentityStore(layer);
      const service = makeBrowserSessionService({
        store: makeControlPlaneBrowserSessionStore(layer),
        crypto: makeBrowserSessionCrypto(jwt, () => now),
        identities: identity,
        providerAppId: "privy-test",
        userScope: "user",
      });
      const verifier = makeRs256SessionTokenVerifier(jwt, identity, { browserSessions: service });
      const wallet = `0x${"1".repeat(40)}`;
      now = Math.floor(Date.now() / 1000);
      const original = await jwt.sign({
        sub: "account-a",
        scope: "user",
        walletAddress: wallet,
        ttlSeconds: 30,
      });
      const issued = await Effect.runPromise(
        service.issue({ accessToken: original, providerSubject: "did:privy:a", origin }),
      );
      const initial = await Effect.runPromise(
        verifier.verify({
          token: issued.accessToken,
          browser: true,
          requiredClassification: "user",
        }),
      );
      expect(initial.walletAddress === wallet).toBe(true);
      await expect(
        Effect.runPromise(
          verifier.verify({ token: issued.accessToken, requiredClassification: "user" }),
        ),
      ).rejects.toMatchObject({ code: "classification_mismatch" });
      await expect(
        Effect.runPromise(
          verifier.verify({ token: original, browser: true, requiredClassification: "user" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_token" });
      const stored = (
        await f.owner.query("SELECT renewal_secret_hash,csrf_hash FROM browser_sessions")
      ).rows[0];
      expect(JSON.stringify(stored).includes(issued.renewal!)).toBe(false);
      expect(JSON.stringify(stored).includes(issued.renewal!.split(".")[1]!)).toBe(false);
      now += 31;
      await expect(
        Effect.runPromise(
          verifier.verify({
            token: issued.accessToken,
            browser: true,
            requiredClassification: "user",
          }),
        ),
      ).rejects.toMatchObject({ code: "token_expired" });
      const user = {
        id: "account-a",
        object: "user",
        verification_state: "unverified",
        verification_capabilities: Object.fromEntries(
          [
            "unique_human",
            "age_over_18",
            "minimum_age",
            "nationality",
            "gender",
            "wallet_score",
          ].map((name) => [name, { state: "unverified" }]),
        ),
        created: 1700000000,
      };
      const app = createHttpWorker({
        browserSessions: service,
        config: { corsOrigin: origin },
        authenticate: async ({ credentials }) =>
          Effect.runPromise(authenticateSession(credentials, { verifier })),
        authorize: ({ input }) =>
          Effect.runPromise(
            authorizeSession({
              session: {
                subject: input.principal?.subject ?? "",
                kind: input.principal?.kind ?? "device",
              },
              allowedKinds: ["user"],
            }),
          ),
        handlers: { GetCurrentUser: () => user },
      });
      const cookie = `__Host-pirate_renewal=${issued.renewal}; __Host-pirate_csrf=${issued.csrf}`;
      const headers = { origin, cookie, "x-csrf-token": issued.csrf };
      const renewed = await app.request("https://api.example.test/auth/session/renew", {
        method: "POST",
        headers,
      });
      expect(renewed.status).toBe(200);
      const rawBody = await renewed.json();
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          status: Schema.Literal("renewed"),
          user_id: Schema.String,
          expires_at: Schema.String,
        }),
      )(rawBody);
      expect(rawBody).toEqual(body);
      expect(Object.keys(body).sort()).toEqual(["expires_at", "status", "user_id"]);
      expect(body.status).toBe("renewed");
      expect(body.user_id).toBe("account-a");
      const set = renewed.headers.getSetCookie();
      expect(set.length).toBe(3);
      expect(
        set.every((v) => v.includes("Path=/; Secure; SameSite=Lax") && !v.includes("Domain=")),
      ).toBe(true);
      expect(set.find((v) => v.startsWith("__Host-pirate_renewal="))?.includes("HttpOnly")).toBe(
        true,
      );
      expect(set.find((v) => v.startsWith("__Host-pirate_csrf="))?.includes(issued.csrf)).toBe(
        true,
      );
      expect(renewed.headers.get("cache-control")).toBe("no-store");
      const accessCookie = set.find((v) => v.startsWith("__Host-pirate_session="))!.split(";")[0]!;
      const access = decodeURIComponent(accessCookie.slice(accessCookie.indexOf("=") + 1));
      const authority = await Effect.runPromise(
        verifier.verify({ token: access, browser: true, requiredClassification: "user" }),
      );
      expect(authority.userId).toBe("account-a");
      expect(authority.walletAddress).toBeUndefined();
      expect(
        (
          await app.request("https://api.example.test/users/me", {
            headers: { cookie: accessCookie },
          })
        ).status,
      ).toBe(200);
      for (const bad of [
        { ...headers, origin: "https://other.example.test" },
        { ...headers, "x-csrf-token": "wrong" },
        { ...headers, cookie: `${cookie}; __Host-pirate_renewal=${issued.renewal}` },
        {
          ...headers,
          cookie: `__Host-pirate_renewal=%not-a-value; __Host-pirate_csrf=${issued.csrf}`,
        },
        { ...headers, cookie: `${cookie}; __Host-pirate_csrf=${issued.csrf}` },
        { ...headers, authorization: "Bearer fictional" },
      ])
        expect(
          (
            await app.request("https://api.example.test/auth/session/renew", {
              method: "POST",
              headers: bad,
            })
          ).status,
        ).toBe(401);
      expect(
        (
          await app.request("https://api.example.test/users/me", {
            headers: { authorization: `Bearer ${access}` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("https://api.example.test/users/me", {
            headers: { cookie: `__Host-pirate_session=${issued.renewal}` },
          })
        ).status,
      ).toBe(401);
      const unavailable = createHttpWorker({
        config: { corsOrigin: origin },
        browserSessions: {
          ...service,
          renew: () => Effect.fail(new BrowserSessionFailure({ reason: "unavailable" })),
          revoke: () => Effect.fail(new BrowserSessionFailure({ reason: "unavailable" })),
        },
      });
      for (const action of ["renew", "logout"]) {
        const response = await unavailable.request(
          `https://api.example.test/auth/session/${action}`,
          { method: "POST", headers },
        );
        expect(response.status).toBe(500);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
      const logout = await app.request("https://api.example.test/auth/session/logout", {
        method: "POST",
        headers,
      });
      expect(logout.status).toBe(200);
      expect(logout.headers.getSetCookie().length).toBe(3);
      expect(logout.headers.get("cache-control")).toContain("no-store");
      expect(logout.headers.getSetCookie().every((v) => v.includes("Max-Age=0"))).toBe(true);
      expect(
        (
          await app.request("https://api.example.test/users/me", {
            headers: { cookie: accessCookie },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("https://api.example.test/auth/session/renew", {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("https://api.example.test/auth/session/logout", {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(200);
    });
  });
});
