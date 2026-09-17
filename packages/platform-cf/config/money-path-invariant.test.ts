import { describe, expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { assertMegapotRewardRuntimePosture } from "./index.ts";

// Deployed production money-path invariant.
//
// This ratchet reads the production environment of the four deployed Workers
// (http-worker, jobs-worker, media-processor-worker, data-registration-worker).
// It previously read the repository-root wrangler.jsonc, which nothing deploys:
// every CI dry-run and deploy passes --config apps/<name>/wrangler.jsonc, and
// scripts/deploy-worker-with-provenance.ts requires --config. The root file is
// retained unchanged as a separate retirement decision and is deliberately not
// an input here.
//
// Lane finding (2026-09-17): the previous header claimed "api-next has no money
// paths until M3". That was not merely stale prose. The M3 community purchase
// funding path is present in the production configuration now:
// COMMUNITY_PURCHASE_FUNDING_RPC_URL is a required secret in http-worker and
// jobs-worker production, and the expected chain of a funding record is copied
// at quote time from community_commerce_money_route_policy_versions.chain_id
// (packages/platform-cf/src/community-purchase-funding-repository.ts), never
// from a wrangler variable. This ratchet cannot constrain that choice; the
// policy write path must. That unresolved production posture is registered
// below as a named activation prerequisite, not hidden.
//
// Discovery is authoritative. For each production environment the test reads
// env.production.vars and env.production.secrets.required only; nothing is
// inherited from top-level or staging blocks, and required secrets are treated
// as names because their values are never visible. Runtime configuration
// declarations from packages/platform-cf/config/index.ts are inventoried
// separately. A chain-id or RPC name cannot appear in production without an
// explicit posture entry; silence fails closed. MoneyPathConfig is consulted as
// a cross-check only, never as the completeness authority (it omits the DATA
// path entirely and nothing reads it).
//
// Every posture entry states an explicit productionDeclaration intent, either
// "required" or "forbidden". An entry intended to be absent from production must
// say "forbidden"; the test then asserts absence from both production vars and
// required-secret declarations across every inspected Worker. Absence is never
// inferred from an empty owner list.
//
// Coverage versus qualification. This ratchet establishes inventory coverage:
// every discovered chain-id and RPC declaration has an explicit posture with
// stated claims and evidence limitations. It does not establish that every
// production money path is proven safe, and no result here should be read as
// that claim. The only executable safety qualification is the Megapot resolver
// check below. The DATA postures rest on a checked-in false, and the community
// purchase policy-chain admission is unresolved; both remain recorded gaps, not
// approved safety exceptions, and any posture relaxation requires a separate
// owner decision.
//
// Configuration assertions versus executable guard tests: most checks here
// read checked-in configuration and prove the declared posture, not runtime
// behavior. The Megapot check additionally executes the real
// assertMegapotRewardRuntimePosture resolver against the real production values
// and proves it rejects enablement. It does not read MEGAPOT_ATTESTATION_ID.
// disabled_configuration is deliberately weaker than a guarded_testnet_exception:
// it proves DATA_REGISTRATION_ENABLED is exactly "false" in the checked-in
// configuration, not that runtime enforcement occurs; no guard or resolver is
// manufactured for it.
//
// Every posture entry carries a mandatory evidenceLimitation field. For a
// secret such as COMMUNITY_PURCHASE_FUNDING_RPC_URL, a declaration check proves
// only that the name is declared; it never proves the endpoint, chain or token
// value behind it. A forbidden declaration check proves absence from the
// checked-in configuration only; it cannot prove that a remotely provisioned
// Worker secret is absent.
//
// Follow-ups registered by this lane, not implemented here: disabled-path tests
// at the owning Worker boundaries for DATA; the Megapot attestation-identity
// activation prerequisite; the owner decision on which chains a production
// community commerce route policy may name and what enforces that on the policy
// write path; and the retirement decision for the root wrangler.jsonc and its
// spec 000 §9 reference.

const BASE_MAINNET_CHAIN_ID = 8453;
const STORY_AENEID_CHAIN_ID = 1315;
const MEGAPOT_TESTNET_ATTESTATION_ID = "megapot-base-sepolia-v2";

const DEPLOYED_WRANGLER_CONFIGS = [
  {
    app: "http-worker",
    path: new URL("../../../apps/http-worker/wrangler.jsonc", import.meta.url),
  },
  {
    app: "jobs-worker",
    path: new URL("../../../apps/jobs-worker/wrangler.jsonc", import.meta.url),
  },
  {
    app: "media-processor-worker",
    path: new URL("../../../apps/media-processor-worker/wrangler.jsonc", import.meta.url),
  },
  {
    app: "data-registration-worker",
    path: new URL("../../../apps/data-registration-worker/wrangler.jsonc", import.meta.url),
  },
] as const;

const UNRESOLVED_ACTIVATION_PREREQUISITES = {
  "community-purchase-policy-chain-admission":
    "COMMUNITY_PURCHASE_FUNDING_RPC_URL is a required production secret with no chain-id variable, no feature flag and no posture guard. The expected chain of a funding record is copied at quote time from community_commerce_money_route_policy_versions.chain_id, which admits any positive id, and the only runtime constraint is the chain reader's eth_chainId equality check against the configured endpoint. The checked-in configuration cannot constrain that choice and this ratchet cannot close the gap. Owner decision required: which chains may a production community commerce route policy name, and what enforces that on the policy write path.",
  "megapot-attestation-identity": `Production MEGAPOT_CHAIN_ID is Base mainnet 8453 while production MEGAPOT_ATTESTATION_ID still names a Base Sepolia deployment (${MEGAPOT_TESTNET_ATTESTATION_ID}). Rewards are disabled, so the runtime guard is inert. Activating Megapot rewards requires reconciling the attestation identity with the chain before MEGAPOT_REWARDS_ENABLED may become true.`,
} as const;

type ActivationPrerequisite = keyof typeof UNRESOLVED_ACTIVATION_PREREQUISITES;

type MainnetRequiredEntry = Readonly<{
  readonly kind: "chain_id";
  readonly name: string;
  readonly posture: "mainnet_required";
  readonly productionDeclaration: "required";
  readonly requiredInProduction: readonly string[];
  readonly supportingFields: readonly string[];
  readonly activationPrerequisite: ActivationPrerequisite;
  readonly evidenceLimitation: string;
}>;

type DisabledConfigurationEntry = Readonly<{
  readonly kind: "chain_id" | "rpc_url";
  readonly name: string;
  readonly posture: "disabled_configuration";
  readonly productionDeclaration: "required";
  readonly disablingFlag: string;
  readonly requiredFlagValue: "false";
  readonly admittedChainIds?: readonly number[];
  readonly requiredInProduction: readonly string[];
  readonly evidenceLimitation: string;
}>;

type PolicyBoundSecretRpcEntry = Readonly<{
  readonly kind: "secret_rpc_url";
  readonly name: string;
  readonly posture: "policy_bound_secret_rpc";
  readonly productionDeclaration: "required";
  readonly requiredInProduction: readonly string[];
  readonly chainSource: string;
  readonly activationPrerequisite: ActivationPrerequisite;
  readonly evidenceLimitation: string;
}>;

type RequiredMoneyPathEntry =
  | MainnetRequiredEntry
  | DisabledConfigurationEntry
  | PolicyBoundSecretRpcEntry;

type ForbiddenGuardedOptionalSecretRpcEntry = Readonly<{
  readonly kind: "secret_rpc_url";
  readonly name: string;
  readonly posture: "guarded_optional_secret_rpc";
  readonly productionDeclaration: "forbidden";
  readonly guard: string;
  readonly evidenceLimitation: string;
}>;

type MoneyPathEntry = RequiredMoneyPathEntry | ForbiddenGuardedOptionalSecretRpcEntry;

const MONEY_PATH_POSTURES = [
  {
    kind: "chain_id",
    name: "MEGAPOT_CHAIN_ID",
    posture: "mainnet_required",
    productionDeclaration: "required",
    requiredInProduction: ["http-worker", "jobs-worker"],
    supportingFields: [
      "MEGAPOT_REWARDS_ENABLED",
      "MEGAPOT_REQUIRED_CONFIRMATIONS",
      "MEGAPOT_ATTESTATION_ID",
    ],
    activationPrerequisite: "megapot-attestation-identity",
    evidenceLimitation:
      "Executing assertMegapotRewardRuntimePosture proves the chain id, positive confirmations and disabled rewards only. It does not read MEGAPOT_ATTESTATION_ID, so it proves nothing about attestation identity, the endpoint behind MEGAPOT_V2_RPC_URL or the reward token.",
  },
  {
    kind: "chain_id",
    name: "DATA_REGISTRATION_CHAIN_ID",
    posture: "disabled_configuration",
    productionDeclaration: "required",
    disablingFlag: "DATA_REGISTRATION_ENABLED",
    requiredFlagValue: "false",
    admittedChainIds: [STORY_AENEID_CHAIN_ID],
    requiredInProduction: ["media-processor-worker", "data-registration-worker"],
    evidenceLimitation:
      "The checked-in flag proves the configuration is disabled, not that runtime enforcement occurs, and it proves nothing about the signer, contracts or provider endpoints used if the flag ever changes.",
  },
  {
    kind: "rpc_url",
    name: "DATA_REGISTRATION_RPC_URL",
    posture: "disabled_configuration",
    productionDeclaration: "required",
    disablingFlag: "DATA_REGISTRATION_ENABLED",
    requiredFlagValue: "false",
    requiredInProduction: ["jobs-worker", "data-registration-worker"],
    evidenceLimitation:
      "The checked-in flag proves the configuration is disabled, not that runtime enforcement occurs. Nothing here proves the endpoint value; jobs-worker legitimately carries this RPC without a chain id.",
  },
  {
    kind: "secret_rpc_url",
    name: "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
    posture: "policy_bound_secret_rpc",
    productionDeclaration: "required",
    requiredInProduction: ["http-worker", "jobs-worker"],
    chainSource:
      "community_commerce_money_route_policy_versions.chain_id, copied into the persisted funding plan at quote time and compared by eth_chainId at observation time",
    activationPrerequisite: "community-purchase-policy-chain-admission",
    evidenceLimitation:
      "A required-secret declaration proves the name is declared, never the endpoint, chain or token behind it. The expected chain is admitted by persisted policy data, not by this configuration, and no flag or guard constrains it.",
  },
  {
    kind: "secret_rpc_url",
    name: "MEGAPOT_V2_RPC_URL",
    posture: "guarded_optional_secret_rpc",
    productionDeclaration: "forbidden",
    guard:
      "assertMegapotRewardRuntimePosture rejects production enablement, and both Workers only read the endpoint when MEGAPOT_REWARDS_ENABLED is true",
    evidenceLimitation:
      "The absence assertion covers checked-in declarations only and cannot prove that a remotely provisioned Worker secret is absent; Cloudflare secrets created outside the repository are invisible to it. The guard reference records that endpoint consumption requires MEGAPOT_REWARDS_ENABLED and that production enablement is rejected by the executable Megapot check; it does not validate the endpoint or its network, and the value is never asserted.",
  },
] as const satisfies readonly MoneyPathEntry[];

type WranglerProductionBlock = Readonly<{
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<{ readonly required?: unknown }>;
}>;

type WranglerDocument = Readonly<{
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<{ readonly required?: unknown }>;
  readonly env?: Readonly<{
    readonly staging?: WranglerProductionBlock;
    readonly production?: WranglerProductionBlock;
  }>;
}>;

type DeclarationSource = "vars" | "required-secret";

type ProductionDeclaration = Readonly<{
  readonly app: string;
  readonly name: string;
  readonly source: DeclarationSource;
  readonly value: string | null;
}>;

type NamedDeclaration = Readonly<{
  readonly name: string;
  readonly origin: string;
}>;

const CHAIN_ID_SUFFIX = "_CHAIN_ID";
const RPC_URL_SUFFIX = "_RPC_URL";

function isChainIdName(name: string): boolean {
  return name.endsWith(CHAIN_ID_SUFFIX);
}

function isRpcUrlName(name: string): boolean {
  return name.endsWith(RPC_URL_SUFFIX);
}

function isMoneyPathName(name: string): boolean {
  return isChainIdName(name) || isRpcUrlName(name);
}

/**
 * Reads one production environment only. Top-level and staging blocks are
 * deliberately ignored: a requirement declared there is not inherited by
 * production, and a secret is recorded as a name because its value is never
 * visible to this test.
 */
function productionDeclarationsFrom(
  document: WranglerDocument,
  app: string,
): readonly ProductionDeclaration[] {
  const production = document.env?.production;
  if (production === undefined) {
    throw new Error(`${app} wrangler config has no env.production block; the ratchet fails closed`);
  }
  const declarations: ProductionDeclaration[] = [];
  const vars = production.vars;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      if (typeof value !== "string") {
        throw new Error(
          `${app} production var ${name} is not a string; the ratchet cannot classify it`,
        );
      }
      declarations.push({ app, name, source: "vars", value });
    }
  }
  const required = production.secrets?.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      throw new Error(
        `${app} production secrets.required is not an array; the ratchet fails closed`,
      );
    }
    for (const name of required) {
      if (typeof name !== "string") {
        throw new Error(`${app} production secrets.required contains a non-string entry`);
      }
      declarations.push({ app, name, source: "required-secret", value: null });
    }
  }
  return declarations;
}

