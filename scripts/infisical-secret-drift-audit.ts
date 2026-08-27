import { resolveInfisicalAuditToken } from "./infisical-oidc-auth";

export const API_NEXT_INFISICAL_PROJECT_ID = "fac45f92-9450-42fb-8c2f-f20d043fdfab";
export const INFISICAL_ENVIRONMENTS = ["dev", "staging", "prod"] as const;

export type InfisicalEnvironment = (typeof INFISICAL_ENVIRONMENTS)[number];
export const INFISICAL_RUNTIME_ENABLED = {
  dev: false,
  staging: true,
  prod: true,
} as const satisfies Readonly<Record<InfisicalEnvironment, boolean>>;
export type InfisicalPath = "/" | "/services/api-next" | "/services/api-next/operator";
export type InfisicalDriftKind =
  | "unexpected-folder"
  | "missing-folder"
  | "unexpected-secret"
  | "missing-required-secret";

const RUNTIME_SECRET_NAMES = [
  "PIRATE_APP_JWT_PRIVATE_KEY",
  "PRIVY_APP_SECRET",
  "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
  "MEGAPOT_V2_RPC_URL",
  "VERY_WEB_SEALING_KEY",
  "ZKPASSPORT_VERIFIER_SHARED_SECRET",
  "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
] as const;

const OPERATOR_SECRET_NAMES = [
  "CONTROL_PLANE_POSTGRES_ADMIN_URL",
  "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
] as const;

const PRODUCTION_RUNTIME_SECRET_NAMES = [
  "PIRATE_APP_JWT_PRIVATE_KEY",
  "PRIVY_APP_SECRET",
  "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
  "MEGAPOT_V2_RPC_URL",
] as const;

const STAGING_MEGAPOT_RUNTIME_SECRET_NAMES = [
  "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
  "MEGAPOT_CUSTODY_PRIVATE_KEY",
] as const;

const STAGING_PROVISIONABLE_MEDIA_RUNTIME_SECRET_NAMES = [
  "ACRCLOUD_ACCESS_KEY",
  "ACRCLOUD_ACCESS_SECRET",
  "ELEVENLABS_API_KEY",
  "FILEBASE_IPFS_TOKEN",
  "DATA_REGISTRATION_STAGING_PRIVATE_KEY",
  "MEDIA_CLASSIFIER_API_KEY",
  "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
  "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
] as const;

const STAGING_PROVISIONABLE_HTTP_RUNTIME_SECRET_NAMES = ["OPENAI_API_KEY"] as const;
const requiredWhenRuntimeEnabled = (
  environment: InfisicalEnvironment,
  names: readonly string[],
): readonly string[] => (INFISICAL_RUNTIME_ENABLED[environment] ? [...names] : []);

export type InfisicalPolicy = Readonly<{
  environment: InfisicalEnvironment;
  path: InfisicalPath;
  requiredNames: readonly string[];
  allowedNames: readonly string[];
}>;

export const INFISICAL_POLICIES: readonly InfisicalPolicy[] = [
  { environment: "dev", path: "/", requiredNames: [], allowedNames: [] },
  { environment: "dev", path: "/services/api-next", requiredNames: [], allowedNames: [] },
  { environment: "dev", path: "/services/api-next/operator", requiredNames: [], allowedNames: [] },
  { environment: "staging", path: "/", requiredNames: [], allowedNames: [] },
  {
    environment: "staging",
    path: "/services/api-next",
    requiredNames: requiredWhenRuntimeEnabled("staging", [
      ...RUNTIME_SECRET_NAMES,
      ...STAGING_MEGAPOT_RUNTIME_SECRET_NAMES,
    ]),
    allowedNames: [
      ...RUNTIME_SECRET_NAMES,
      ...STAGING_MEGAPOT_RUNTIME_SECRET_NAMES,
      ...STAGING_PROVISIONABLE_MEDIA_RUNTIME_SECRET_NAMES,
      ...STAGING_PROVISIONABLE_HTTP_RUNTIME_SECRET_NAMES,
    ],
  },
  {
    environment: "staging",
    path: "/services/api-next/operator",
    requiredNames: [...OPERATOR_SECRET_NAMES, "MEGAPOT_REFERRER_PRIVATE_KEY"],
    allowedNames: [...OPERATOR_SECRET_NAMES, "MEGAPOT_REFERRER_PRIVATE_KEY"],
  },
  {
    environment: "prod",
    path: "/",
    requiredNames: [],
    allowedNames: [],
  },
  {
    environment: "prod",
    path: "/services/api-next",
    requiredNames: requiredWhenRuntimeEnabled("prod", PRODUCTION_RUNTIME_SECRET_NAMES),
    allowedNames: [...PRODUCTION_RUNTIME_SECRET_NAMES],
  },
  {
    environment: "prod",
    path: "/services/api-next/operator",
    requiredNames: [...OPERATOR_SECRET_NAMES],
    allowedNames: [...OPERATOR_SECRET_NAMES],
  },
];

