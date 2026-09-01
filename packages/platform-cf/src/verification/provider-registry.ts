import {
  makeVerificationProviderRegistry,
  type VerificationProviderAdapter,
} from "@pirate/application/verification";
import { Effect } from "effect";
import { makeSelfPassProvider } from "./providers/self-pass.ts";
import {
  makeVeryOauthFetchTransport,
  makeVeryOauthProvider,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_SESSION_TTL_SECONDS,
  type VeryOauthIdTokenVerifier,
  type VeryOauthJwksFetch,
  type VeryOauthTransport,
} from "./providers/very-oauth.ts";
import {
  makeVeryWebFetchTransport,
  makeVeryWebProvider,
  type VeryWebTransport,
} from "./providers/very-web.ts";
import {
  makeZkPassportProvider,
  makeZkPassportVerifierTransport,
  type ZkPassportVerifierTransport,
} from "./providers/zkpassport.ts";

const SELF_PASS_SESSION_TTL_MS = 15 * 60 * 1_000;

export interface PlatformVerificationProviderOptions {
  readonly self_pass?: Readonly<{
    readonly callback_origin: string;
    readonly app_name: string;
    readonly mock_passport: boolean;
  }>;
  /** ZKPassport remains absent unless every verifier credential is supplied. */
  readonly zkpassport?: Readonly<{
    readonly domain: string;
    readonly name: string;
    readonly logo?: string;
    readonly verifier_url?: string;
    readonly verifier_shared_secret?: string;
    readonly verifier_response_signing_secret?: string;
    readonly verifier_response_signing_key_id?: string;
    readonly previous_verifier_response_signing_key?: Readonly<{
      readonly key_id: string;
      readonly secret: string;
      readonly valid_until: string;
    }>;
    readonly verifier?: ZkPassportVerifierTransport;
    readonly dev_mode?: boolean;
  }>;
  /** Very OAuth remains absent unless every provider credential is supplied. */
  readonly very_oauth?: Readonly<{
    readonly authorization_endpoint: string;
    readonly token_endpoint: string;
    readonly userinfo_endpoint: string;
    readonly issuer: string;
    readonly jwks_url: string;
    readonly client_id: string;
    readonly client_secret: string;
    readonly redirect_uri: string;
    readonly sealing_key: Uint8Array;
    readonly transport?: VeryOauthTransport;
    readonly jwks_fetch?: VeryOauthJwksFetch;
    readonly id_token_verifier?: VeryOauthIdTokenVerifier;
  }>;
  /** Very web remains absent unless every server-side web credential is supplied. */
  readonly very_web?: Readonly<{
    readonly app_id: string;
    readonly api_url: string;
    readonly verify_url: string;
    readonly bridge_api_url: string;
    readonly sealing_key: Uint8Array;
    readonly transport?: VeryWebTransport;
  }>;
  readonly callback_credential_headers?: readonly string[];
}