function assertAllDeclarationsClassified(
  declarations: readonly NamedDeclaration[],
  entries: readonly MoneyPathEntry[],
): void {
  const classified = new Set(entries.map((entry) => entry.name));
  for (const declaration of declarations) {
    if (!isMoneyPathName(declaration.name) || classified.has(declaration.name)) continue;
    const kind = isChainIdName(declaration.name) ? "chain id" : "RPC name";
    throw new Error(
      `unclassified ${kind} ${declaration.name} from ${declaration.origin}: ` +
        "add an explicit posture entry (mainnet_required, disabled_configuration, policy_bound_secret_rpc or guarded_optional_secret_rpc) to MONEY_PATH_POSTURES first",
    );
  }
}

function assertNoStaleEntries(
  discovered: ReadonlySet<string>,
  entries: readonly MoneyPathEntry[],
): void {
  for (const entry of entries) {
    if (!discovered.has(entry.name)) {
      throw new Error(
        `MONEY_PATH_POSTURES entry ${entry.name} is not declared by any deployed production config or the platform config module; remove or fix the stale entry`,
      );
    }
  }
}

function assertRequiredOwnership(
  declarations: readonly ProductionDeclaration[],
  entry: RequiredMoneyPathEntry,
): void {
  const expectedSource: DeclarationSource =
    entry.kind === "secret_rpc_url" ? "required-secret" : "vars";
  for (const app of entry.requiredInProduction) {
    const matches = declarations.filter(
      (declaration) => declaration.app === app && declaration.name === entry.name,
    );
    if (matches.length === 0) {
      throw new Error(`${entry.name} is required in ${app} production but is not declared`);
    }
    if (!matches.some((declaration) => declaration.source === expectedSource)) {
      throw new Error(
        `${entry.name} in ${app} production must be declared as ${
          expectedSource === "vars" ? "a var" : "a required secret"
        }`,
      );
    }
  }
}

