export const DEFAULT_INFISICAL_OIDC_AUDIENCE = "https://github.com/pirate-social-club";

export type OidcRequest = (input: string, init: RequestInit) => Promise<Response>;

type Environment = Readonly<Record<string, string | undefined>>;

function asObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function responseJson(
  response: Response,
  label: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return asObject(await response.json(), label);
}

export async function requestGitHubOidcToken(input: {
  readonly audience: string;
  readonly requestUrl: string;
  readonly requestToken: string;
  readonly request?: OidcRequest | undefined;
}): Promise<string> {
  const url = new URL(input.requestUrl);
  url.searchParams.set("audience", input.audience);
  const payload = await responseJson(
    await (input.request ?? fetch)(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.requestToken}`,
      },
    }),
    "GitHub OIDC request",
  );
  const token = payload.value;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GitHub OIDC response has no token");
  }
  return token;
}

export async function exchangeInfisicalOidcToken(input: {
  readonly baseUrl: string;
  readonly identityId: string;
  readonly oidcToken: string;
  readonly request?: OidcRequest | undefined;
}): Promise<string> {
  const url = `${input.baseUrl.replace(/\/$/, "")}/v1/auth/oidc-auth/login`;
  const payload = await responseJson(
    await (input.request ?? fetch)(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ identityId: input.identityId, jwt: input.oidcToken }),
    }),
    "Infisical OIDC login",
  );
  const token = payload.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Infisical OIDC response has no access token");
  }
  return token;
}

export async function resolveInfisicalAuditToken(input: {
  readonly baseUrl: string;
  readonly environment?: Environment;
  readonly request?: OidcRequest | undefined;
}): Promise<string> {
  const environment = input.environment ?? process.env;
  const explicitToken = environment.INFISICAL_AUDIT_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const identityId = environment.INFISICAL_MACHINE_IDENTITY_ID?.trim();
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
  if (!identityId || !requestUrl || !requestToken) {
    throw new Error(
      "INFISICAL_AUDIT_TOKEN or GitHub OIDC environment with INFISICAL_MACHINE_IDENTITY_ID is required",
    );
  }

  const oidcToken = await requestGitHubOidcToken({
    audience: environment.INFISICAL_OIDC_AUDIENCE?.trim() || DEFAULT_INFISICAL_OIDC_AUDIENCE,
    requestUrl,
    requestToken,
    request: input.request,
  });
  return exchangeInfisicalOidcToken({
    baseUrl: input.baseUrl,
    identityId,
    oidcToken,
    request: input.request,
  });
}
