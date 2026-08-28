import pg from "pg";

const APP_ID = "cmsw5pis300b80cladbxx7bsr";
const AUTH_ORIGIN = "https://auth.privy.io";
const API_ORIGIN = "https://api.privy.io";
const WEB_ORIGIN = "https://web-next-staging.pirate.sc";
const roles = ["OWNER", "MEMBER", "VIEWER"] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value === "PENDING") throw new Error(`${name} is required.`);
  return value;
}

function connectionString(): string {
  const url = new URL(required("CONTROL_PLANE_POSTGRES_ADMIN_URL"));
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  return url.toString();
}

function tokenSubject(token: string): string {
  const part = token.split(".")[1];
  if (!part) throw new Error("Privy access token is malformed.");
  const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (payload === null || typeof payload !== "object" || !("sub" in payload)) {
    throw new Error("Privy access token has no subject.");
  }
  const subject = (payload as { sub?: unknown }).sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("Privy access token has no subject.");
  }
  return subject;
}

async function authenticate(
  role: (typeof roles)[number],
): Promise<{ token: string; subject: string }> {
  const response = await fetch(`${AUTH_ORIGIN}/api/v1/passwordless/authenticate`, {
    method: "POST",
    headers: { "privy-app-id": APP_ID, "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({
      email: required(`MODERATION_E2E_${role}_EMAIL`),
      code: required(`MODERATION_E2E_${role}_OTP`),
    }),
  });
  if (!response.ok) throw new Error(`Privy ${role.toLowerCase()} authentication failed.`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("Privy authentication returned no token.");
  return { token: body.token, subject: tokenSubject(body.token) };
}

function embeddedIndices(document: unknown): Set<number> {
  if (document === null || typeof document !== "object" || !("linked_accounts" in document)) {
    throw new Error("Privy user document is malformed.");
  }
  const accounts = (document as { linked_accounts?: unknown }).linked_accounts;
  if (!Array.isArray(accounts)) throw new Error("Privy user document is malformed.");
  return new Set(
    accounts.flatMap((account) => {
      if (account === null || typeof account !== "object" || Array.isArray(account)) return [];
      const wallet = account as Record<string, unknown>;
      return wallet.type === "wallet" &&
        wallet.chain_type === "ethereum" &&
        wallet.wallet_client === "privy" &&
        wallet.wallet_client_type === "privy" &&
        wallet.connector_type === "embedded" &&
        wallet.imported === false &&
        Number.isSafeInteger(wallet.wallet_index)
        ? [wallet.wallet_index as number]
        : [];
    }),
  );
}

export async function provisionModerationStagingWallets(args: readonly string[]): Promise<void> {
  if (
    process.env.API_NEXT_ENV !== "staging" ||
    !args.includes("--confirm-staging-wallet-provisioning")
  ) {
    throw new Error("Staging wallet provisioning requires explicit confirmation.");
  }
  const secret = required("PRIVY_APP_SECRET");
  const authorization = `Basic ${btoa(`${APP_ID}:${secret}`)}`;
  const database = new pg.Client({ connectionString: connectionString() });
  await database.connect();
  try {
    const results: { role: string; reserved_index: number; created_wallets: number }[] = [];
    for (const role of roles) {
      const { subject } = await authenticate(role);
      const reservation = await database.query<{
        hd_wallet_index: string;
        persona_status: string;
        assignment_status: string;
      }>(
        `SELECT assignment.hd_wallet_index::text,
                persona.status AS persona_status,
                assignment.status AS assignment_status
           FROM identity_credentials credential
           JOIN personas persona ON persona.account_id = credential.canonical_user_id
           JOIN persona_wallet_assignments assignment ON assignment.persona_id = persona.persona_id
          WHERE credential.provider = 'privy' AND credential.provider_app_id = $1
            AND credential.provider_subject = $2 AND credential.status = 'active'
          ORDER BY assignment.hd_wallet_index LIMIT 1`,
        [APP_ID, subject],
      );
      const row = reservation.rows[0];
      const target = Number(row?.hd_wallet_index);
      if (!Number.isSafeInteger(target) || target < 0)
        throw new Error("Wallet reservation missing.");
      if (row?.persona_status === "active" && row.assignment_status === "active") {
        results.push({ role: role.toLowerCase(), reserved_index: target, created_wallets: 0 });
        continue;
      }
      if (row?.persona_status !== "pending_wallet" || row.assignment_status !== "pending") {
        throw new Error("Wallet reservation has an invalid state.");
      }
      const userResponse = await fetch(
        `${AUTH_ORIGIN}/api/v1/users/${encodeURIComponent(subject)}`,
        {
          headers: { authorization, "privy-app-id": APP_ID },
        },
      );
      if (!userResponse.ok) throw new Error("Privy user lookup failed.");
      const present = embeddedIndices(await userResponse.json());
      let created = 0;
      for (let index = 0; index <= target; index += 1) {
        if (present.has(index)) continue;
        if (index !== 0) {
          throw new Error("Server-side staging provisioning supports only the first wallet.");
        }
        const response = await fetch(
          `${API_ORIGIN}/v1/users/${encodeURIComponent(subject)}/wallets`,
          {
            method: "POST",
            headers: { authorization, "content-type": "application/json", "privy-app-id": APP_ID },
            body: JSON.stringify({ wallets: [{ chain_type: "ethereum" }] }),
          },
        );
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          const code = typeof failure.code === "string" ? failure.code : "unknown";
          const type = typeof failure.type === "string" ? failure.type : "unknown";
          const fields = Object.keys(failure).sort().join(",");
          const cause =
            typeof failure.cause === "string"
              ? failure.cause.replace(/did:privy:[A-Za-z0-9]+/gu, "[subject]").slice(0, 240)
              : "unknown";
          throw new Error(
            `Privy wallet provisioning failed at index ${index}: HTTP ${response.status}, code=${code}, type=${type}, fields=${fields}, cause=${cause}.`,
          );
        }
        created += 1;
      }
      results.push({ role: role.toLowerCase(), reserved_index: target, created_wallets: created });
    }
    console.log(JSON.stringify({ environment: "staging", roles: results }));
  } finally {
    await database.end();
  }
}

if (import.meta.main) {
  await provisionModerationStagingWallets(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Staging wallet provisioning failed.");
    process.exitCode = 1;
  });
}
