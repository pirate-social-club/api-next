import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  makePlatformVerificationProviderRegistry,
  validVeryOauthOptions,
} from "./provider-registry.ts";

const VERY_OAUTH_OPTIONS = {
  authorization_endpoint: "https://connect.very.org/oauth/authorize",
  token_endpoint: "https://api.very.org/oauth2/token",
  userinfo_endpoint: "https://api.very.org/oauth2/userinfo",
  issuer: "https://connect.very.org",
  jwks_url: "https://connect.very.org/.well-known/jwks.json",
  client_id: "pirate-client",
  client_secret: "client-secret",
  redirect_uri: "https://api.pirate.test/verification/very/callback",
  sealing_key: new Uint8Array(32).fill(7),
} as const;

describe("platform verification provider registry", () => {
  test("registers Self Pass only when explicitly configured", async () => {
    const disabled = await Effect.runPromise(makePlatformVerificationProviderRegistry());
    expect(disabled.list()).toEqual([]);

    const enabled = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        self_pass: {
          callback_origin: "https://api.example",
          app_name: "Pirate",
          mock_passport: false,
        },
      }),
    );
    expect(enabled.list()).toEqual([
      expect.objectContaining({
        provider_id: "self.pass",
        callback_mode: "session_bound_proof",
        callback_header_allowlist: [],
      }),
    ]);
    await expect(Effect.runPromise(enabled.resolve("self.pass"))).resolves.toBeDefined();
  });

  test("keeps ZKPassport disabled until bearer and response-signing credentials are complete", async () => {
    const missingSigningKey = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        zkpassport: {
          domain: "api.example",
          name: "Pirate",
          verifier_url: "https://verifier.example/verify",
          verifier_shared_secret: "bearer-secret",
          verifier_response_signing_secret: "response-secret",
        },
      }),
    );
    expect(missingSigningKey.list()).toEqual([]);

    const enabled = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        zkpassport: {
          domain: "api.example",
          name: "Pirate",
          verifier_url: "https://verifier.example/verify",
          verifier_shared_secret: "bearer-secret",
          verifier_response_signing_secret: "response-secret",
          verifier_response_signing_key_id: "key-2026-08",
        },
      }),
    );
    expect(enabled.list()).toEqual([expect.objectContaining({ provider_id: "zkpassport" })]);

    const reusedSecret = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        zkpassport: {
          domain: "api.example",
          name: "Pirate",
          verifier_url: "https://verifier.example/verify",
          verifier_shared_secret: "same-secret",
          verifier_response_signing_secret: "same-secret",
          verifier_response_signing_key_id: "key-2026-08",
        },
      }),
    );
    expect(reusedSecret.list()).toEqual([]);

    const partialPrevious = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        zkpassport: {
          domain: "api.example",
          name: "Pirate",
          verifier_url: "https://verifier.example/verify",
          verifier_shared_secret: "bearer-secret",
          verifier_response_signing_secret: "response-secret",
          verifier_response_signing_key_id: "key-2026-08",
          previous_verifier_response_signing_key: {
            key_id: "key-2026-07",
            secret: "response-secret",
            valid_until: "not-an-instant",
          },
        },
      }),
    );
    expect(partialPrevious.list()).toEqual([]);

    const rotationReady = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        zkpassport: {
          domain: "api.example",
          name: "Pirate",
          verifier_url: "https://verifier.example/verify",
          verifier_shared_secret: "bearer-secret",
          verifier_response_signing_secret: "response-secret",
          verifier_response_signing_key_id: "key-2026-08",
          previous_verifier_response_signing_key: {
            key_id: "key-2026-07",
            secret: "previous-response-secret",
            valid_until: "2099-01-01T00:30:00.000Z",
          },
        },
      }),
    );
    expect(rotationReady.list()).toEqual([expect.objectContaining({ provider_id: "zkpassport" })]);
  });

  test("keeps Very OAuth disabled on invalid configuration and registers no route or transport call", async () => {
    expect(validVeryOauthOptions(VERY_OAUTH_OPTIONS)).toBe(true);
    expect(validVeryOauthOptions({ ...VERY_OAUTH_OPTIONS, client_secret: " client-secret" })).toBe(
      false,
    );
    expect(validVeryOauthOptions({ ...VERY_OAUTH_OPTIONS, sealing_key: new Uint8Array(31) })).toBe(
      false,
    );
    expect(validVeryOauthOptions({ ...VERY_OAUTH_OPTIONS, issuer: "https://wrong.example" })).toBe(
      false,
    );

    const invalid = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        very_oauth: { ...VERY_OAUTH_OPTIONS, client_id: " pirate-client" },
      }),
    );
    expect(invalid.list()).toEqual([]);

    const enabled = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({ very_oauth: VERY_OAUTH_OPTIONS }),
    );
    expect(enabled.list()).toEqual([
      expect.objectContaining({
        provider_id: "very.oauth",
        supported_methods: ["palm_oauth"],
        callback_mode: "none",
      }),
    ]);
  });
});
