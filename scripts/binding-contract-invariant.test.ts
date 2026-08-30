import { describe, expect, test } from "bun:test";
import * as BunRuntime from "bun";
import type { DataRegistrationRuntimeEnv } from "../apps/data-registration-worker/src/composition.ts";
import type { HttpWorkerBindings } from "../apps/http-worker/src/composition.ts";
import type { JobsWorkerEnv } from "../apps/jobs-worker/src/index.ts";
import type { MediaProcessorRuntimeEnv } from "../apps/media-processor-worker/src/composition.ts";
import type { AlertSinkBindings } from "../packages/platform-cf/src/alert-config.ts";
import type { RegistrationRateLimiterEnvironment } from "../packages/platform-cf/src/registration-rate-limiter-do.ts";

type BindingKind = "platform" | "secret" | "var";
type BindingManifest<T extends object> = { [K in keyof T]-?: BindingKind };

// This is deliberately explicit. `satisfies` makes a newly added source
// binding fail typecheck until it is classified here, while the runtime audit
// below checks that the classification agrees with both Wrangler configs.
const HTTP_BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  HNS_OWNER_VERIFIER: "platform",
  REGISTRATION_IP_LIMITER: "platform",
  REGISTRATION_APPLICATION_LIMITER: "platform",
  API_NEXT_ENV: "var",
  CORS_ORIGIN: "var",
  PIRATE_API_PUBLIC_ORIGIN: "var",
  SELF_PASS_ENABLED: "var",
  SELF_PASS_APP_NAME: "var",
  SELF_PASS_MOCK_PASSPORT: "var",
  ZKPASSPORT_ENABLED: "var",
  ZKPASSPORT_DOMAIN: "var",
  ZKPASSPORT_NAME: "var",
  ZKPASSPORT_LOGO: "var",
  ZKPASSPORT_VERIFIER_URL: "var",
  ZKPASSPORT_VERIFIER_SHARED_SECRET: "secret",
  ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET: "secret",
  ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID: "var",
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET: "secret",
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID: "var",
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL: "var",
  ZKPASSPORT_DEV_MODE: "var",
  VERY_OAUTH_ENABLED: "var",
  VERY_OAUTH_AUTHORIZATION_ENDPOINT: "var",
  VERY_OAUTH_TOKEN_ENDPOINT: "var",
  VERY_OAUTH_USERINFO_ENDPOINT: "var",
  VERY_OAUTH_ISSUER: "var",
  VERY_OAUTH_JWKS_URL: "var",
  VERY_OAUTH_CLIENT_ID: "var",
  VERY_OAUTH_CLIENT_SECRET: "secret",
  VERY_OAUTH_REDIRECT_URI: "var",
  VERY_OAUTH_SEALING_KEY: "secret",
  VERY_WEB_ENABLED: "var",
  VERY_WEB_APP_ID: "var",
  VERY_WEB_API_URL: "var",
  VERY_WEB_VERIFY_URL: "var",
  VERY_WEB_BRIDGE_API_URL: "var",
  VERY_WEB_SEALING_KEY: "secret",
  HNS_OWNERSHIP_ENABLED: "var",
  HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "var",
  HNS_OWNERSHIP_CONFIGURATION_VERSION: "var",
  HNS_COMMUNITY_APP_API_REPLAY: "platform",
  KARAOKE_ATTEMPT: "platform",
  HNS_COMMUNITY_APP_API_ENABLED: "var",
  HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "var",
  HNS_COMMUNITY_APP_API_ACCESS_ISSUER: "var",
  HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL: "var",
  HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: "var",
  HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE: "var",
  HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: "var",
  HNS_FORWARDER_V3_HMAC_KEY_REGISTRY: "secret",
  HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: "var",
  HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS: "var",
  HNS_EDGE_ALERT_TOKEN: "secret",
  HNS_EDGE_ALERT_EMAIL: "platform",
  OPENAI_MODERATION_ENABLED: "var",
  OPENAI_API_KEY: "secret",
  OPENAI_MODERATION_MODEL: "var",
  OPENAI_MODERATION_BASE_URL: "var",
  OPENAI_MODERATION_TIMEOUT_MS: "var",
  ELEVENLABS_API_KEY: "secret",
  STUDY_GENERATION_ENABLED: "var",
  STUDY_GENERATION_OPENROUTER_MODEL: "var",
  OPENROUTER_API_KEY: "secret",
  STUDY_GENERATION_WORKFLOW: "platform",
  VERIFICATION_CALLBACK_CREDENTIAL_HEADERS: "var",
  PIRATE_APP_JWT_PRIVATE_KEY: "secret",
  PIRATE_APP_JWT_PUBLIC_KEY: "var",
  PIRATE_APP_JWT_ISSUER: "var",
  PIRATE_APP_JWT_AUDIENCE: "var",
  PIRATE_APP_JWT_SCOPE: "var",
  PIRATE_APP_JWT_TTL_SECONDS: "var",
  PRIVY_APP_ID: "var",
  PRIVY_APP_SECRET: "secret",
  PRIVY_API_URL: "var",
  PRIVY_JWKS_URL: "var",
  PRIVY_JWT_ISSUER: "var",
  PRIVY_JWT_AUDIENCE: "var",
  COMMUNITY_PURCHASE_FUNDING_RPC_URL: "secret",
  HANDLE_RECIPIENT_TOKEN_HMAC_KEYS: "secret",
  HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS: "secret",
  MEGAPOT_REWARDS_ENABLED: "var",
  MEGAPOT_CHAIN_ID: "var",
  MEGAPOT_V2_RPC_URL: "secret",
  MEGAPOT_ATTESTATION_ID: "var",
  MEGAPOT_REQUIRED_CONFIRMATIONS: "var",
  MEDIA_UPLOADS_ENABLED: "var",
  MEDIA_INGRESS_R2_ACCOUNT_ID: "var",
  MEDIA_INGRESS_R2_BUCKET_NAME: "var",
  MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID: "secret",
  MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY: "secret",
  MEDIA_INGRESS: "platform",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
  LEARNER_AUDIO: "platform",
} as const satisfies BindingManifest<HttpWorkerBindings>;

