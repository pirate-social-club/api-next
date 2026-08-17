import { describe, expect, test } from "bun:test";
import { makeDiscoveryMetadata, validateDiscoveryMetadataSettings } from "./discovery.ts";

const publicOrigin = "https://api.example.test";

describe("discovery metadata preparation", () => {
  test("returns the exact old-source-compatible OAuth and OIDC documents", () => {
    const discovery = makeDiscoveryMetadata({ publicOrigin, issuer: publicOrigin });

    expect(discovery.documents.oauthProtectedResource).toEqual({
      resource: publicOrigin,
      authorization_servers: [publicOrigin],
      jwks_uri: `${publicOrigin}/.well-known/jwks.json`,
      bearer_methods_supported: ["header"],
      scopes_supported: ["pirate_app_session"],
    });
    expect(discovery.documents.oauthAuthorizationServer).toEqual({
      issuer: publicOrigin,
      authorization_endpoint: `${publicOrigin}/auth/session/exchange`,
      token_endpoint: `${publicOrigin}/auth/session/exchange`,
      jwks_uri: `${publicOrigin}/.well-known/jwks.json`,
      grant_types_supported: ["urn:pirate:params:oauth:grant-type:session-exchange"],
      response_types_supported: [],
      scopes_supported: ["pirate_app_session"],
      token_endpoint_auth_methods_supported: ["none"],
      bearer_methods_supported: ["header"],
      protected_resources: [publicOrigin],
    });
    expect(discovery.documents.openIdConfiguration).toEqual({
      issuer: publicOrigin,
      authorization_endpoint: `${publicOrigin}/auth/session/exchange`,
      token_endpoint: `${publicOrigin}/auth/session/exchange`,
      jwks_uri: `${publicOrigin}/.well-known/jwks.json`,
      response_types_supported: [],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["pirate_app_session"],
    });
  });

  test("normalizes the canonical origin before deriving every URL", () => {
    const discovery = makeDiscoveryMetadata({
      publicOrigin: " HTTPS://API.Example.Test:443/ ",
      issuer: "https://api.example.test",
      environment: "production",
    });

    expect(discovery.settings).toEqual({
      publicOrigin,
      issuer: publicOrigin,
      environment: "production",
    });
    expect(discovery.oauthProtectedResource.resource).toBe(publicOrigin);
    expect(discovery.oauthAuthorizationServer.issuer).toBe(publicOrigin);
    expect(discovery.oauthAuthorizationServer.protected_resources).toEqual([publicOrigin]);
  });

  test("handlers ignore request-host-shaped input and remain deterministic", () => {
    const discovery = makeDiscoveryMetadata({ publicOrigin, issuer: publicOrigin });
    const expected = discovery.documents;

    expect(
      discovery.handlers.GetOAuthProtectedResource({
        requestUrl: "https://attacker.example",
        host: "attacker.example",
        corsOrigin: "https://attacker.example",
      }),
    ).toEqual(expected.oauthProtectedResource);
    expect(
      discovery.handlers.GetOAuthAuthorizationServer({
        requestUrl: "http://127.0.0.1:8787",
        host: "127.0.0.1:8787",
      }),
    ).toEqual(expected.oauthAuthorizationServer);
    expect(
      discovery.handlers.GetOpenIdConfiguration({
        requestUrl: "https://another.example",
        host: "another.example",
      }),
    ).toEqual(expected.openIdConfiguration);
  });

  test("requires the issuer to equal the normalized public origin", () => {
    expect(() =>
      makeDiscoveryMetadata({
        publicOrigin,
        issuer: "https://issuer.example.test",
      }),
    ).toThrow("issuer must equal publicOrigin");
    expect(() =>
      makeDiscoveryMetadata({
        publicOrigin: "https://API.Example.Test/",
        issuer: "https://api.example.test/other",
      }),
    ).toThrow("issuer must be an origin");
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["relative", "api.example.test"],
    ["credentials", "https://user:password@api.example.test"],
    ["path", "https://api.example.test/api"],
    ["query", "https://api.example.test?tenant=one"],
    ["fragment", "https://api.example.test#identity"],
    ["invalid", "https://[not-a-host"],
  ] as const)("rejects %s public origins", (_name: string, value: unknown) => {
    expect(() => makeDiscoveryMetadata({ publicOrigin: value, issuer: publicOrigin })).toThrow();
  });

  test("rejects the same malformed origin forms for issuer", () => {
    for (const issuer of [
      undefined,
      null,
      "",
      "api.example.test",
      "https://user@issuer.example.test",
      "https://issuer.example.test/path",
      "https://issuer.example.test?query",
      "https://issuer.example.test#fragment",
      "not a URL",
    ]) {
      expect(() => makeDiscoveryMetadata({ publicOrigin, issuer })).toThrow();
    }
  });

  test("requires HTTPS outside local development and permits explicit loopback HTTP locally", () => {
    expect(
      makeDiscoveryMetadata({
        publicOrigin: "http://localhost:8787",
        issuer: "http://localhost:8787",
        environment: "development",
      }).settings.publicOrigin,
    ).toBe("http://localhost:8787");
    expect(
      makeDiscoveryMetadata({
        publicOrigin: "http://127.0.0.1:8787",
        issuer: "http://127.0.0.1:8787",
        environment: "test",
      }).settings.publicOrigin,
    ).toBe("http://127.0.0.1:8787");
    expect(
      makeDiscoveryMetadata({
        publicOrigin: "http://[::1]:8787",
        issuer: "http://[::1]:8787",
        environment: "local",
      }).settings.publicOrigin,
    ).toBe("http://[::1]:8787");

    for (const environment of ["staging", "production"] as const) {
      expect(() =>
        makeDiscoveryMetadata({
          publicOrigin: "http://127.0.0.1:8787",
          issuer: "http://127.0.0.1:8787",
          environment,
        }),
      ).toThrow("must use HTTPS");
    }
    expect(() =>
      makeDiscoveryMetadata({
        publicOrigin: "http://api.example.test",
        issuer: "http://api.example.test",
        environment: "development",
      }),
    ).toThrow("must use HTTPS");
  });

  test("rejects missing or unknown environment rather than weakening HTTPS validation", () => {
    expect(() =>
      validateDiscoveryMetadataSettings({
        publicOrigin: "https://api.example.test",
        issuer: "https://api.example.test",
        environment: "preview",
      }),
    ).toThrow("environment is invalid");
    expect(
      validateDiscoveryMetadataSettings({
        publicOrigin: "https://api.example.test",
        issuer: "https://api.example.test",
      }).environment,
    ).toBe("production");
    expect(() =>
      makeDiscoveryMetadata({
        publicOrigin: "http://localhost:8787",
        issuer: "http://localhost:8787",
      }),
    ).toThrow("must use HTTPS");
  });
});
