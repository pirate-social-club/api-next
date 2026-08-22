import {
  COMMUNITY_GATE_COMPILER_VERSION,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";

import { normalizePostgresConnectionString } from "./postgres-migrations.ts";
import {
  loadPublicProfileBackfillPgDriver,
  type PublicProfileBackfillPgClient,
} from "./public-profile-backfill-pg.ts";
import {
  parseVeryStagingFixtureOptions,
  VeryStagingFixtureError,
  type VeryStagingFixtureOptions,
  type VeryStagingFixtureResult,
  veryStagingFixtureResult,
} from "./very-staging-community-fixture-options.ts";

const FIXTURE_DISPLAY_NAME = "Very staging ceremony fixture";
const FIXTURE_DESCRIPTION =
  "Synthetic staging-only fixture for Very desktop and mobile ceremony acceptance.";
const UNIQUENESS_MODEL = { kind: "none" } as const;
const COMPILED_PLAN = {
  compiler_version: COMMUNITY_GATE_COMPILER_VERSION,
  evaluator: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
  provider_binding: {
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    method: VERY_WEB_METHOD,
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
  },
} as const;

type OperatorRow = Readonly<{ readonly user_id: string }>;
type ExactRow = Readonly<{ readonly exact: boolean }>;
type CommunityRow = Readonly<{
  readonly status: string;
  readonly exact: boolean;
}>;

type FixtureState = Readonly<{
  readonly communityStatus: string | null;
  readonly communityExact: boolean;
  readonly policyExists: boolean;
  readonly policyExact: boolean;
  readonly bindingExists: boolean;
  readonly bindingExact: boolean;
  readonly pointerExists: boolean;
  readonly pointerExact: boolean;
}>;

function oneOrNone<A>(rows: readonly A[], label: string): A | null {
  if (rows.length > 1) throw new VeryStagingFixtureError(`${label} returned duplicate rows.`);
  return rows[0] ?? null;
}

async function loadFixtureState(
  client: PublicProfileBackfillPgClient,
  input: Pick<VeryStagingFixtureOptions, "communityId" | "operatorUserId">,
): Promise<FixtureState> {
  const operator = oneOrNone(
    (
      await client.query<OperatorRow>(
        "SELECT user_id FROM users WHERE user_id = $1 AND status = 'active'",
        [input.operatorUserId],
      )
    ).rows,
    "Operator lookup",
  );
  if (operator?.user_id !== input.operatorUserId) {
    throw new VeryStagingFixtureError("The recorded operator principal is not an active user.");
  }

  const community = oneOrNone(
    (
      await client.query<CommunityRow>(
        `SELECT status,
                display_name = $2
                AND description = $3
                AND membership_mode = 'gated'
                AND human_verification_lane = 'very'
                AND created_by_user_id = $4 AS exact
           FROM communities
          WHERE community_id = $1`,
        [input.communityId, FIXTURE_DISPLAY_NAME, FIXTURE_DESCRIPTION, input.operatorUserId],
      )
    ).rows,
    "Community lookup",
  );
  const policy = oneOrNone(
    (
      await client.query<ExactRow>(
        `SELECT revision = $4
                AND policy_hash = $5
                AND policy = $6::jsonb
                AND compiled_plan = $7::jsonb
                AND compiler_version = $8
                AND uniqueness_model = $9::jsonb
                AND created_by_user_id = $10
                AND policy_purpose = 'access' AS exact
           FROM policy_versions
          WHERE community_id = $1 AND policy_key = $2 AND policy_version_id = $3`,
        [
          input.communityId,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
          JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
          JSON.stringify(COMPILED_PLAN),
          COMMUNITY_GATE_COMPILER_VERSION,
          JSON.stringify(UNIQUENESS_MODEL),
          input.operatorUserId,
        ],
      )
    ).rows,
    "Policy lookup",
  );
  const binding = oneOrNone(
    (
      await client.query<ExactRow>(
        `SELECT verification_requirement_hash = $4
                AND provider_id = $5
                AND provider_configuration_kind = 'dynamic'
                AND provider_configuration_ref = $6
                AND provider_configuration_version = $7
                AND method = $8
                AND protocol_version = $9
                AND issuer = $10
                AND scope_kind = 'issuer_rp_scope'
                AND issuer_rp_scope = $11
                AND issuer_rp_action_scope IS NULL
                AND request_mode = 'dynamic'
                AND evaluator_id = $3 AS exact
           FROM community_policy_provider_bindings
          WHERE community_id = $1 AND policy_key = $2 AND policy_version_id = $3`,
        [
          input.communityId,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
          HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
          VERY_WEB_PROVIDER_ID,
          VERY_WEB_CONFIGURATION_REFERENCE,
          VERY_WEB_CONFIGURATION_VERSION,
          VERY_WEB_METHOD,
          VERY_WEB_PROTOCOL_VERSION,
          VERY_WEB_ISSUER,
          VERY_WEB_RP_SCOPE,
        ],
      )
    ).rows,
    "Provider binding lookup",
  );
  const pointer = oneOrNone(
    (
      await client.query<ExactRow>(
        `SELECT policy_version_id = $3 AS exact
           FROM community_policy_current
          WHERE community_id = $1 AND policy_key = $2`,
        [
          input.communityId,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
          CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
        ],
      )
    ).rows,
    "Current policy lookup",
  );
  return {
    communityStatus: community?.status ?? null,
    communityExact: community?.exact === true,
    policyExists: policy !== null,
    policyExact: policy?.exact === true,
    bindingExists: binding !== null,
    bindingExact: binding?.exact === true,
    pointerExists: pointer !== null,
    pointerExact: pointer?.exact === true,
  };
}

function assertExactOrAbsent(state: FixtureState): void {
  if (
    (state.communityStatus !== null && !state.communityExact) ||
    (state.policyExists && !state.policyExact) ||
    (state.bindingExists && !state.bindingExact) ||
    (state.pointerExists && !state.pointerExact)
  ) {
    throw new VeryStagingFixtureError("Existing fixture rows do not match the pinned contract.");
  }
  const present = [
    state.communityStatus !== null,
    state.policyExists,
    state.bindingExists,
    state.pointerExists,
  ].filter(Boolean).length;
  if (present !== 0 && present !== 4) {
    throw new VeryStagingFixtureError("The fixture is only partially present; refusing repair.");
  }
}

async function seed(
  client: PublicProfileBackfillPgClient,
  options: VeryStagingFixtureOptions,
): Promise<void> {
  await client.query(
    `INSERT INTO communities (
       community_id, display_name, description, status, membership_mode,
       human_verification_lane, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'active', 'gated', 'very', $4,
               clock_timestamp(), clock_timestamp())
     ON CONFLICT DO NOTHING`,
    [options.communityId, FIXTURE_DISPLAY_NAME, FIXTURE_DESCRIPTION, options.operatorUserId],
  );
  await client.query(
    `INSERT INTO policy_versions (
       policy_version_id, community_id, policy_key, revision, policy_hash,
       policy, compiled_plan, compiler_version, uniqueness_model,
       created_by_user_id, published_at, policy_purpose
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb,
               $10, clock_timestamp(), 'access')
     ON CONFLICT DO NOTHING`,
    [
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
      options.communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
      JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
      JSON.stringify(COMPILED_PLAN),
      COMMUNITY_GATE_COMPILER_VERSION,
      JSON.stringify(UNIQUENESS_MODEL),
      options.operatorUserId,
    ],
  );
  await client.query(
    `INSERT INTO community_policy_provider_bindings (
       policy_version_id, community_id, policy_key, verification_requirement_hash,
       provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, method, protocol_version, issuer, scope_kind,
       issuer_rp_scope, issuer_rp_action_scope, request_mode, evaluator_id
     ) VALUES ($1, $2, $3, $4, $5, 'dynamic', $6, $7, $8, $9, $10,
               'issuer_rp_scope', $11, NULL, 'dynamic', $1)
     ON CONFLICT DO NOTHING`,
    [
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
      options.communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_PROTOCOL_VERSION,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
    ],
  );
  await client.query(
    `INSERT INTO community_policy_current (
       community_id, policy_key, policy_version_id, activated_at, updated_at
     ) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())
     ON CONFLICT DO NOTHING`,
    [
      options.communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
    ],
  );
}

async function executeApply(
  client: PublicProfileBackfillPgClient,
  options: VeryStagingFixtureOptions,
): Promise<VeryStagingFixtureResult> {
  await client.query("BEGIN");
  try {
    const before = await loadFixtureState(client, options);
    assertExactOrAbsent(before);
    let outcome: VeryStagingFixtureResult;
    if (options.action === "seed") {
      if (before.communityStatus === "hidden" || before.communityStatus === "archived") {
        throw new VeryStagingFixtureError("A deactivated fixture is not reactivated.");
      }
      if (before.communityStatus === "active") {
        outcome = veryStagingFixtureResult(options, "already_seeded");
      } else {
        await seed(client, options);
        const after = await loadFixtureState(client, options);
        assertExactOrAbsent(after);
        if (after.communityStatus !== "active") {
          throw new VeryStagingFixtureError("Fixture verification failed after seed.");
        }
        outcome = veryStagingFixtureResult(options, "seeded");
      }
    } else {
      if (before.communityStatus === null) {
        throw new VeryStagingFixtureError("Fixture not found.");
      }
      if (before.communityStatus === "hidden") {
        outcome = veryStagingFixtureResult(options, "already_deactivated");
      } else if (before.communityStatus === "active") {
        await client.query(
          `UPDATE communities
              SET status = 'hidden', updated_at = clock_timestamp()
            WHERE community_id = $1 AND created_by_user_id = $2 AND status = 'active'`,
          [options.communityId, options.operatorUserId],
        );
        const after = await loadFixtureState(client, options);
        assertExactOrAbsent(after);
        if (after.communityStatus !== "hidden") {
          throw new VeryStagingFixtureError("Fixture verification failed after deactivation.");
        }
        outcome = veryStagingFixtureResult(options, "deactivated");
      } else {
        throw new VeryStagingFixtureError("Fixture community has an unsupported status.");
      }
    }
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executeDryRun(
  client: PublicProfileBackfillPgClient,
  options: VeryStagingFixtureOptions,
): Promise<VeryStagingFixtureResult> {
  const state = await loadFixtureState(client, options);
  assertExactOrAbsent(state);
  if (options.action === "seed") {
    if (state.communityStatus === "active") {
      return veryStagingFixtureResult(options, "already_seeded");
    }
    if (state.communityStatus !== null) {
      throw new VeryStagingFixtureError("A deactivated fixture is not reactivated.");
    }
    return veryStagingFixtureResult(options, "would_seed");
  }
  if (state.communityStatus === "active") {
    return veryStagingFixtureResult(options, "would_deactivate");
  }
  if (state.communityStatus === "hidden") {
    return veryStagingFixtureResult(options, "already_deactivated");
  }
  throw new VeryStagingFixtureError("Fixture not found or has an unsupported status.");
}

export async function runVeryStagingCommunityFixture(
  options: VeryStagingFixtureOptions,
): Promise<VeryStagingFixtureResult> {
  const { Client } = await loadPublicProfileBackfillPgDriver();
  const client = new Client({
    connectionString: normalizePostgresConnectionString(options.connectionString),
  });
  await client.connect();
  try {
    return options.mode === "apply"
      ? await executeApply(client, options)
      : await executeDryRun(client, options);
  } finally {
    await client.end();
  }
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const options = parseVeryStagingFixtureOptions(args);
  const output = await runVeryStagingCommunityFixture(options);
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Very staging fixture failed");
    process.exitCode = 1;
  });
}