const ALERT_BINDING_KINDS = {
  API_NEXT_ENV: "var",
} as const satisfies BindingManifest<AlertSinkBindings>;

const JOBS_BINDING_KINDS = {
  CF_VERSION_METADATA: "platform",
  CRON_LOCK: "platform",
  CONTROL_PLANE: "platform",
  MEGAPOT_COMMITMENTS: "platform",
  HNS_OWNER_VERIFIER: "platform",
  API_NEXT_ENV: "var",
  COMMUNITY_PURCHASE_FUNDING_RPC_URL: "secret",
  MEGAPOT_REWARDS_ENABLED: "var",
  MEGAPOT_CHAIN_ID: "var",
  MEGAPOT_V2_RPC_URL: "secret",
  MEGAPOT_ATTESTATION_ID: "var",
  MEGAPOT_REQUIRED_CONFIRMATIONS: "var",
  MEGAPOT_CUSTODY_PRIVATE_KEY: "secret",
  MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: "secret",
  MEGAPOT_OBSERVATION_TTL_SECONDS: "var",
  MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "var",
  MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: "var",
  MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: "var",
  MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: "var",
  MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "var",
  MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "var",
  MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "var",
  MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "var",
  HNS_OWNERSHIP_ENABLED: "var",
  HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "var",
  HNS_OWNERSHIP_CONFIGURATION_VERSION: "var",
  HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: "var",
  HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "var",
  MEDIA_PROCESSING_ENABLED: "var",
  MEDIA_PROCESSING_QUEUE: "platform",
  MEDIA_PROCESSING_WORKFLOW: "platform",
  DATA_REGISTRATION_ENABLED: "var",
  DATA_REGISTRATION_RPC_URL: "var",
  DATA_REGISTRATION_SIGNER_ADDRESS: "var",
  DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI: "var",
  DATA_REGISTRATION_QUEUE: "platform",
  DATA_REGISTRATION_WORKFLOW: "platform",
} as const satisfies BindingManifest<JobsWorkerEnv>;

