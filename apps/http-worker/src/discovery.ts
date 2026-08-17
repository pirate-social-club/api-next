/**
 * Pure OAuth/OIDC discovery metadata preparation.
 *
 * Discovery identity is deliberately supplied by the composition owner. This
 * module never derives an origin from a request, a Host header, CORS, or a
 * Worker name. Keeping that boundary explicit also lets the coordinator defer
 * installing these routes until the public-origin decision is ratified.
 */

export type DiscoveryEnvironment = "local" | "test" | "development" | "staging" | "production";

export interface DiscoveryMetadataSettingsInput {
  readonly publicOrigin: unknown;
  readonly issuer: unknown;
  readonly environment?: unknown;
}

/** Public name for the settings accepted at the factory boundary. */
export type DiscoveryMetadataSettings = DiscoveryMetadataSettingsInput;

export interface ValidatedDiscoveryMetadataSettings {
  readonly publicOrigin: string;
  readonly issuer: string;
  readonly environment: DiscoveryEnvironment;
}

export interface OAuthProtectedResourceDocument {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly jwks_uri: string;
  readonly bearer_methods_supported: readonly ["header"];
  readonly scopes_supported: readonly ["pirate_app_session"];
}

export interface OAuthAuthorizationServerDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly grant_types_supported: readonly [
    "urn:pirate:params:oauth:grant-type:session-exchange",
  ];
  readonly response_types_supported: readonly string[];
  readonly scopes_supported: readonly ["pirate_app_session"];
  readonly token_endpoint_auth_methods_supported: readonly ["none"];
  readonly bearer_methods_supported: readonly ["header"];
  readonly protected_resources: readonly string[];
}

export interface OpenIdConfigurationDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
  readonly subject_types_supported: readonly ["public"];
  readonly id_token_signing_alg_values_supported: readonly ["RS256"];
  readonly scopes_supported: readonly ["pirate_app_session"];
}

export interface DiscoveryMetadataDocuments {
  readonly oauthProtectedResource: OAuthProtectedResourceDocument;
  readonly oauthAuthorizationServer: OAuthAuthorizationServerDocument;
  readonly openIdConfiguration: OpenIdConfigurationDocument;
}

/**
 * The handler argument is intentionally opaque. The handlers accept the
 * transport's decoded request shape when installed, but do not inspect it.
 */
export type DiscoveryHandler<T> = (_request?: unknown) => T;

export interface DiscoveryMetadataHandlers {
  readonly GetOAuthProtectedResource: DiscoveryHandler<OAuthProtectedResourceDocument>;
  readonly GetOAuthAuthorizationServer: DiscoveryHandler<OAuthAuthorizationServerDocument>;
  readonly GetOpenIdConfiguration: DiscoveryHandler<OpenIdConfigurationDocument>;
}

export interface DiscoveryMetadata {
  readonly settings: ValidatedDiscoveryMetadataSettings;
  readonly documents: DiscoveryMetadataDocuments;
  readonly handlers: DiscoveryMetadataHandlers;
  readonly oauthProtectedResource: OAuthProtectedResourceDocument;
  readonly oauthAuthorizationServer: OAuthAuthorizationServerDocument;
  readonly openIdConfiguration: OpenIdConfigurationDocument;
  readonly GetOAuthProtectedResource: DiscoveryHandler<OAuthProtectedResourceDocument>;
  readonly GetOAuthAuthorizationServer: DiscoveryHandler<OAuthAuthorizationServerDocument>;
  readonly GetOpenIdConfiguration: DiscoveryHandler<OpenIdConfigurationDocument>;
}

const WELL_KNOWN_JWKS_PATH = "/.well-known/jwks.json";
const SESSION_EXCHANGE_PATH = "/auth/session/exchange";
const SESSION_EXCHANGE_GRANT = "urn:pirate:params:oauth:grant-type:session-exchange" as const;

const isLocalEnvironment = (environment: DiscoveryEnvironment): boolean =>
  environment === "local" || environment === "test" || environment === "development";

const parseEnvironment = (value: unknown): DiscoveryEnvironment => {
  if (value === undefined) return "production";
  switch (value) {
    case "local":
      return "local";
    case "test":
      return "test";
    case "development":
      return "development";
    case "staging":
      return "staging";
    case "production":
      return "production";
    default:
      throw new Error("Discovery metadata environment is invalid");
  }
};

const isLoopbackHostname = (hostname: string): boolean => {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (unbracketed === "localhost" || unbracketed === "::1") return true;

  const octets = unbracketed.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d+$/u.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
};

/**
 * Normalize one injected origin and reject anything that is not an origin.
 * A single trailing slash is accepted because URL.origin normalizes it away;
 * every other path, query, or fragment is rejected.
 */