/**
 * An entry with productionDeclaration "forbidden" must not appear in any
 * inspected production environment, neither as a var nor as a required secret.
 * The assertion covers checked-in declarations only; a remotely provisioned
 * Worker secret is not visible to it.
 */
function assertForbiddenInProduction(
  declarations: readonly ProductionDeclaration[],
  entry: ForbiddenGuardedOptionalSecretRpcEntry,
): void {
  for (const declaration of declarations) {
    if (declaration.name !== entry.name) continue;
    const source = declaration.source === "vars" ? "a var" : "a required secret";
    throw new Error(
      `${entry.name} is forbidden in production but ${declaration.app} declares it as ${source}; remove the declaration or change the posture with a separate owner decision`,
    );
  }
}

function assertProductionDeclarationPolicy(
  declarations: readonly ProductionDeclaration[],
  entry: MoneyPathEntry,
): void {
  if (entry.productionDeclaration === "forbidden") {
    assertForbiddenInProduction(declarations, entry);
    return;
  }
  if (entry.requiredInProduction.length === 0) {
    throw new Error(
      `${entry.name} has productionDeclaration "required" but names no production owner; intended absence must be declared "forbidden" explicitly`,
    );
  }
  assertRequiredOwnership(declarations, entry);
}

function assertMainnetPosture(
  declarations: readonly ProductionDeclaration[],
  entry: MainnetRequiredEntry,
): void {
  for (const declaration of declarations) {
    if (declaration.name !== entry.name) continue;
    if (declaration.source !== "vars") {
      throw new Error(
        `${entry.name} in ${declaration.app} production must be a var so its value can be asserted, not a ${declaration.source}`,
      );
    }
    if (Number(declaration.value) !== BASE_MAINNET_CHAIN_ID) {
      throw new Error(
        `${entry.name}=${String(declaration.value)} in ${declaration.app} production must be Base mainnet ${BASE_MAINNET_CHAIN_ID}`,
      );
    }
  }
}