const MEDIA_BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  MEDIA_PROCESSING_ENABLED: "var",
  MEDIA_PROCESSING_WORKFLOW: "platform",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
  MEDIA_DERIVED_ARTIFACTS: "platform",
  IMAGE_TRANSFORMATIONS: "platform",
  ACRCLOUD_IDENTIFY_HOST: "var",
  ACRCLOUD_ACCESS_KEY: "secret",
  ACRCLOUD_ACCESS_SECRET: "secret",
  ELEVENLABS_API_KEY: "secret",
  OPENAI_API_KEY: "secret",
  OPENROUTER_API_KEY: "secret",
  DATA_REGISTRATION_ENABLED: "var",
  DATA_REGISTRATION_CHAIN_ID: "var",
} as const satisfies BindingManifest<MediaProcessorRuntimeEnv>;

const DATA_REGISTRATION_BINDING_KINDS = {
  CONTROL_PLANE: "platform",
  API_NEXT_ENV: "var",
  DATA_REGISTRATION_ENABLED: "var",
  DATA_REGISTRATION_WORKFLOW: "platform",
  MEDIA_IMMUTABLE_ORIGINALS: "platform",
  DATA_REGISTRATION_CHAIN_ID: "var",
  DATA_REGISTRATION_RPC_URL: "var",
  DATA_REGISTRATION_SIGNER_ADDRESS: "var",
  DATA_REGISTRATION_SPG_NFT_CONTRACT: "var",
  DATA_REGISTRATION_STAGING_PRIVATE_KEY: "secret",
  DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY: "secret",
  DATA_REGISTRATION_REQUIRED_CONFIRMATIONS: "var",
  DATA_REGISTRATION_PUBLIC_ORIGIN: "var",
  FILEBASE_IPFS_TOKEN: "secret",
} as const satisfies BindingManifest<DataRegistrationRuntimeEnv>;

const REGISTRATION_BINDING_KINDS = {
  REGISTRATION_IP_LIMIT: "var",
  REGISTRATION_IP_WINDOW_SECONDS: "var",
  REGISTRATION_APPLICATION_LIMIT: "var",
  REGISTRATION_APPLICATION_WINDOW_SECONDS: "var",
} as const satisfies BindingManifest<RegistrationRateLimiterEnvironment>;

const HTTP_CONFIG_BINDING_KINDS = {
  ...HTTP_BINDING_KINDS,
  ...REGISTRATION_BINDING_KINDS,
} as const;

type WorkerName = "data" | "http" | "jobs" | "media";
type EnvironmentName = "development" | "staging" | "production";

const ENVIRONMENTS: readonly EnvironmentName[] = ["development", "staging", "production"];

const HTTP_CONFIG_PATH = new URL("../apps/http-worker/wrangler.jsonc", import.meta.url);
const JOBS_CONFIG_PATH = new URL("../apps/jobs-worker/wrangler.jsonc", import.meta.url);
const MEDIA_CONFIG_PATH = new URL("../apps/media-processor-worker/wrangler.jsonc", import.meta.url);
const DATA_CONFIG_PATH = new URL(
  "../apps/data-registration-worker/wrangler.jsonc",
  import.meta.url,
);

interface RawWranglerEnvironment {
  readonly vars?: Record<string, unknown>;
  readonly secrets?: { readonly required?: readonly unknown[] };
  readonly observability?: {
    readonly enabled?: unknown;
    readonly logs?: {
      readonly enabled?: unknown;
      readonly head_sampling_rate?: unknown;
      readonly invocation_logs?: unknown;
      readonly persist?: unknown;
    };
    readonly traces?: {
      readonly enabled?: unknown;
      readonly head_sampling_rate?: unknown;
      readonly persist?: unknown;
    };
  };
}