export const EXPECTED_INFISICAL_FOLDERS: Readonly<Record<InfisicalEnvironment, readonly string[]>> =
  {
    dev: [],
    staging: ["/services", "/services/api-next", "/services/api-next/operator"],
    prod: ["/services", "/services/api-next", "/services/api-next/operator"],
  };

export type InfisicalExpectedDrift = Readonly<{
  environment: InfisicalEnvironment;
  path: InfisicalPath;
  kind: InfisicalDriftKind;
  name?: string;
  reason: string;
}>;

export const EXPECTED_INFISICAL_DRIFT: readonly InfisicalExpectedDrift[] = [];

export type InfisicalSnapshot = Readonly<{
  environment: InfisicalEnvironment;
  folders: readonly string[];
  secrets: Readonly<Record<InfisicalPath, readonly string[]>>;
}>;

export type InfisicalDrift = Readonly<{
  environment: InfisicalEnvironment;
  path: string;
  kind: InfisicalDriftKind;
  name?: string;
  reason?: string;
}>;

export type InfisicalAuditReport = Readonly<{
  snapshots: readonly InfisicalSnapshot[];
  acceptedDrift: readonly InfisicalDrift[];
  violations: readonly InfisicalDrift[];
}>;

function normalisePath(path: string): string {
  if (path === "/") return "/";
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function driftKey(input: Pick<InfisicalDrift, "environment" | "path" | "kind" | "name">): string {
  return [input.environment, normalisePath(input.path), input.kind, input.name ?? ""].join("/");
}

export function auditInfisicalSnapshots(
  snapshots: readonly InfisicalSnapshot[],
  expectedDrift: readonly InfisicalExpectedDrift[] = EXPECTED_INFISICAL_DRIFT,
): InfisicalAuditReport {
  const expectedByKey = new Map(expectedDrift.map((entry) => [driftKey(entry), entry]));
  const acceptedDrift: InfisicalDrift[] = [];
  const violations: InfisicalDrift[] = [];
  const policiesByEnvironment = new Map<InfisicalEnvironment, InfisicalPolicy[]>();
  for (const policy of INFISICAL_POLICIES) {
    const policies = policiesByEnvironment.get(policy.environment) ?? [];
    policies.push(policy);
    policiesByEnvironment.set(policy.environment, policies);
  }

  const record = (drift: InfisicalDrift): void => {
    const expected = expectedByKey.get(driftKey(drift));
    if (expected !== undefined) {
      acceptedDrift.push({ ...drift, reason: expected.reason });
    } else {
      violations.push(drift);
    }
  };

  for (const snapshot of snapshots) {
    const expectedFolders = new Set(EXPECTED_INFISICAL_FOLDERS[snapshot.environment]);
    const observedFolders = new Set(snapshot.folders.map(normalisePath));
    for (const path of [...observedFolders].sort()) {
      if (!expectedFolders.has(path)) {
        record({
          environment: snapshot.environment,
          path,
          kind: "unexpected-folder",
        });
      }
    }
    for (const path of [...expectedFolders].sort()) {
      if (!observedFolders.has(path)) {
        record({
          environment: snapshot.environment,
          path,
          kind: "missing-folder",
          reason: "Expected folder is absent.",
        });
      }
    }

    const policies = policiesByEnvironment.get(snapshot.environment) ?? [];
    for (const policy of policies) {
      const observedNames = new Set(snapshot.secrets[policy.path] ?? []);
      const allowedNames = new Set(policy.allowedNames);
      for (const name of [...observedNames].sort()) {
        const unexpectedSecret = {
          environment: snapshot.environment,
          path: policy.path,
          kind: "unexpected-secret" as const,
          name,
        };
        if (expectedByKey.has(driftKey(unexpectedSecret)) || !allowedNames.has(name)) {
          record(unexpectedSecret);
        }
      }
      for (const name of [...policy.requiredNames].sort()) {
        if (!observedNames.has(name)) {
          record({
            environment: snapshot.environment,
            path: policy.path,
            kind: "missing-required-secret",
            name,
          });
        }
      }
    }
  }

  return { snapshots, acceptedDrift, violations };
}

type InfisicalResponse = Readonly<Record<string, unknown>>;
export type InfisicalRequest = (input: string, init: RequestInit) => Promise<Response>;

function asObject(value: unknown, label: string): InfisicalResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as InfisicalResponse;
}

