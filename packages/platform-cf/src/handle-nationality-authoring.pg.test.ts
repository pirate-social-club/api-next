import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneHandleNationalityAuthoringStore } from "./handle-nationality-authoring-repository.ts";
import {
  bindPersonaToCommunity,
  seedAccount,
  seedSaleNamespace,
  terms,
} from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { type NationalityAuthoring, resolveNationalityAuthoring } from "./nationality-authoring.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_HANDLE_NATIONALITY_AUTHORING_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-handle-nationality-authoring-suite-complete";
let completed = 0;
const authoring = resolveNationalityAuthoring({
  enabled: true,
  policyRevision: 1,
  evidenceLifetimeSeconds: 31_536_000,
  environment: "test",
  selfPass: { callbackOrigin: "https://api.example.invalid", mockPassport: false },
  zkPassport: { domain: "api.example.invalid", devMode: false },
}) as NationalityAuthoring;

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `handle_nationality_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await admin.query(
      "INSERT INTO users (user_id,status) VALUES ('seller','active'),('stranger','active')",
    );
    await admin.query(`INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at,route_slug,route_authority_version)
      VALUES ('community_00000000-0000-4000-8000-000000000001','Qualification','active','seller',clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`);
    await admin.query(`INSERT INTO community_handle_sales_authority_grants
      (grant_id,community_id,principal_account_id,authority,source_kind,status,granted_at,granted_by_account_id)
      VALUES (community_handle_sales_creator_grant_id_v1('community_00000000-0000-4000-8000-000000000001','seller'),'community_00000000-0000-4000-8000-000000000001','seller','manage_handle_sales','creator_owner','active',clock_timestamp(),'seller')`);
    await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

const store = (connection: string, configuration: NationalityAuthoring | null = authoring) =>
  makeControlPlaneHandleNationalityAuthoringStore(
    makeDirectPostgresControlPlaneLayer(connection),
    configuration,
  );
const actor = {
  accountId: "seller",
  communityId: "community_00000000-0000-4000-8000-000000000001",
};
async function command(connection: string) {
  const context = await Effect.runPromise(store(connection).getContext(actor));
  return {
    ...actor,
    policyId: "policy-1",
    actionId: "action-1",
    idempotencyKey: "command-1",
    authoringReference: context.authoring_reference,
    allowedCountries: ["USA", "US"],
  };
}

suite("handle nationality policy authoring", () => {
  test("requires actual sales authority and explicit enabled authoring before exposing a reference", async () => {
    await withSchema(async (admin, connection) => {
      expect(
        (
          await Effect.runPromise(
            Effect.exit(store(connection).getContext({ ...actor, accountId: "stranger" })),
          )
        )._tag,
      ).toBe("Failure");
      expect(
        (await Effect.runPromise(Effect.exit(store(connection, null).getContext(actor))))._tag,
      ).toBe("Failure");
      const context = await Effect.runPromise(store(connection).getContext(actor));
      expect(context.accepted_provider_ids).toEqual(["self.pass", "zkpassport"]);
      expect(context.lifetime).toEqual({ kind: "max_age_seconds", seconds: 31_536_000 });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM handle_nationality_policy_actions"))
          .rows[0].count,
      ).toBe(0);
    });
    completed++;
  });

  test("normalizes the seller allowlist, pins both providers, and replays one immutable policy", async () => {
    await withSchema(async (admin, connection) => {
      const input = await command(connection);
      const result = await Effect.runPromise(store(connection).createPolicy(input));
      const replay = await Effect.runPromise(
        store(connection).createPolicy({
          ...input,
          policyId: "unused",
          actionId: "unused",
          allowedCountries: ["US"],
        }),
      );
      expect(replay).toEqual({ ...result, replayed: true });
      const rows = await admin.query(
        "SELECT nationality_policy FROM handle_qualification_policy_revisions WHERE policy_id='policy-1'",
      );
      expect(rows.rows[0].nationality_policy.requirement.allowed_countries).toEqual(["US"]);
      expect(result.qualification_policy.provider_binding_hashes).toHaveLength(2);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM handle_nationality_policy_actions"))
          .rows[0].count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM community_memberships WHERE community_id='community_00000000-0000-4000-8000-000000000001'",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    completed++;
  });

  test("serializes duplicate commands and refuses changed requests or stale server references", async () => {
    await withSchema(async (admin, connection) => {
      const input = await command(connection);
      const results = await Promise.all([
        Effect.runPromise(store(connection).createPolicy(input)),
        Effect.runPromise(
          store(connection).createPolicy({
            ...input,
            policyId: "concurrent",
            actionId: "concurrent",
          }),
        ),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.qualification_policy).toEqual(results[1]?.qualification_policy);
      for (const changed of [
        { allowedCountries: ["CA"] },
        { authoringReference: "a".repeat(64) },
        { accountId: "stranger" },
      ]) {
        expect(
          (
            await Effect.runPromise(
              Effect.exit(store(connection).createPolicy({ ...input, ...changed })),
            )
          )._tag,
        ).toBe("Failure");
      }
      const next = store(connection, { ...authoring, policy_revision: 2 });
      expect(
        (
          await Effect.runPromise(
            Effect.exit(next.createPolicy({ ...input, idempotencyKey: "new-command" })),
          )
        )._tag,
      ).toBe("Failure");
      expect((await Effect.runPromise(next.createPolicy(input))).replayed).toBe(true);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM handle_nationality_policy_actions"))
          .rows[0].count,
      ).toBe(1);
    });
    completed++;
  });

  test("rolls back policy insertion when action persistence fails and makes accepted rows immutable", async () => {
    await withSchema(async (admin, connection) => {
      const input = await command(connection);
      await Effect.runPromise(store(connection).createPolicy(input));
      expect(
        (
          await Effect.runPromise(
            Effect.exit(
              store(connection).createPolicy({
                ...input,
                policyId: "rolled-back",
                idempotencyKey: "second-command",
              }),
            ),
          )
        )._tag,
      ).toBe("Failure");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM handle_qualification_policy_revisions WHERE policy_id='rolled-back'",
          )
        ).rows[0].count,
      ).toBe(0);
      await expect(
        admin.query("UPDATE handle_nationality_policy_actions SET request_hash=repeat('a',64)"),
      ).rejects.toThrow();
      await expect(
        admin.query(
          "UPDATE handle_qualification_policy_revisions SET policy_hash=repeat('a',64) WHERE policy_id='policy-1'",
        ),
      ).rejects.toThrow();
      for (const document of [
        "nationality_policy - 'evidence_lifetime'",
        "jsonb_set(nationality_policy,'{provider_bindings}',jsonb_build_array(nationality_policy->'provider_bindings'->0))",
      ]) {
        await expect(
          admin.query(`INSERT INTO handle_qualification_policy_revisions
          (policy_id,policy_revision,community_id,policy_kind,request_hash,policy_hash,requirement_kind,status,created_by_account_id,created_at,nationality_policy)
          SELECT 'invalid',policy_revision,community_id,policy_kind,request_hash,policy_hash,requirement_kind,status,created_by_account_id,created_at,${document}
          FROM handle_qualification_policy_revisions WHERE policy_id='policy-1'`),
        ).rejects.toThrow();
      }
    });
    completed++;
  });
  test("authors an independent nationality offering without issuing an unqualified quote", async () => {
    await withSchema(async (admin, connection) => {
      const communityId = "community_00000000-0000-4000-8000-000000000002";
      const activationId = await seedSaleNamespace(admin, "seller", communityId);
      const seller = { accountId: "seller", communityId };
      const context = await Effect.runPromise(store(connection).getContext(seller));
      const authored = await Effect.runPromise(
        store(connection).createPolicy({
          ...seller,
          policyId: "offering-policy",
          actionId: "offering-policy-action",
          idempotencyKey: "offering-policy-command",
          authoringReference: context.authoring_reference,
          allowedCountries: ["US"],
        }),
      );
      const sales = makeControlPlaneHandleSalesStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const input = {
        ...seller,
        offeringId: "nationality-offering",
        actionId: "offering-action",
        idempotencyKey: "offering-command",
        terms: {
          ...terms(activationId),
          qualification_policy_id: authored.qualification_policy.policy_id,
          expected_qualification_policy_revision: authored.qualification_policy.policy_revision,
        },
      };
      const offering = await Effect.runPromise(sales.createOffering(input));
      expect(offering.offering.qualification_policy).toEqual(authored.qualification_policy);
      expect(
        (
          await Effect.runPromise(
            sales.createOffering({ ...input, offeringId: "unused", actionId: "unused" }),
          )
        ).offering,
      ).toEqual(offering.offering);
      expect(
        (await Effect.runPromise(sales.listOfferings({ communityId }))).items[0]
          ?.qualification_policy,
      ).toEqual(authored.qualification_policy);
      const personaId = await seedAccount(admin, "buyer", { humanEvidence: false });
      await bindPersonaToCommunity(admin, { accountId: "buyer", personaId, communityId });
      const outcome = await Effect.runPromise(
        Effect.exit(
          sales.createQuote({
            accountId: "buyer",
            personaId,
            offeringId: offering.offering.offering_id,
            desiredLabel: "charizard",
            idempotencyKey: "quote-command",
            quoteId: "denied-quote",
            actionId: "denied-quote-action",
          }),
        ),
      );
      expect(outcome._tag).toBe("Failure");
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM handle_quotes")).rows[0].count,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM community_memberships WHERE user_id='buyer'",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    completed++;
  });
});

afterAll(async () => {
  if (connectionString && completed === 5)
    await Bun.write(
      sentinel,
      "api-next-control-plane-postgres-handle-nationality-authoring-suite-complete\n",
    );
});