interface RawWranglerConfig extends RawWranglerEnvironment {
  readonly env?: Record<string, RawWranglerEnvironment>;
}

interface DeclaredEnvironment {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
}

const parseWranglerConfig = async (path: URL): Promise<RawWranglerConfig> =>
  BunRuntime.JSONC.parse(await BunRuntime.file(path).text()) as RawWranglerConfig;

const configs: Readonly<Record<WorkerName, RawWranglerConfig>> = {
  data: await parseWranglerConfig(DATA_CONFIG_PATH),
  http: await parseWranglerConfig(HTTP_CONFIG_PATH),
  jobs: await parseWranglerConfig(JOBS_CONFIG_PATH),
  media: await parseWranglerConfig(MEDIA_CONFIG_PATH),
};

const manifestFor = (worker: WorkerName): Readonly<Record<string, BindingKind>> =>
  worker === "data"
    ? DATA_REGISTRATION_BINDING_KINDS
    : worker === "http"
      ? HTTP_CONFIG_BINDING_KINDS
      : worker === "jobs"
        ? JOBS_BINDING_KINDS
        : MEDIA_BINDING_KINDS;

const declaredEnvironment = (
  config: RawWranglerConfig,
  environment: EnvironmentName,
): DeclaredEnvironment => {
  const block = environment === "development" ? config : config.env?.[environment];
  if (block === undefined) {
    return { vars: {}, secrets: [] };
  }
  return {
    vars: block.vars ?? {},
    secrets: (block.secrets?.required ?? []).filter(
      (name): name is string => typeof name === "string",
    ),
  };
};

const rawEnvironment = (
  config: RawWranglerConfig,
  environment: EnvironmentName,
): RawWranglerEnvironment =>
  environment === "development" ? config : (config.env?.[environment] ?? {});

const declaredNames = (environment: DeclaredEnvironment): readonly string[] => [
  ...Object.keys(environment.vars),
  ...environment.secrets,
];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const HTTP_ALWAYS_REQUIRED = [
  "API_NEXT_ENV",
  "CORS_ORIGIN",
  "PIRATE_APP_JWT_PRIVATE_KEY",
  "PIRATE_APP_JWT_PUBLIC_KEY",
  "PIRATE_APP_JWT_ISSUER",
  "PIRATE_APP_JWT_AUDIENCE",
  "PIRATE_APP_JWT_SCOPE",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_JWKS_URL",
  "PRIVY_JWT_ISSUER",
  "PRIVY_JWT_AUDIENCE",
  "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
  "MEGAPOT_REWARDS_ENABLED",
  "MEGAPOT_CHAIN_ID",
  "MEGAPOT_ATTESTATION_ID",
  "MEGAPOT_REQUIRED_CONFIRMATIONS",
  "OPENAI_MODERATION_ENABLED",
] as const;

const HTTP_MEGAPOT_REQUIRED = ["MEGAPOT_V2_RPC_URL"] as const;

const HTTP_OPENAI_MODERATION_REQUIRED = [
  "OPENAI_API_KEY",
  "OPENAI_MODERATION_MODEL",
  "OPENAI_MODERATION_BASE_URL",
  "OPENAI_MODERATION_TIMEOUT_MS",
] as const;

const HTTP_ZKPASSPORT_REQUIRED = [
  "ZKPASSPORT_DOMAIN",
  "ZKPASSPORT_VERIFIER_URL",
  "ZKPASSPORT_VERIFIER_SHARED_SECRET",
  "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
  "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID",
] as const;

const HTTP_ZKPASSPORT_ROTATION_DECLARATIONS = [
  "ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID",
  "ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL",
] as const;

const HTTP_HNS_REQUIRED = [
  "HNS_OWNERSHIP_CONFIGURATION_REFERENCE",
  "HNS_OWNERSHIP_CONFIGURATION_VERSION",
] as const;