export function parseInfisicalSecretNames(payload: unknown): readonly string[] {
  const response = asObject(payload, "Infisical secrets response");
  const secrets = response.secrets;
  if (!Array.isArray(secrets)) throw new Error("Infisical secrets response has no secrets array");
  return [
    ...new Set(
      secrets.map((secret, index) => {
        const object = asObject(secret, `Infisical secret ${index}`);
        const secretKey = object.secretKey;
        if (typeof secretKey !== "string" || secretKey.length === 0) {
          throw new Error(`Infisical secret ${index} has no secretKey`);
        }
        return secretKey;
      }),
    ),
  ].sort();
}

export function parseInfisicalFolderPaths(payload: unknown): readonly string[] {
  const response = asObject(payload, "Infisical folders response");
  const folders = response.folders;
  if (!Array.isArray(folders)) throw new Error("Infisical folders response has no folders array");
  return [
    ...new Set(
      folders.map((folder, index) => {
        const object = asObject(folder, `Infisical folder ${index}`);
        const relativePath = object.relativePath;
        if (typeof relativePath !== "string" || relativePath.length === 0) {
          throw new Error(`Infisical folder ${index} has no relativePath`);
        }
        return normalisePath(relativePath);
      }),
    ),
  ].sort();
}

async function getJson(url: string, token: string, request: InfisicalRequest): Promise<unknown> {
  const response = await request(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(`Infisical API request failed with HTTP ${response.status}`);
  return response.json();
}

function endpoint(baseUrl: string, path: string, parameters: Record<string, string>): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

export async function listInfisicalSecretNames(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly environment: InfisicalEnvironment;
  readonly path: string;
  readonly token: string;
  readonly request?: InfisicalRequest;
}): Promise<readonly string[]> {
  const response = await getJson(
    endpoint(`${input.baseUrl}/v4`, "/secrets", {
      projectId: input.projectId,
      environment: input.environment,
      secretPath: normalisePath(input.path),
      viewSecretValue: "false",
      expandSecretReferences: "false",
      recursive: "false",
    }),
    input.token,
    input.request ?? fetch,
  );
  return parseInfisicalSecretNames(response);
}

async function listInfisicalFolderPaths(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly environment: InfisicalEnvironment;
  readonly token: string;
  readonly request?: InfisicalRequest;
}): Promise<readonly string[]> {
  const response = await getJson(
    endpoint(`${input.baseUrl}/v2`, "/folders", {
      projectId: input.projectId,
      environment: input.environment,
      path: "/",
      recursive: "true",
    }),
    input.token,
    input.request ?? fetch,
  );
  return parseInfisicalFolderPaths(response);
}

export async function fetchInfisicalSnapshots(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly token: string;
  readonly request?: InfisicalRequest;
}): Promise<readonly InfisicalSnapshot[]> {
  const snapshots: InfisicalSnapshot[] = [];
  for (const environment of INFISICAL_ENVIRONMENTS) {
    const folders = await listInfisicalFolderPaths({ ...input, environment });
    const observedFolders = new Set(folders.map(normalisePath));
    const policies = INFISICAL_POLICIES.filter((policy) => policy.environment === environment);
    const secrets = {} as Record<InfisicalPath, readonly string[]>;
    for (const policy of policies) {
      if (policy.path !== "/" && !observedFolders.has(policy.path)) {
        secrets[policy.path] = [];
        continue;
      }
      secrets[policy.path] = await listInfisicalSecretNames({
        ...input,
        environment,
        path: policy.path,
      });
    }
    snapshots.push({ environment, folders, secrets });
  }
  return snapshots;
}

export async function main(): Promise<void> {
  const baseUrl = process.env.INFISICAL_API_URL?.trim() || "https://app.infisical.com/api";
  const token = await resolveInfisicalAuditToken({ baseUrl });
  const report = auditInfisicalSnapshots(
    await fetchInfisicalSnapshots({
      baseUrl,
      projectId: API_NEXT_INFISICAL_PROJECT_ID,
      token,
    }),
  );
  console.log(
    JSON.stringify(
      {
        axis: "infisical",
        projectId: API_NEXT_INFISICAL_PROJECT_ID,
        snapshots: report.snapshots,
        acceptedDrift: report.acceptedDrift,
        violations: report.violations,
      },
      null,
      2,
    ),
  );
  if (report.violations.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Infisical secret drift audit failed");
    process.exitCode = 1;
  });
}
