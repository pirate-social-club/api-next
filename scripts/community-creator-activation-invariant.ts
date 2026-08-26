import * as BunRuntime from "bun";

const HTTP_CONFIG_PATH = new URL("../apps/http-worker/wrangler.jsonc", import.meta.url);
const POSTGRES_SCHEMA_PATH = new URL("../db/postgres/schema.sql", import.meta.url);

interface RawHttpWorkerConfig {
  readonly env?: Readonly<
    Record<
      string,
      {
        readonly vars?: Readonly<Record<string, unknown>>;
      }
    >
  >;
}

export interface CommunityCreatorActivationInput {
  readonly apiEnvironment: unknown;
  readonly selfPassEnabled: unknown;
  readonly veryOauthEnabled: unknown;
  readonly schemaSql: string;
}

const compactSql = (sql: string): string => sql.replaceAll(/\s+/g, " ").trim();

export const hasNoActionCommunityCreatorForeignKey = (schemaSql: string): boolean => {
  const statement = compactSql(schemaSql).match(
    /ALTER TABLE ONLY (?:public\.)?communities ADD CONSTRAINT [^ ;]+ FOREIGN KEY \(created_by_user_id\) REFERENCES (?:public\.)?users\s*\(user_id\)([^;]*);/u,
  );
  if (statement === null) return false;

  const suffix = statement[1] ?? "";
  return !/\bON DELETE\b/u.test(suffix) || /\bON DELETE NO ACTION\b/u.test(suffix);
};

const isEnabled = (value: unknown): boolean => value === "true" || value === true;

export const auditCommunityCreatorActivation = ({
  apiEnvironment,
  selfPassEnabled,
  veryOauthEnabled,
  schemaSql,
}: CommunityCreatorActivationInput): readonly string[] => {
  const violations: string[] = [];
  if (apiEnvironment !== "production") {
    violations.push(
      `http/production: API_NEXT_ENV must be production, got ${String(apiEnvironment)}`,
    );
  }

  const enabledProviders = [
    isEnabled(selfPassEnabled) ? "SELF_PASS_ENABLED" : undefined,
    isEnabled(veryOauthEnabled) ? "VERY_OAUTH_ENABLED" : undefined,
  ].filter((name): name is string => name !== undefined);

  if (enabledProviders.length > 0 && !hasNoActionCommunityCreatorForeignKey(schemaSql)) {
    violations.push(
      `http/production: ${enabledProviders.join(
        ", ",
      )} requires communities.created_by_user_id to reference users.user_id with NO ACTION delete semantics`,
    );
  }

  return violations;
};

export const auditConfiguredCommunityCreatorActivation = async (): Promise<readonly string[]> => {
  const config = BunRuntime.JSONC.parse(
    await BunRuntime.file(HTTP_CONFIG_PATH).text(),
  ) as RawHttpWorkerConfig;
  const productionVars = config.env?.production?.vars ?? {};

  return auditCommunityCreatorActivation({
    apiEnvironment: productionVars.API_NEXT_ENV,
    selfPassEnabled: productionVars.SELF_PASS_ENABLED,
    veryOauthEnabled: productionVars.VERY_OAUTH_ENABLED,
    schemaSql: await BunRuntime.file(POSTGRES_SCHEMA_PATH).text(),
  });
};

export const assertConfiguredCommunityCreatorActivation = async (): Promise<void> => {
  const violations = await auditConfiguredCommunityCreatorActivation();
  if (violations.length > 0) {
    throw new Error(`Community creator activation invariant failed:\n${violations.join("\n")}`);
  }
};

if (import.meta.main) {
  await assertConfiguredCommunityCreatorActivation();
  console.log("community-creator-activation-invariant: ok");
}
