import { spawn } from "node:child_process";

/** One-time staging Access setup. No production resource is selected or mutated. */
const ACCOUNT = "08a4c22cf52e2ecae883e36f80a33f4a";
const PROJECT = "fac45f92-9450-42fb-8c2f-f20d043fdfab";
const SECRET_PATH = "/services/api-next/operator";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const DURATION = "2160h"; // 90 days; rotation is an operational prerequisite.

type Role = Readonly<{
  name: string;
  idKey: string;
  secretKey: string;
}>;

const ROLES = [
  {
    name: "pirate-hns-staging-gateway-to-solid",
    idKey: "HNS_STAGING_GATEWAY_SOLID_ACCESS_CLIENT_ID",
    secretKey: "HNS_STAGING_GATEWAY_SOLID_ACCESS_CLIENT_SECRET",
  },
  {
    name: "pirate-hns-staging-solid-to-api",
    idKey: "HNS_COMMUNITY_APP_API_ACCESS_CLIENT_ID",
    secretKey: "HNS_COMMUNITY_APP_API_ACCESS_CLIENT_SECRET",
  },
  {
    name: "pirate-hns-staging-solid-to-authority",
    idKey: "HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_ID",
    secretKey: "HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_SECRET",
  },
] as const satisfies readonly Role[];

const APPS = [
  {
    name: "hns-community-ingress-staging",
    domain: "hns-community-ingress-staging.pirate.sc",
    roles: [ROLES[0].name],
  },
  {
    name: "hns-community-api-staging",
    domain: "hns-community-api-staging.pirate.sc",
    roles: [ROLES[1].name, ROLES[2].name],
  },
] as const;