const HTTP_HNS_COMMUNITY_APP_REQUIRED = [
  "HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN",
  "HNS_COMMUNITY_APP_API_ACCESS_ISSUER",
  "HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL",
  "HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE",
  "HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE",
  "HNS_FORWARDER_V3_KEY_REGISTRY_VERSION",
  "HNS_FORWARDER_V3_HMAC_KEY_REGISTRY",
  "HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS",
  "HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS",
] as const;

const HTTP_VERY_OAUTH_REQUIRED = [
  "VERY_OAUTH_AUTHORIZATION_ENDPOINT",
  "VERY_OAUTH_TOKEN_ENDPOINT",
  "VERY_OAUTH_USERINFO_ENDPOINT",
  "VERY_OAUTH_ISSUER",
  "VERY_OAUTH_JWKS_URL",
  "VERY_OAUTH_CLIENT_ID",
  "VERY_OAUTH_CLIENT_SECRET",
  "VERY_OAUTH_REDIRECT_URI",
  "VERY_OAUTH_SEALING_KEY",
] as const;

const HTTP_VERY_WEB_REQUIRED = [
  "VERY_WEB_APP_ID",
  "VERY_WEB_API_URL",
  "VERY_WEB_VERIFY_URL",
  "VERY_WEB_BRIDGE_API_URL",
  "VERY_WEB_SEALING_KEY",
] as const;

const HTTP_REGISTRATION_REQUIRED = [
  "REGISTRATION_IP_LIMIT",
  "REGISTRATION_IP_WINDOW_SECONDS",
  "REGISTRATION_APPLICATION_LIMIT",
  "REGISTRATION_APPLICATION_WINDOW_SECONDS",
] as const;

const JOBS_ALWAYS_REQUIRED = [
  "API_NEXT_ENV",
  "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
  "MEGAPOT_REWARDS_ENABLED",
  "MEGAPOT_CHAIN_ID",
  "MEGAPOT_ATTESTATION_ID",
  "MEGAPOT_REQUIRED_CONFIRMATIONS",
  "MEGAPOT_OBSERVATION_TTL_SECONDS",
  "MEGAPOT_APPROVED_ALLOWANCE_ATOMIC",
  "MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS",
  "MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS",
  "MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI",
  "MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING",
  "MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC",
  "MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING",
  "MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC",
] as const;

const JOBS_MEGAPOT_REQUIRED = [
  "MEGAPOT_CUSTODY_PRIVATE_KEY",
  "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN",
] as const;

const JOBS_HNS_REQUIRED = [
  "HNS_OWNERSHIP_CONFIGURATION_REFERENCE",
  "HNS_OWNERSHIP_CONFIGURATION_VERSION",
] as const;

const JOBS_DATA_BALANCE_REQUIRED = [
  "DATA_REGISTRATION_RPC_URL",
  "DATA_REGISTRATION_SIGNER_ADDRESS",
  "DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI",
] as const;

const MEDIA_ENABLED_REQUIRED = [
  "ACRCLOUD_IDENTIFY_HOST",
  "ACRCLOUD_ACCESS_KEY",
  "ACRCLOUD_ACCESS_SECRET",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
] as const;

const HTTP_STUDY_GENERATION_REQUIRED = [
  "STUDY_GENERATION_ENABLED",
  "STUDY_GENERATION_OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
] as const;

const DATA_ENABLED_REQUIRED = [
  "DATA_REGISTRATION_CHAIN_ID",
  "DATA_REGISTRATION_RPC_URL",
  "DATA_REGISTRATION_SIGNER_ADDRESS",
  "DATA_REGISTRATION_SPG_NFT_CONTRACT",
  "DATA_REGISTRATION_REQUIRED_CONFIRMATIONS",
  "DATA_REGISTRATION_PUBLIC_ORIGIN",
  "FILEBASE_IPFS_TOKEN",
] as const;