export function normalizeDiscoveryOrigin(
  value: unknown,
  environment: DiscoveryEnvironment = "production",
  field = "origin",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Discovery metadata ${field} is required`);
  }

  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Discovery metadata ${field} must be an absolute URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Discovery metadata ${field} must use HTTP or HTTPS`);
  }
  if (url.origin === "null" || url.hostname === "") {
    throw new Error(`Discovery metadata ${field} must have a valid host`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Discovery metadata ${field} must not contain credentials`);
  }
  if (url.pathname !== "/" || input.includes("?") || input.includes("#")) {
    throw new Error(`Discovery metadata ${field} must be an origin without a path, query, or fragment`);
  }
  if (
    url.protocol === "http:" &&
    !(isLocalEnvironment(environment) && isLoopbackHostname(url.hostname.toLowerCase()))
  ) {
    throw new Error(`Discovery metadata ${field} must use HTTPS outside local development`);
  }

  return url.origin;
}

/** Validate and normalize the explicitly injected discovery identity. */
export function validateDiscoveryMetadataSettings(
  settings: DiscoveryMetadataSettingsInput,
): ValidatedDiscoveryMetadataSettings {
  const environment = parseEnvironment(settings.environment);
  const publicOrigin = normalizeDiscoveryOrigin(settings.publicOrigin, environment, "publicOrigin");
  const issuer = normalizeDiscoveryOrigin(settings.issuer, environment, "issuer");
  if (issuer !== publicOrigin) {
    throw new Error("Discovery metadata issuer must equal publicOrigin");
  }
  return Object.freeze({ publicOrigin, issuer, environment });
}

const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

const makeDocuments = (origin: string): DiscoveryMetadataDocuments => {
  const jwksUri = `${origin}${WELL_KNOWN_JWKS_PATH}`;
  const sessionExchange = `${origin}${SESSION_EXCHANGE_PATH}`;
  const scopesSupported = Object.freeze(["pirate_app_session"] as const);
  const bearerMethodsSupported = Object.freeze(["header"] as const);
  const responseTypesSupported = freezeArray<string>([]);

  const oauthProtectedResource: OAuthProtectedResourceDocument = Object.freeze({
    resource: origin,
    authorization_servers: freezeArray([origin]),
    jwks_uri: jwksUri,
    bearer_methods_supported: bearerMethodsSupported,
    scopes_supported: scopesSupported,
  });
  const oauthAuthorizationServer: OAuthAuthorizationServerDocument = Object.freeze({
    issuer: origin,
    authorization_endpoint: sessionExchange,
    token_endpoint: sessionExchange,
    jwks_uri: jwksUri,
    grant_types_supported: Object.freeze([SESSION_EXCHANGE_GRANT] as const),
    response_types_supported: responseTypesSupported,
    scopes_supported: scopesSupported,
    token_endpoint_auth_methods_supported: Object.freeze(["none"] as const),
    bearer_methods_supported: bearerMethodsSupported,
    protected_resources: freezeArray([origin]),
  });
  const openIdConfiguration: OpenIdConfigurationDocument = Object.freeze({
    issuer: origin,
    authorization_endpoint: sessionExchange,
    token_endpoint: sessionExchange,
    jwks_uri: jwksUri,
    response_types_supported: responseTypesSupported,
    subject_types_supported: Object.freeze(["public"] as const),
    id_token_signing_alg_values_supported: Object.freeze(["RS256"] as const),
    scopes_supported: scopesSupported,
  });

  return Object.freeze({
    oauthProtectedResource,
    oauthAuthorizationServer,
    openIdConfiguration,
  });
};

/**
 * Prepare the contracted discovery documents and pure handlers. Every handler
 * returns metadata derived only from the validated settings captured here.
 */
export function makeDiscoveryMetadata(
  settings: DiscoveryMetadataSettingsInput,
): DiscoveryMetadata {
  const validated = validateDiscoveryMetadataSettings(settings);
  const documents = makeDocuments(validated.publicOrigin);
  const GetOAuthProtectedResource: DiscoveryHandler<OAuthProtectedResourceDocument> = () =>
    documents.oauthProtectedResource;
  const GetOAuthAuthorizationServer: DiscoveryHandler<OAuthAuthorizationServerDocument> = () =>
    documents.oauthAuthorizationServer;
  const GetOpenIdConfiguration: DiscoveryHandler<OpenIdConfigurationDocument> = () =>
    documents.openIdConfiguration;
  const handlers: DiscoveryMetadataHandlers = Object.freeze({
    GetOAuthProtectedResource,
    GetOAuthAuthorizationServer,
    GetOpenIdConfiguration,
  });

  return Object.freeze({
    settings: validated,
    documents,
    handlers,
    oauthProtectedResource: documents.oauthProtectedResource,
    oauthAuthorizationServer: documents.oauthAuthorizationServer,
    openIdConfiguration: documents.openIdConfiguration,
    GetOAuthProtectedResource,
    GetOAuthAuthorizationServer,
    GetOpenIdConfiguration,
  });
}

/** Named for callers that only need the handler/document preparation seam. */
export const makeDiscoveryHandlers = makeDiscoveryMetadata;
export const makeDiscoveryMetadataHandlers = makeDiscoveryMetadata;