function refuse(code: string): never {
  throw new Error(`staging_access_refused:${code}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("shape");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{32,36}$/iu.test(value)) refuse("id");
  return value;
}

function serviceValue(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{16,256}$/u.test(value)) refuse("secret_shape");
  return value;
}

async function cf(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const token = process.env.CLOUDFLARE_HNS_STAGING_ACCESS_SETUP_TOKEN;
  if (!token) refuse("setup_token_missing");
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  // Provider errors are deliberately not echoed: some APIs reflect request data.
  if (!response.ok) refuse(`cloudflare_${method}_${response.status}`);
  const result = record(await response.json());
  if (result.success !== true) refuse(`cloudflare_${method}_unsuccessful`);
  const info = result.result_info;
  if (info !== undefined && Number(record(info).total_pages ?? 1) > 1) refuse("pagination");
  return result.result;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) refuse("list_shape");
  return value.map(record);
}

async function infisical(args: string[], fd3?: string, stage = "unknown"): Promise<string> {
  // Go's CLI cannot reopen a Node socket through /dev/fd/3. Bash's here-string
  // presents an openable anonymous descriptor without putting values in argv,
  // the environment or a regular file.
  const child =
    fd3 === undefined
      ? spawn("infisical", args, { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(
          "bash",
          [
            "-c",
            'IFS= read -r -d "" payload || :; infisical "$@" 3<<< "$payload"',
            "staging-secret-custody",
            ...args,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
  if (!child.stdout || !child.stderr) refuse("secret_transport");
  const chunks: Buffer[] = [];
  child.stdout.on("data", (part: Buffer) => chunks.push(part));
  // Never forward stderr, which may contain provider error detail.
  child.stderr.resume();
  if (fd3 !== undefined) {
    if (!child.stdin) refuse("secret_transport");
    child.stdin.end(fd3);
  }
  const status = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  if (status !== 0) refuse(`secret_custody_${stage}`);
  return Buffer.concat(chunks).toString("utf8");
}

const infisicalBase = ["--env=staging", `--path=${SECRET_PATH}`, `--projectId=${PROJECT}`];

async function storePair(role: Role, clientId: string, clientSecret: string): Promise<void> {
  await infisical(
    ["secrets", "set", "--file=/dev/fd/3", ...infisicalBase, "--silent"],
    `${role.idKey}=${clientId}\n${role.secretKey}=${clientSecret}\n`,
    "set",
  );
  const foundId = await infisical(
    ["secrets", "get", role.idKey, "--plain", ...infisicalBase, "--silent"],
    undefined,
    "read_id",
  );
  const foundSecret = await infisical(
    ["secrets", "get", role.secretKey, "--plain", ...infisicalBase, "--silent"],
    undefined,
    "read_secret",
  );
  if (foundId.trim() !== clientId || foundSecret.trim() !== clientSecret) refuse("secret_readback");
}

function assertUnused(
  applications: readonly Record<string, unknown>[],
  serviceTokens: readonly Record<string, unknown>[],
  policies: readonly Record<string, unknown>[],
): void {
  const plannedNames = new Set([
    ...ROLES.map((role) => role.name),
    ...APPS.map((app) => app.name),
    ...APPS.map((app) => `${app.name}-service-auth`),
  ]);
  for (const row of [...applications, ...serviceTokens, ...policies])
    if (plannedNames.has(String(row.name))) refuse("name_already_used");
  for (const row of applications)
    if (APPS.some((app) => app.domain === row.domain)) refuse("domain_already_used");
}

async function verifyInlineApp(
  app: (typeof APPS)[number],
  appId: string,
  tokenIds: Map<string, string>,
): Promise<void> {
  const full = record(await cf(`/access/apps/${appId}`));
  requireInlineAppShape(
    {
      appId,
      name: app.name,
      domain: app.domain,
      tokenIds: app.roles.map((role) => tokenIds.get(role)),
    },
    full,
  );
  process.stdout.write(`staging_access_inline_app_verified:${app.name}:${appId}\n`);
}

export function requireInlineAppShape(
  expected: Readonly<{
    appId: string;
    name: string;
    domain: string;
    tokenIds: readonly (string | undefined)[];
  }>,
  value: unknown,
): void {
  const full = record(value);
  if (
    full.id !== expected.appId ||
    full.name !== expected.name ||
    full.domain !== expected.domain ||
    full.type !== "self_hosted" ||
    full.service_auth_401_redirect !== true ||
    full.app_launcher_visible !== false
  )
    refuse("inline_app_shape");
  const destinations = rows(full.destinations);
  if (
    destinations.length !== 1 ||
    destinations[0]?.type !== "public" ||
    destinations[0]?.uri !== expected.domain ||
    !Array.isArray(full.self_hosted_domains) ||
    full.self_hosted_domains.length !== 1 ||
    full.self_hosted_domains[0] !== expected.domain
  )
    refuse("inline_app_destination");
  const linked = rows(full.policies);
  if (linked.length !== 1) refuse("inline_policy_count");
  const policy = linked[0];
  if (
    !policy ||
    policy.name !== `${expected.name}-service-auth` ||
    policy.decision !== "non_identity" ||
    policy.precedence !== 1
  )
    refuse("inline_policy_shape");
  if (expected.tokenIds.some((tokenId) => tokenId === undefined)) refuse("inline_token_missing");
  const actual = rows(policy.include)
    .map((rule) => id(record(rule.service_token).token_id))
    .sort();
  if (actual.join(",") !== [...expected.tokenIds].sort().join(","))
    refuse("inline_policy_token_binding");
  if (Array.isArray(policy.exclude) && policy.exclude.length > 0) refuse("inline_policy_exclude");
  if (Array.isArray(policy.require) && policy.require.length > 0) refuse("inline_policy_require");
}

async function createInlineApps(
  tokenIds: Map<string, string>,
  apps: readonly (typeof APPS)[number][],
): Promise<void> {
  for (const app of apps) {
    const policyName = `${app.name}-service-auth`;
    const expectedTokenIds = app.roles.map((role) => tokenIds.get(role));
    if (expectedTokenIds.some((value) => value === undefined)) refuse("inline_token_missing");
    const created = record(
      await cf("/access/apps", "POST", {
        name: app.name,
        domain: app.domain,
        type: "self_hosted",
        app_launcher_visible: false,
        service_auth_401_redirect: true,
        policies: [
          {
            name: policyName,
            decision: "non_identity",
            include: expectedTokenIds.map((tokenId) => ({ service_token: { token_id: tokenId } })),
            precedence: 1,
          },
        ],
      }),
    );
    if (
      created.name !== app.name ||
      created.domain !== app.domain ||
      created.type !== "self_hosted"
    )
      refuse("inline_created_app_shape");
    await verifyInlineApp(app, id(created.id), tokenIds);
  }
  const applications = rows(await cf("/access/apps"));
  for (const app of APPS)
    if (
      applications.filter((row) => row.name === app.name && row.domain === app.domain).length !== 1
    )
      refuse("inline_app_readback");
  process.stdout.write("staging_access_inline_apps_created_and_read_back\n");
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--custody-probe") {
    const key = "HNS_STAGING_ACCESS_CUSTODY_PROBE";
    if (process.env[key]) refuse("probe_exists");
    await infisical(
      ["secrets", "set", "--file=/dev/fd/3", ...infisicalBase, "--silent"],
      `${key}=public-test-value\n`,
      "probe_set",
    );
    try {
      const value = await infisical(
        ["secrets", "get", key, "--plain", ...infisicalBase, "--silent"],
        undefined,
        "probe_read",
      );
      if (value.trim() !== "public-test-value") refuse("probe_mismatch");
    } finally {
      await infisical(
        ["secrets", "delete", key, "--type=shared", ...infisicalBase, "--silent"],
        undefined,
        "probe_delete",
      );
    }
    process.stdout.write("staging_access_custody_probe_passed\n");
    return;
  }
  if (
    mode !== "--dry-run" &&
    mode !== "--execute" &&
    mode !== "--inspect" &&
    mode !== "--resume-inline-apps" &&
    mode !== "--resume-inline-after-first" &&
    mode !== "--verify"
  )
    refuse("usage");
  const [applications, serviceTokens, policies] = await Promise.all([
    cf("/access/apps").then(rows),
    cf("/access/service_tokens").then(rows),
    cf("/access/policies").then(rows),
  ]);
  if (mode === "--inspect") {
    process.stdout.write(
      `${JSON.stringify({
        staging_apps: applications
          .filter(
            (app) =>
              String(app.name).includes("hns-community-") && String(app.name).endsWith("-staging"),
          )
          .map((app) => ({ name: app.name, id: app.id })),
        staging_tokens: serviceTokens
          .filter((token) => String(token.name).startsWith("pirate-hns-staging-"))
          .map((token) => ({ name: token.name, id: token.id, enabled: token.enabled })),
        staging_policies: policies
          .filter(
            (policy) =>
              String(policy.name).includes("hns-community-") &&
              String(policy.name).endsWith("-staging-service-auth"),
          )
          .map((policy) => ({ name: policy.name, id: policy.id })),
        credential_keys_present: ROLES.map((role) => ({
          role: role.name,
          id: Boolean(process.env[role.idKey]),
          secret: Boolean(process.env[role.secretKey]),
        })),
      })}\n`,
    );
    return;
  }
  if (
    mode === "--resume-inline-apps" ||
    mode === "--resume-inline-after-first" ||
    mode === "--verify"
  ) {
    if (
      policies.some((policy) =>
        APPS.some((planned) => policy.name === `${planned.name}-service-auth`),
      )
    )
      refuse("resume_policy_present");
    const stagingTokens = serviceTokens.filter((token) =>
      String(token.name).startsWith("pirate-hns-staging-"),
    );
    if (stagingTokens.length !== ROLES.length) refuse("resume_token_count");
    const tokenIds = new Map<string, string>();
    for (const role of ROLES) {
      const matches = stagingTokens.filter((token) => token.name === role.name);
      if (matches.length !== 1 || matches[0]?.enabled !== true) refuse("resume_token_state");
      const token = record(await cf(`/access/service_tokens/${id(matches[0].id)}`));
      if (
        token.name !== role.name ||
        token.client_id !== process.env[role.idKey] ||
        !process.env[role.secretKey]
      )
        refuse("resume_secret_binding");
      tokenIds.set(role.name, id(token.id));
    }
    if (mode === "--verify") {
      for (const app of APPS) {
        const matches = applications.filter(
          (row) => row.name === app.name && row.domain === app.domain,
        );
        if (matches.length !== 1) refuse("verify_app_count");
        await verifyInlineApp(app, id(matches[0]?.id), tokenIds);
      }
      process.stdout.write("staging_access_complete_readback_verified\n");
      return;
    }
    if (mode === "--resume-inline-after-first") {
      const first = APPS[0];
      const second = APPS[1];
      if (
        !first ||
        !second ||
        applications.filter((app) => app.name === first.name && app.domain === first.domain)
          .length !== 1 ||
        applications.some((app) => app.name === second.name || app.domain === second.domain)
      )
        refuse("resume_first_app_state");
      const existing = applications.find((app) => app.name === first.name);
      await verifyInlineApp(first, id(existing?.id), tokenIds);
      await createInlineApps(tokenIds, [second]);
      return;
    }
    if (mode === "--resume-inline-apps") {
      if (applications.some((app) => APPS.some((planned) => app.domain === planned.domain)))
        refuse("resume_app_present");
      await createInlineApps(tokenIds, APPS);
      return;
    }
  }
  for (const role of ROLES)
    if (process.env[role.idKey] || process.env[role.secretKey]) refuse("secret_name_present");
  assertUnused(applications, serviceTokens, policies);
  if (mode === "--dry-run") {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "staging_access_dry_run",
        existing_apps: applications.length,
        existing_tokens: serviceTokens.length,
        existing_policies: policies.length,
        planned_apps: APPS.map((app) => app.domain),
        planned_tokens: ROLES.map((role) => role.name),
        token_duration: DURATION,
      })}\n`,
    );
    return;
  }

  const tokenIds = new Map<string, string>();
  for (const role of ROLES) {
    const created = record(
      await cf("/access/service_tokens", "POST", {
        name: role.name,
        duration: DURATION,
      }),
    );
    if (created.name !== role.name) refuse("created_token_name");
    const tokenId = id(created.id);
    await storePair(role, serviceValue(created.client_id), serviceValue(created.client_secret));
    tokenIds.set(role.name, tokenId);
    process.stdout.write(`staging_access_token_custodied:${role.name}:${tokenId}\n`);
  }
  await createInlineApps(tokenIds, APPS);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("staging_access_refused:") ? error.message : "staging_access_refused:unexpected"}\n`,
    );
    process.exitCode = 1;
  });