const LEGACY_JUNK_NAMES = [
  "AUTH_UPSTREAM_JWT_AUDIENCE",
  "AUTH_UPSTREAM_JWT_ISSUER",
  "AUTH_UPSTREAM_JWT_JWKS_URL",
  "SELF_CALLBACK_CAPTURE_ACCESS_TOKEN",
] as const;

// The pre-D7 names. These must never reappear in a binding manifest or in a
// Wrangler config; the D7 rename replaced them with their VERY_WEB_ forms.
const LEGACY_VERY_WEB_NAMES = [
  "VERY_APP_ID",
  "VERY_API_URL",
  "VERY_VERIFY_URL",
  "VERY_BRIDGE_API_URL",
] as const;

const requiredNamesFor = (
  worker: WorkerName,
  environment: DeclaredEnvironment,
): readonly string[] => {
  if (worker === "data") {
    if (environment.vars.DATA_REGISTRATION_ENABLED !== "true") {
      return ["DATA_REGISTRATION_ENABLED"];
    }
    const signerSecret =
      environment.vars.API_NEXT_ENV === "production"
        ? "DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY"
        : "DATA_REGISTRATION_STAGING_PRIVATE_KEY";
    return ["DATA_REGISTRATION_ENABLED", ...DATA_ENABLED_REQUIRED, signerSecret];
  }
  if (worker === "media") {
    return environment.vars.MEDIA_PROCESSING_ENABLED === "true"
      ? ["MEDIA_PROCESSING_ENABLED", ...MEDIA_ENABLED_REQUIRED]
      : ["MEDIA_PROCESSING_ENABLED"];
  }
  if (worker === "jobs") {
    const required: string[] = [...JOBS_ALWAYS_REQUIRED];
    if (environment.vars.HNS_OWNERSHIP_ENABLED === "true") required.push(...JOBS_HNS_REQUIRED);
    if (environment.vars.MEGAPOT_REWARDS_ENABLED === "true") {
      required.push(...JOBS_MEGAPOT_REQUIRED);
    }
    if (environment.vars.DATA_REGISTRATION_ENABLED === "true") {
      required.push(...JOBS_DATA_BALANCE_REQUIRED);
    }
    return required;
  }

  const required: string[] = [...HTTP_ALWAYS_REQUIRED, ...HTTP_REGISTRATION_REQUIRED];
  if (environment.vars.ZKPASSPORT_ENABLED === "true") {
    required.push(...HTTP_ZKPASSPORT_REQUIRED);
  }
  if (environment.vars.HNS_OWNERSHIP_ENABLED === "true") {
    required.push(...HTTP_HNS_REQUIRED);
  }
  if (environment.vars.HNS_COMMUNITY_APP_API_ENABLED === "true") {
    required.push(...HTTP_HNS_COMMUNITY_APP_REQUIRED);
  }
  if (environment.vars.MEGAPOT_REWARDS_ENABLED === "true") {
    required.push(...HTTP_MEGAPOT_REQUIRED);
  }
  if (environment.vars.VERY_OAUTH_ENABLED === "true") {
    required.push(...HTTP_VERY_OAUTH_REQUIRED);
  }
  if (environment.vars.VERY_WEB_ENABLED === "true") {
    required.push(...HTTP_VERY_WEB_REQUIRED);
  }
  if (environment.vars.OPENAI_MODERATION_ENABLED === "true") {
    required.push(...HTTP_OPENAI_MODERATION_REQUIRED);
  }
  if (environment.vars.STUDY_GENERATION_ENABLED === "true") {
    required.push(...HTTP_STUDY_GENERATION_REQUIRED);
  }
  return required;
};

