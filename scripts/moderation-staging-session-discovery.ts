import { createHash } from "node:crypto";

const PRIVY_AUTH_ORIGIN = "https://auth.privy.io";
const STAGING_APP_ID = "cmsw5pis300b80cladbxx7bsr";
const STAGING_API_ORIGIN = "https://api-next-staging.pirate.sc";
const STAGING_WEB_ORIGIN = "https://web-next-staging.pirate.sc";

const roles = ["OWNER", "MEMBER", "VIEWER"] as const;
type Role = (typeof roles)[number];

type Environment = Readonly<Record<string, string | undefined>>;
export type SessionDiscoveryResult = Readonly<{
  environment: "staging";
  roles: readonly Readonly<{
    role: Lowercase<Role>;
    account_sha256: string;
    session_exchange_status: number;
    registration_status: number | null;
    current_user_status: number;
    attestation_status: number;
  }>[];
}>;

export class SessionDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDiscoveryError";
  }
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "" || value === "PENDING") {
    throw new SessionDiscoveryError(`${name} is missing or still PENDING.`);
  }
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value = (await response.json()) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionDiscoveryError(
      `Provider returned malformed JSON with HTTP ${response.status}.`,
    );
  }
  return value as Record<string, unknown>;
}

function sessionCookies(response: Response): string {
  const values = response.headers.getSetCookie();
  const cookies = values
    .flatMap((value) => value.split(/, (?=__Host-pirate_)/u))
    .map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .filter((value) => value.startsWith("__Host-pirate_"));
  if (cookies.length === 0) throw new SessionDiscoveryError("Session exchange returned no cookie.");
  return cookies.join("; ");
}

async function privyToken(input: {
  readonly appId: string;
  readonly email: string;
  readonly otp: string;
  readonly request: typeof fetch;
}): Promise<string> {
  const headers = {
    "privy-app-id": input.appId,
    "content-type": "application/json",
    origin: STAGING_WEB_ORIGIN,
  };
  const authResponse = await input.request(
    `${PRIVY_AUTH_ORIGIN}/api/v1/passwordless/authenticate`,
    {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({ email: input.email, code: input.otp }),
    },
  );
  if (!authResponse.ok) {
    throw new SessionDiscoveryError(
      `Privy authentication failed with HTTP ${authResponse.status}.`,
    );
  }
  const authenticated = await json(authResponse);
  if (typeof authenticated.token !== "string" || authenticated.token === "") {
    throw new SessionDiscoveryError("Privy authentication returned no access token.");
  }
  return authenticated.token;
}

export async function discoverModerationStagingSessions(
  environment: Environment = process.env,
  request: typeof fetch = fetch,
): Promise<SessionDiscoveryResult> {
  const appId = environment.PRIVY_APP_ID ?? STAGING_APP_ID;
  if (appId !== STAGING_APP_ID) throw new SessionDiscoveryError("Unexpected Privy staging app ID.");
  const results: SessionDiscoveryResult["roles"][number][] = [];

  for (const role of roles) {
    const email = required(environment, `MODERATION_E2E_${role}_EMAIL`);
    const otp = required(environment, `MODERATION_E2E_${role}_OTP`);
    const token = await privyToken({ appId, email, otp, request });
    let exchange = await request(`${STAGING_API_ORIGIN}/auth/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: STAGING_WEB_ORIGIN },
      redirect: "error",
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: token },
      }),
    });
    let registrationStatus: number | null = null;
    if (exchange.status === 401) {
      const registration = await request(`${STAGING_API_ORIGIN}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: STAGING_WEB_ORIGIN },
        redirect: "error",
        body: JSON.stringify({
          privy_access_token: token,
          minimum_age_attestation: {
            version: "minimum-age-attestation-v1",
            minimum_age: 16,
            affirmed: true,
          },
        }),
      });
      registrationStatus = registration.status;
      if (registration.ok) exchange = registration;
    }
    let currentUserStatus = 0;
    let attestationStatus = 0;
    if (exchange.ok) {
      const cookie = sessionCookies(exchange);
      const common = {
        headers: { cookie, origin: STAGING_WEB_ORIGIN },
        redirect: "error",
      } as const;
      currentUserStatus = (await request(`${STAGING_API_ORIGIN}/users/me`, common)).status;
      attestationStatus = (await request(`${STAGING_API_ORIGIN}/me/age-capability`, common)).status;
    }
    results.push({
      role: role.toLowerCase() as Lowercase<Role>,
      account_sha256: createHash("sha256").update(email, "utf8").digest("hex"),
      session_exchange_status: exchange.status,
      registration_status: registrationStatus,
      current_user_status: currentUserStatus,
      attestation_status: attestationStatus,
    });
  }
  return { environment: "staging", roles: results };
}

if (import.meta.main) {
  await discoverModerationStagingSessions()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(
        error instanceof SessionDiscoveryError ? error.message : "Session discovery failed.",
      );
      process.exitCode = 1;
    });
}