function assertDisabledConfiguration(
  declarations: readonly ProductionDeclaration[],
  entry: DisabledConfigurationEntry,
): void {
  for (const declaration of declarations) {
    if (declaration.name !== entry.name) continue;
    const disablingFlag = declarations.find(
      (candidate) => candidate.app === declaration.app && candidate.name === entry.disablingFlag,
    );
    if (disablingFlag === undefined || disablingFlag.source !== "vars") {
      throw new Error(
        `${declaration.app} production declares ${entry.name} without the required disabling flag ${entry.disablingFlag} as a var`,
      );
    }
    if (disablingFlag.value !== entry.requiredFlagValue) {
      throw new Error(
        `${declaration.app} production ${entry.disablingFlag}=${String(disablingFlag.value)} must be exactly ${entry.requiredFlagValue} to keep ${entry.name} disabled`,
      );
    }
    if (entry.kind === "chain_id") {
      const admitted = entry.admittedChainIds;
      if (admitted === undefined) {
        throw new Error(
          `${entry.name} is a disabled chain id without admittedChainIds; the registry would fail open`,
        );
      }
      const chainId = Number(declaration.value);
      if (!admitted.includes(chainId)) {
        throw new Error(
          `${declaration.app} production ${entry.name}=${String(declaration.value)} is not an admitted disabled-path chain (${admitted.join(", ")}); classify it before it can deploy`,
        );
      }
    }
  }
}