const auditDeclaredBindings = (): readonly string[] => {
  const violations: string[] = [];

  for (const worker of ["data", "http", "jobs", "media"] as const) {
    const manifest = manifestFor(worker);
    for (const environmentName of ENVIRONMENTS) {
      const environment = declaredEnvironment(configs[worker], environmentName);
      const varNames = new Set(Object.keys(environment.vars));
      const secretNames = new Set(environment.secrets);

      for (const name of declaredNames(environment)) {
        const expected = manifest[name];
        if (expected === undefined) {
          violations.push(`${worker}/${environmentName}: ${name} is not source-consumed`);
          continue;
        }
        if (expected === "platform") {
          violations.push(
            `${worker}/${environmentName}: ${name} is a platform binding, not config`,
          );
          continue;
        }
        const inVars = varNames.has(name);
        const inSecrets = secretNames.has(name);
        if (inVars && inSecrets) {
          violations.push(
            `${worker}/${environmentName}: ${name} is declared as both var and secret`,
          );
        } else if (inVars && expected !== "var") {
          violations.push(`${worker}/${environmentName}: ${name} must be a secret`);
        } else if (inSecrets && expected !== "secret") {
          violations.push(`${worker}/${environmentName}: ${name} must be a var`);
        }
      }
    }
  }

  return violations;
};

const auditRequiredBindings = (): readonly string[] => {
  const violations: string[] = [];

  for (const worker of ["data", "http", "jobs", "media"] as const) {
    const manifest = manifestFor(worker);
    for (const environmentName of ENVIRONMENTS) {
      const environment = declaredEnvironment(configs[worker], environmentName);
      const names = new Set(declaredNames(environment));
      const varNames = new Set(Object.keys(environment.vars));
      const secretNames = new Set(environment.secrets);
      for (const name of requiredNamesFor(worker, environment)) {
        if (!names.has(name)) {
          violations.push(`${worker}/${environmentName}: required ${name} is undeclared`);
          continue;
        }
        if (manifest[name] === "var" && !varNames.has(name)) {
          // The classification audit reports the wrong store. Keep this
          // check focused on absence/value rather than duplicating it.
          continue;
        }
        if (manifest[name] === "secret" && !secretNames.has(name)) {
          continue;
        }
        if (manifest[name] === "var" && !isNonEmptyString(environment.vars[name])) {
          violations.push(`${worker}/${environmentName}: required var ${name} is empty`);
        }
      }
      if (worker === "http" && environment.vars.ZKPASSPORT_ENABLED === "true") {
        for (const name of HTTP_ZKPASSPORT_ROTATION_DECLARATIONS) {
          if (!names.has(name)) {
            violations.push(
              `${worker}/${environmentName}: optional rotation ${name} is undeclared`,
            );
          }
        }
      }
    }
  }

  return violations;
};

