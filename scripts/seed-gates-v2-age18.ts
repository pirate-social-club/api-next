import { ControlPlaneDb } from "@pirate/application";
import { CURATED_AGE_18_POLICY } from "@pirate/domain";
import { Effect } from "effect";

import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const COMPILED_PLAN = {
  kind: "curated_age",
  evaluator: "gates-v2-curated-age-v1",
} as const;

const UNIQUENESS_MODEL = { kind: "none" } as const;

type SeedInput = Readonly<{
  readonly connectionString: string;
  readonly communityId: string;
}>;

type CommunityRow = Readonly<{
  readonly community_id: string;
  readonly membership_mode: string;
}>;

type PolicyRow = Readonly<{
  readonly policy_version_id: string;
  readonly community_id: string;
  readonly policy_key: string;
  readonly revision: number;
  readonly policy_hash: string;
}>;

type PointerRow = Readonly<{
  readonly community_id: string;
  readonly policy_key: string;
  readonly policy_version_id: string;
}>;

const requireOne = <A>(rows: readonly A[], message: string): A => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(message);
  return rows[0];
};

export async function seedCuratedAge18Policy(input: SeedInput): Promise<{
  readonly communityId: string;
  readonly policyVersionId: string;
  readonly policyHash: string;
}> {
  const policyJson = JSON.stringify(CURATED_AGE_18_POLICY);
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const communityResult = yield* transaction.execute<CommunityRow>({
              label: "gates.seed.age18.community",
              text: `SELECT community_id, membership_mode
                       FROM communities
                      WHERE community_id = $1
                        AND status = 'active'
                      FOR UPDATE`,
              values: [input.communityId],
              readonly: false,
            });
            const community = requireOne(
              communityResult.rows,
              `Active community not found: ${input.communityId}`,
            );
            if (community.membership_mode !== "gated") {
              throw new Error(`Community is not gated: ${input.communityId}`);
            }

            yield* transaction.execute({
              label: "gates.seed.age18.policy",
              text: `INSERT INTO policy_versions (
                       policy_version_id, community_id, policy_key, revision, policy_hash,
                       policy, compiled_plan, compiler_version, uniqueness_model,
                       created_by_user_id, published_at, policy_purpose
                     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb,
                               NULL, clock_timestamp(), 'access')
                     ON CONFLICT DO NOTHING`,
              values: [
                CURATED_AGE_18_POLICY.policy_version_id,
                input.communityId,
                CURATED_AGE_18_POLICY.policy_key,
                CURATED_AGE_18_POLICY.policy_revision,
                CURATED_AGE_18_POLICY.policy_hash,
                policyJson,
                JSON.stringify(COMPILED_PLAN),
                "gates-v2-curated-age-v1",
                JSON.stringify(UNIQUENESS_MODEL),
              ],
              readonly: false,
            });

            const policyResult = yield* transaction.execute<PolicyRow>({
              label: "gates.seed.age18.policy.verify",
              text: `SELECT policy_version_id, community_id, policy_key, revision, policy_hash
                       FROM policy_versions
                      WHERE policy_version_id = $1
                        AND community_id = $2
                        AND policy_key = $3
                        AND revision = $4
                        AND policy_hash = $5
                        AND policy = $6::jsonb
                        AND compiled_plan = $7::jsonb
                        AND compiler_version = $8
                        AND uniqueness_model = $9::jsonb
                        AND policy_purpose = 'access'`,
              values: [
                CURATED_AGE_18_POLICY.policy_version_id,
                input.communityId,
                CURATED_AGE_18_POLICY.policy_key,
                CURATED_AGE_18_POLICY.policy_revision,
                CURATED_AGE_18_POLICY.policy_hash,
                policyJson,
                JSON.stringify(COMPILED_PLAN),
                "gates-v2-curated-age-v1",
                JSON.stringify(UNIQUENESS_MODEL),
              ],
              readonly: true,
            });
            requireOne(
              policyResult.rows,
              "Curated age policy row does not match the pinned revision",
            );

            yield* transaction.execute({
              label: "gates.seed.age18.pointer",
              text: `INSERT INTO community_policy_current (
                       community_id, policy_key, policy_version_id, activated_at
                     ) VALUES ($1, $2, $3, clock_timestamp())
                     ON CONFLICT (community_id, policy_key) DO NOTHING`,
              values: [
                input.communityId,
                CURATED_AGE_18_POLICY.policy_key,
                CURATED_AGE_18_POLICY.policy_version_id,
              ],
              readonly: false,
            });

            const pointerResult = yield* transaction.execute<PointerRow>({
              label: "gates.seed.age18.pointer.verify",
              text: `SELECT community_id, policy_key, policy_version_id
                       FROM community_policy_current
                      WHERE community_id = $1
                        AND policy_key = $2
                        AND policy_version_id = $3`,
              values: [
                input.communityId,
                CURATED_AGE_18_POLICY.policy_key,
                CURATED_AGE_18_POLICY.policy_version_id,
              ],
              readonly: true,
            });
            requireOne(
              pointerResult.rows,
              "Current community policy pointer does not match age 18",
            );

            return {
              communityId: input.communityId,
              policyVersionId: CURATED_AGE_18_POLICY.policy_version_id,
              policyHash: CURATED_AGE_18_POLICY.policy_hash,
            };
          }),
        );
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(
            normalizePostgresConnectionString(input.connectionString),
          ),
        ),
      ),
    ),
  );
  return result;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const apply = args.includes("--apply");
  const positional = args.filter((argument) => argument !== "--apply");
  if (!apply) throw new Error("Refusing to seed without --apply");
  if (positional.length !== 1 || positional[0] === undefined || positional[0].trim() === "") {
    throw new Error("Usage: bun scripts/seed-gates-v2-age18.ts --apply <community-id>");
  }
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  if (!connectionString) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL is required");
  const result = await seedCuratedAge18Policy({
    connectionString,
    communityId: positional[0],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Gates v2 policy seed failed");
    process.exitCode = 1;
  });
}