function sha256(value: string) {
  return Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

function selfPassAdapter(config: NonNullable<PlatformVerificationProviderOptions["self_pass"]>) {
  return makeSelfPassProvider({
    ...config,
    clock: {
      now: () => new Date().toISOString(),
      expiresAt: (now) => new Date(Date.parse(now) + SELF_PASS_SESSION_TTL_MS).toISOString(),
    },
    identifiers: {
      next: (kind) => (kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`),
    },
    digest: { digest: sha256 },
  });
}

function validZkPassportOptions(
  options: NonNullable<PlatformVerificationProviderOptions["zkpassport"]>,
): boolean {
  const signingSecret = options.verifier_response_signing_secret;
  const signingKeyId = options.verifier_response_signing_key_id;
  if (
    options.domain.trim() === "" ||
    options.name.trim() === "" ||
    signingSecret === undefined ||
    signingSecret.trim() === "" ||
    signingSecret.trim() !== signingSecret ||
    signingKeyId === undefined ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(signingKeyId)
  )
    return false;
  if (options.verifier === undefined) {
    const bearer = options.verifier_shared_secret;
    if (
      options.verifier_url === undefined ||
      options.verifier_url.trim() === "" ||
      bearer === undefined ||
      bearer.trim() === "" ||
      bearer.trim() !== bearer ||
      bearer === signingSecret
    )
      return false;
  }
  const previous = options.previous_verifier_response_signing_key;
  return (
    previous === undefined ||
    (previous.secret.trim() !== "" &&
      previous.secret.trim() === previous.secret &&
      previous.secret !== signingSecret &&
      previous.secret !== options.verifier_shared_secret &&
      /^[A-Za-z0-9._-]{1,128}$/.test(previous.key_id) &&
      previous.key_id !== signingKeyId &&
      Number.isFinite(Date.parse(previous.valid_until)) &&
      new Date(Date.parse(previous.valid_until)).toISOString() === previous.valid_until)
  );
}

function validHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function validConfigString(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function validVeryOauthOptions(
  options: NonNullable<PlatformVerificationProviderOptions["very_oauth"]>,
): boolean {
  return (
    options.sealing_key instanceof Uint8Array &&
    options.sealing_key.byteLength === 32 &&
    validConfigString(options.client_id) &&
    validConfigString(options.client_secret) &&
    validHttpsUrl(options.authorization_endpoint) &&
    validHttpsUrl(options.token_endpoint) &&
    validHttpsUrl(options.userinfo_endpoint) &&
    options.issuer === VERY_OAUTH_ISSUER &&
    validHttpsUrl(options.jwks_url) &&
    validHttpsUrl(options.redirect_uri)
  );
}

export function validVeryWebOptions(
  options: NonNullable<PlatformVerificationProviderOptions["very_web"]>,
): boolean {
  return (
    options.sealing_key instanceof Uint8Array &&
    options.sealing_key.byteLength === 32 &&
    validConfigString(options.app_id) &&
    validHttpsUrl(options.api_url) &&
    validHttpsUrl(options.verify_url) &&
    validHttpsUrl(options.bridge_api_url)
  );
}

function veryOauthAdapter(config: NonNullable<PlatformVerificationProviderOptions["very_oauth"]>) {
  return makeVeryOauthProvider({
    authorization_endpoint: config.authorization_endpoint,
    token_endpoint: config.token_endpoint,
    userinfo_endpoint: config.userinfo_endpoint,
    issuer: config.issuer,
    jwks_url: config.jwks_url,
    client_id: config.client_id,
    client_secret: config.client_secret,
    redirect_uri: config.redirect_uri,
    sealing_key: config.sealing_key,
    transport: config.transport ?? makeVeryOauthFetchTransport(),
    ...(config.id_token_verifier === undefined
      ? {}
      : { id_token_verifier: config.id_token_verifier }),
    ...(config.jwks_fetch === undefined ? {} : { jwks_fetch: config.jwks_fetch }),
    clock: {
      now: () => new Date().toISOString(),
      expiresAt: (now) =>
        new Date(Date.parse(now) + VERY_OAUTH_SESSION_TTL_SECONDS * 1_000).toISOString(),
    },
    identifiers: {
      next: (kind) => (kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`),
    },
    randomness: {
      bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    },
    digest: { digest: sha256 },
  });
}

function veryWebAdapter(config: NonNullable<PlatformVerificationProviderOptions["very_web"]>) {
  return makeVeryWebProvider({
    app_id: config.app_id,
    api_url: config.api_url,
    verify_url: config.verify_url,
    bridge_api_url: config.bridge_api_url,
    sealing_key: config.sealing_key,
    transport: config.transport ?? makeVeryWebFetchTransport(),
    clock: {
      now: () => new Date().toISOString(),
      expiresAt: (now) => new Date(Date.parse(now) + 300 * 1_000).toISOString(),
    },
    identifiers: {
      next: (kind) => (kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`),
    },
    randomness: {
      bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    },
    digest: { digest: sha256 },
  });
}

/**
 * The single production assembly point for provider adapters. Real providers
 * are added to this local list only after passing the shared conformance kit.
 */
export function makePlatformVerificationProviderRegistry(
  options: PlatformVerificationProviderOptions = {},
) {
  const providers: readonly VerificationProviderAdapter[] = [
    ...(options.self_pass === undefined ? [] : [selfPassAdapter(options.self_pass)]),
    ...(options.zkpassport === undefined || !validZkPassportOptions(options.zkpassport)
      ? []
      : [
          makeZkPassportProvider({
            domain: options.zkpassport.domain,
            name: options.zkpassport.name,
            ...(options.zkpassport.logo === undefined ? {} : { logo: options.zkpassport.logo }),
            verifier:
              options.zkpassport.verifier ??
              makeZkPassportVerifierTransport({
                endpoint: options.zkpassport.verifier_url as string,
                shared_secret: options.zkpassport.verifier_shared_secret as string,
              }),
            ...(options.zkpassport.dev_mode === undefined
              ? {}
              : { dev_mode: options.zkpassport.dev_mode }),
            clock: {
              now: () => new Date().toISOString(),
              expiresAt: (now) =>
                new Date(Date.parse(now) + SELF_PASS_SESSION_TTL_MS).toISOString(),
            },
            identifiers: {
              next: (kind) =>
                kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`,
            },
            digest: { digest: sha256 },
            verifier_response_signing_secret:
              options.zkpassport.verifier_response_signing_secret ?? "",
            verifier_response_signing_key_id:
              options.zkpassport.verifier_response_signing_key_id ?? "",
            ...(options.zkpassport.previous_verifier_response_signing_key === undefined
              ? {}
              : {
                  previous_verifier_response_signing_key:
                    options.zkpassport.previous_verifier_response_signing_key,
                }),
          }),
        ]),
    ...(options.very_oauth === undefined || !validVeryOauthOptions(options.very_oauth)
      ? []
      : [veryOauthAdapter(options.very_oauth)]),
    ...(options.very_web === undefined || !validVeryWebOptions(options.very_web)
      ? []
      : [veryWebAdapter(options.very_web)]),
  ];
  return makeVerificationProviderRegistry(providers, {
    now: Date.now,
    ...(options.callback_credential_headers === undefined
      ? {}
      : { callbackCredentialHeaders: options.callback_credential_headers }),
  });
}