describe("source-to-Wrangler binding contract", () => {
  test("source interfaces are fully classified", () => {
    expect(Object.keys(HTTP_BINDING_KINDS).length).toBeGreaterThan(0);
    expect(Object.keys(JOBS_BINDING_KINDS).length).toBeGreaterThan(0);
    expect(Object.keys(MEDIA_BINDING_KINDS).length).toBeGreaterThan(0);
    expect(Object.keys(DATA_REGISTRATION_BINDING_KINDS).length).toBeGreaterThan(0);
    expect(Object.keys(ALERT_BINDING_KINDS).length).toBeGreaterThan(0);
    expect(Object.keys(REGISTRATION_BINDING_KINDS).length).toBeGreaterThan(0);
  });

  // Known-open violations, each blocked on a value only an external owner can
  // supply. This is a ratchet, not an allowlist: the assertions below fail both
  // when a NEW violation appears and when a listed one is FIXED without being
  // removed from this list, so the baseline cannot silently go stale.
  //
  // Every entry must name its blocker. Do not add an entry to make a test pass
  // for any other reason. The target for this array is empty.
  const KNOWN_OPEN_DECLARED_VIOLATIONS = [
    // Blocked: no development Privy application has been provisioned.
    "http/development: PIRATE_APP_JWT_PUBLIC_KEY must be a var",
    "http/development: PRIVY_APP_ID must be a var",
  ] as const;

  const KNOWN_OPEN_REQUIRED_VIOLATIONS = [
    // Blocked: no development Privy application has been provisioned.
    "http/development: required PRIVY_JWKS_URL is undeclared",
    "http/development: required PRIVY_JWT_AUDIENCE is undeclared",
  ] as const;

  const ratchet = (actual: readonly string[], known: readonly string[]) => ({
    unexpected: actual.filter((violation) => !known.includes(violation)),
    resolved: known.filter((violation) => !actual.includes(violation)),
  });

  test("declared config has no junk and matches var/secret classification", () => {
    const { unexpected, resolved } = ratchet(
      auditDeclaredBindings(),
      KNOWN_OPEN_DECLARED_VIOLATIONS,
    );
    expect(unexpected).toEqual([]);
    // If this fails, the violation was fixed. Delete it from the baseline.
    expect(resolved).toEqual([]);
  });

  test("active source requirements are declared for every environment", () => {
    const { unexpected, resolved } = ratchet(
      auditRequiredBindings(),
      KNOWN_OPEN_REQUIRED_VIOLATIONS,
    );
    expect(unexpected).toEqual([]);
    // If this fails, the violation was fixed. Delete it from the baseline.
    expect(resolved).toEqual([]);
  });

  test("disabled production DATA predeclares its exact activation secret boundary", () => {
    const production = declaredEnvironment(configs.data, "production");
    expect(production.vars.DATA_REGISTRATION_ENABLED).toBe("false");
    expect([...production.secrets].sort()).toEqual([
      "DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY",
      "FILEBASE_IPFS_TOKEN",
    ]);
  });

  test("API_NEXT_ENV is explicit and uses the canonical vocabulary", () => {
    const violations: string[] = [];
    for (const worker of ["http", "jobs"] as const) {
      for (const environmentName of ENVIRONMENTS) {
        const environment = declaredEnvironment(configs[worker], environmentName);
        const value = environment.vars.API_NEXT_ENV;
        if (value !== environmentName) {
          violations.push(`${worker}/${environmentName}: API_NEXT_ENV=${String(value)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("pipeline observability keeps custom logs unsampled and traces deliberate", () => {
    for (const worker of ["jobs", "media", "data"] as const) {
      for (const environmentName of ENVIRONMENTS) {
        const observability = rawEnvironment(configs[worker], environmentName).observability;
        expect(observability).toMatchObject({
          enabled: true,
          logs: { enabled: true, head_sampling_rate: 1, persist: true },
          traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
        });
      }
    }
    for (const environmentName of ENVIRONMENTS) {
      const observability = rawEnvironment(configs.http, environmentName).observability;
      expect(observability).toMatchObject({
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true },
      });
      expect(observability?.traces).toBeUndefined();
    }
  });

  test("legacy names are absent and Very web names are explicitly namespaced", () => {
    const violations: string[] = [];
    for (const worker of ["http", "jobs"] as const) {
      const manifest = manifestFor(worker);
      for (const name of LEGACY_JUNK_NAMES) {
        if (manifest[name] !== undefined) {
          violations.push(`${worker}: ${name} remains source-consumed`);
        }
        for (const environmentName of ENVIRONMENTS) {
          const environment = declaredEnvironment(configs[worker], environmentName);
          if (declaredNames(environment).includes(name)) {
            violations.push(`${worker}/${environmentName}: ${name} is configured`);
          }
        }
      }
      if (worker !== "http") continue;
      for (const name of LEGACY_VERY_WEB_NAMES) {
        if (manifest[name] !== undefined) {
          violations.push(`http: ${name} must be renamed to VERY_WEB_*`);
        }
        for (const environmentName of ENVIRONMENTS) {
          const environment = declaredEnvironment(configs[worker], environmentName);
          if (declaredNames(environment).includes(name)) {
            violations.push(`http/${environmentName}: ${name} is configured`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