function assertCrossConfigChainIdConsistency(declarations: readonly ProductionDeclaration[]): void {
  const byName = new Map<string, { readonly app: string; readonly value: string }[]>();
  for (const declaration of declarations) {
    if (declaration.source !== "vars" || !isChainIdName(declaration.name)) continue;
    const value = declaration.value;
    if (value === null) continue;
    const group = byName.get(declaration.name) ?? [];
    group.push({ app: declaration.app, value });
    byName.set(declaration.name, group);
  }
  for (const [name, group] of byName) {
    const distinct = new Set(group.map((member) => member.value));
    if (distinct.size > 1) {
      throw new Error(
        `${name} has divergent production values: ${group
          .map((member) => `${member.app}=${member.value}`)
          .join(", ")}`,
      );
    }
  }
}

/**
 * Object-literal field names for a runtime config declaration, resolving spread
 * references such as ...MegapotRewardConfigFields. Throws rather than returning
 * an empty list if the declaration disappears, so a parse drift cannot pass
 * vacuously.
 */
function declaredFieldNames(
  source: string,
  declarationName: string,
  seen: Set<string> = new Set(),
): readonly string[] {
  if (seen.has(declarationName)) return [];
  seen.add(declarationName);
  const declarationIndex = source.indexOf(`const ${declarationName} =`);
  if (declarationIndex === -1) {
    throw new Error(`runtime config declaration ${declarationName} was not found`);
  }
  const bodyStart = source.indexOf("{", declarationIndex);
  if (bodyStart === -1) {
    throw new Error(`runtime config declaration ${declarationName} has no object literal`);
  }
  let depth = 0;
  let body: string | undefined;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        body = source.slice(bodyStart, index + 1);
        break;
      }
    }
  }
  if (body === undefined) {
    throw new Error(
      `runtime config declaration ${declarationName} has an unbalanced object literal`,
    );
  }
  const names: string[] = [];
  for (const spread of body.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const spreadName = spread[1];
    if (spreadName !== undefined) names.push(...declaredFieldNames(source, spreadName, seen));
  }
  for (const field of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
    const fieldName = field[1];
    if (fieldName !== undefined) names.push(fieldName);
  }
  return names;
}

/**
 * Direct Effect Config and secret declarations in the platform config module.
 * Helper-wrapped HNS authority settings are outside this lane and are not
 * classified here.
 */
function directRuntimeConfigNames(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  const patterns = [
    /\bsecret\("([A-Z][A-Z0-9_]*)"\)/g,
    /\bConfig\.(?:boolean|int|string|nonEmptyString)\("([A-Z][A-Z0-9_]*)"\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

const platformConfigSource = await BunRuntime.file(new URL("./index.ts", import.meta.url)).text();
const runtimeDeclaredNames = directRuntimeConfigNames(platformConfigSource);
const runtimeMoneyPathNames = [...runtimeDeclaredNames].filter(isMoneyPathName).sort();
const moneyPathConfigFields = declaredFieldNames(platformConfigSource, "MoneyPathConfig");

const deployedConfigs = await Promise.all(
  DEPLOYED_WRANGLER_CONFIGS.map(async ({ app, path }) => {
    const document = BunRuntime.JSONC.parse(await BunRuntime.file(path).text()) as WranglerDocument;
    return { app, declarations: productionDeclarationsFrom(document, app) };
  }),
);
const deployedProductionDeclarations = deployedConfigs.flatMap((config) => config.declarations);
const productionDeclarationsByApp = new Map<string, readonly ProductionDeclaration[]>(
  deployedConfigs.map((config) => [config.app, config.declarations] as const),
);
const unionDiscoveredNames = new Set([
  ...deployedProductionDeclarations.map((declaration) => declaration.name),
  ...runtimeMoneyPathNames,
]);

function productionVar(app: string, name: string): string {
  const declaration = (productionDeclarationsByApp.get(app) ?? []).find(
    (candidate) => candidate.name === name && candidate.source === "vars",
  );
  if (declaration === undefined || declaration.value === null) {
    throw new Error(`${app} production must declare var ${name}`);
  }
  return declaration.value;
}

describe("deployed production money-path invariant", () => {
  test("inventory coverage: every production chain-id and RPC declaration carries an explicit posture", () => {
    assertAllDeclarationsClassified(
      [
        ...deployedProductionDeclarations.map((declaration) => ({
          name: declaration.name,
          origin: `${declaration.app} production ${
            declaration.source === "vars" ? "vars" : "required secrets"
          }`,
        })),
        ...runtimeMoneyPathNames.map((name) => ({
          name,
          origin: "packages/platform-cf/config/index.ts",
        })),
      ],
      MONEY_PATH_POSTURES,
    );
  });

  test("every registered posture is still declared somewhere inspected", () => {
    assertNoStaleEntries(unionDiscoveredNames, MONEY_PATH_POSTURES);
  });

  test("configuration assertion: every entry enforces its explicit production declaration intent", () => {
    // "required" entries must be declared in the Worker environments they name.
    // "forbidden" entries must be absent from checked-in production declarations
    // across every inspected Worker. This is declaration policy only; it does
    // not prove a remotely provisioned secret is absent.
    for (const entry of MONEY_PATH_POSTURES) {
      assertProductionDeclarationPolicy(deployedProductionDeclarations, entry);
    }
  });

  test("guarded_optional_secret_rpc separates its absence claim from its consumption guard", () => {
    const entry = MONEY_PATH_POSTURES.find((candidate) => candidate.name === "MEGAPOT_V2_RPC_URL");
    if (entry === undefined || entry.posture !== "guarded_optional_secret_rpc") {
      throw new Error("MEGAPOT_V2_RPC_URL left the guarded_optional_secret_rpc registry");
    }
    expect(entry.productionDeclaration).toBe("forbidden");
    expect(entry.guard).toContain("MEGAPOT_REWARDS_ENABLED");
    // The evidence limitation must state that neither claim proves a remotely
    // provisioned Worker secret is absent.
    expect(entry.evidenceLimitation).toMatch(/remotely provisioned/);
  });

  test("configuration assertion: production chain-id declarations match the classified chain entries", () => {
    const declared = new Set(
      deployedProductionDeclarations
        .filter((declaration) => declaration.source === "vars" && isChainIdName(declaration.name))
        .map((declaration) => declaration.name),
    );
    const classified = MONEY_PATH_POSTURES.filter((entry) => entry.kind === "chain_id").map(
      (entry) => entry.name,
    );
    expect([...declared].sort()).toEqual([...classified].sort());
  });

  test("mainnet_required chain ids hold Base mainnet in every environment that declares them", () => {
    for (const entry of MONEY_PATH_POSTURES) {
      if (entry.posture !== "mainnet_required") continue;
      assertRequiredOwnership(deployedProductionDeclarations, entry);
      assertMainnetPosture(deployedProductionDeclarations, entry);
    }
  });

  test("DATA disabled_configuration requires DATA_REGISTRATION_ENABLED exactly false in every owning production config", () => {
    // This configuration assertion proves the checked-in configuration is
    // disabled. It does not prove runtime enforcement occurs at the owning
    // Worker boundaries; those disabled-path tests are registered separately.
    for (const entry of MONEY_PATH_POSTURES) {
      if (entry.posture !== "disabled_configuration") continue;
      assertRequiredOwnership(deployedProductionDeclarations, entry);
      assertDisabledConfiguration(deployedProductionDeclarations, entry);
    }
  });

  test("configuration assertion: a chain id shared across production environments holds one value", () => {
    assertCrossConfigChainIdConsistency(deployedProductionDeclarations);
  });

  test("configuration assertion: COMMUNITY_PURCHASE_FUNDING_RPC_URL stays a declared production secret", () => {
    const entry = MONEY_PATH_POSTURES.find(
      (candidate) => candidate.name === "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
    );
    if (entry === undefined || entry.posture !== "policy_bound_secret_rpc") {
      throw new Error(
        "COMMUNITY_PURCHASE_FUNDING_RPC_URL left the policy_bound_secret_rpc registry",
      );
    }
    assertRequiredOwnership(deployedProductionDeclarations, entry);
    expect(entry.chainSource).toContain("community_commerce_money_route_policy_versions");
    // A secret must never be declared as a readable var; values are not asserted.
    expect(
      deployedProductionDeclarations
        .filter(
          (declaration) =>
            declaration.name === entry.name && declaration.source !== "required-secret",
        )
        .map((declaration) => declaration.app),
    ).toEqual([]);
  });

  test("executable guard: assertMegapotRewardRuntimePosture accepts the checked-in production values and rejects enablement", () => {
    for (const app of ["http-worker", "jobs-worker"] as const) {
      const rewardsEnabled = productionVar(app, "MEGAPOT_REWARDS_ENABLED");
      expect(rewardsEnabled).toBe("false");
      const posture = {
        API_NEXT_ENV: "production" as const,
        MEGAPOT_REWARDS_ENABLED: rewardsEnabled === "true",
        MEGAPOT_CHAIN_ID: Number(productionVar(app, "MEGAPOT_CHAIN_ID")),
        MEGAPOT_REQUIRED_CONFIRMATIONS: Number(
          productionVar(app, "MEGAPOT_REQUIRED_CONFIRMATIONS"),
        ),
      };
      expect(assertMegapotRewardRuntimePosture(posture)).toBe(BASE_MAINNET_CHAIN_ID);
      expect(() =>
        assertMegapotRewardRuntimePosture({ ...posture, MEGAPOT_REWARDS_ENABLED: true }),
      ).toThrow("invalid Megapot reward runtime posture");
    }
  });

  test("activation prerequisite: the Megapot attestation mismatch stays visible and unresolved", () => {
    for (const app of ["http-worker", "jobs-worker"] as const) {
      expect(productionVar(app, "MEGAPOT_REWARDS_ENABLED")).toBe("false");
      expect(Number(productionVar(app, "MEGAPOT_CHAIN_ID"))).toBe(BASE_MAINNET_CHAIN_ID);
      expect(productionVar(app, "MEGAPOT_ATTESTATION_ID")).toMatch(/sepolia|testnet/i);
    }
    expect(UNRESOLVED_ACTIVATION_PREREQUISITES["megapot-attestation-identity"]).toContain(
      MEGAPOT_TESTNET_ATTESTATION_ID,
    );
  });

  test("MoneyPathConfig is a cross-check only and its fields are accounted for", () => {
    expect(moneyPathConfigFields.length).toBeGreaterThan(0);
    expect(moneyPathConfigFields).toContain("COMMUNITY_PURCHASE_FUNDING_RPC_URL");
    expect(moneyPathConfigFields).toContain("MEGAPOT_CHAIN_ID");
    const entryNames = new Set<string>(MONEY_PATH_POSTURES.map((entry) => entry.name));
    const supporting = new Set<string>(
      MONEY_PATH_POSTURES.flatMap((entry) =>
        "supportingFields" in entry ? entry.supportingFields : [],
      ),
    );
    // MoneyPathConfig omits the DATA path entirely; discovery over the deployed
    // configs and the runtime module is what establishes completeness. This
    // check only keeps the cross-check list from drifting silently.
    for (const field of moneyPathConfigFields) {
      expect(entryNames.has(field) || supporting.has(field)).toBe(true);
    }
  });

  test("runtime configuration declarations are inventoried separately from wrangler declarations", () => {
    expect(runtimeMoneyPathNames).toContain("MEGAPOT_CHAIN_ID");
    expect(runtimeMoneyPathNames).toContain("MEGAPOT_V2_RPC_URL");
    expect(runtimeMoneyPathNames).toContain("COMMUNITY_PURCHASE_FUNDING_RPC_URL");
  });

  test("every posture entry states what its evidence does not prove", () => {
    for (const entry of MONEY_PATH_POSTURES) {
      expect(entry.evidenceLimitation.trim().length).toBeGreaterThan(0);
    }
  });

  test("unresolved activation prerequisites are named, referenced and stated", () => {
    const referenced = new Set<string>();
    for (const entry of MONEY_PATH_POSTURES) {
      if ("activationPrerequisite" in entry) referenced.add(entry.activationPrerequisite);
    }
    for (const [key, statement] of Object.entries(UNRESOLVED_ACTIVATION_PREREQUISITES)) {
      expect(referenced.has(key)).toBe(true);
      expect(statement.trim().length).toBeGreaterThan(0);
    }
  });

  test("regression: an undeclared production chain-id name fails the ratchet", () => {
    expect(() =>
      assertAllDeclarationsClassified(
        [{ name: "NEW_ROUTE_CHAIN_ID", origin: "synthetic-worker production vars" }],
        MONEY_PATH_POSTURES,
      ),
    ).toThrow(/unclassified chain id NEW_ROUTE_CHAIN_ID/);
  });

  test("regression: an undeclared RPC-only production path fails the ratchet", () => {
    expect(() =>
      assertAllDeclarationsClassified(
        [{ name: "NEW_ROUTE_RPC_URL", origin: "synthetic-worker production required secrets" }],
        MONEY_PATH_POSTURES,
      ),
    ).toThrow(/unclassified RPC name NEW_ROUTE_RPC_URL/);
  });

  test("regression: a forbidden entry fails when it appears as a production var", () => {
    const entry = MONEY_PATH_POSTURES.find((candidate) => candidate.name === "MEGAPOT_V2_RPC_URL");
    if (entry === undefined || entry.productionDeclaration !== "forbidden") {
      throw new Error("MEGAPOT_V2_RPC_URL left the forbidden declaration registry");
    }
    expect(() =>
      assertForbiddenInProduction(
        [
          {
            app: "synthetic-worker",
            name: entry.name,
            source: "vars",
            value: "https://rpc.invalid",
          },
        ],
        entry,
      ),
    ).toThrow(/forbidden in production but synthetic-worker declares it as a var/);
  });

  test("regression: a forbidden entry fails when it appears in required secrets", () => {
    const entry = MONEY_PATH_POSTURES.find((candidate) => candidate.name === "MEGAPOT_V2_RPC_URL");
    if (entry === undefined || entry.productionDeclaration !== "forbidden") {
      throw new Error("MEGAPOT_V2_RPC_URL left the forbidden declaration registry");
    }
    expect(() =>
      assertForbiddenInProduction(
        [{ app: "jobs-worker", name: entry.name, source: "required-secret", value: null }],
        entry,
      ),
    ).toThrow(/forbidden in production but jobs-worker declares it as a required secret/);
  });

  test("regression: the DATA disabled_configuration fails when its flag is absent or not false", () => {
    const entry = MONEY_PATH_POSTURES.find(
      (candidate) => candidate.name === "DATA_REGISTRATION_CHAIN_ID",
    );
    if (entry === undefined || entry.posture !== "disabled_configuration") {
      throw new Error("DATA_REGISTRATION_CHAIN_ID left the disabled_configuration registry");
    }
    const declaration = {
      app: "synthetic-worker",
      name: entry.name,
      source: "vars",
      value: "1315",
    } as const;
    expect(() => assertDisabledConfiguration([declaration], entry)).toThrow(
      /DATA_REGISTRATION_ENABLED/,
    );
    expect(() =>
      assertDisabledConfiguration(
        [
          declaration,
          {
            app: "synthetic-worker",
            name: "DATA_REGISTRATION_ENABLED",
            source: "vars",
            value: "true",
          },
        ],
        entry,
      ),
    ).toThrow(/must be exactly false/);
    assertDisabledConfiguration(
      [
        declaration,
        {
          app: "synthetic-worker",
          name: "DATA_REGISTRATION_ENABLED",
          source: "vars",
          value: "false",
        },
      ],
      entry,
    );
    expect(() =>
      assertDisabledConfiguration(
        [
          { app: "synthetic-worker", name: entry.name, source: "vars", value: "8453" },
          {
            app: "synthetic-worker",
            name: "DATA_REGISTRATION_ENABLED",
            source: "vars",
            value: "false",
          },
        ],
        entry,
      ),
    ).toThrow(/not an admitted disabled-path chain/);
  });

  test("regression: divergent same-purpose chain ids fail the cross-config check", () => {
    expect(() =>
      assertCrossConfigChainIdConsistency([
        { app: "worker-a", name: "SHARED_CHAIN_ID", source: "vars", value: "1315" },
        { app: "worker-b", name: "SHARED_CHAIN_ID", source: "vars", value: "8453" },
      ]),
    ).toThrow(/SHARED_CHAIN_ID has divergent production values/);
  });

  test("regression: production discovery reads env.production only and fails closed without it", () => {
    const declarations = productionDeclarationsFrom(
      {
        vars: { TOP_LEVEL_RPC_URL: "https://top.invalid" },
        secrets: { required: ["TOP_LEVEL_SECRET"] },
        env: {
          staging: {
            vars: { STAGING_CHAIN_ID: "84532" },
            secrets: { required: ["STAGING_SECRET"] },
          },
          production: {
            vars: { API_NEXT_ENV: "production" },
            secrets: { required: ["PRODUCTION_SECRET"] },
          },
        },
      },
      "synthetic-worker",
    );
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      "API_NEXT_ENV",
      "PRODUCTION_SECRET",
    ]);
    expect(() => productionDeclarationsFrom({ env: {} }, "synthetic-worker")).toThrow(
      /env\.production/,
    );
  });
});
