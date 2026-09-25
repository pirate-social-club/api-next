import { afterAll, describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  HandleSalesRejected,
  SpacesSaleNamespaceNotReady,
  type SpacesSaleNamespaceStore,
} from "@pirate/application";
import {
  compileSpacesMembershipQualificationV1,
  handleSpacesMembershipPolicyHash,
  handleSpacesMembershipSourceHash,
  handleSpacesSaleNamespaceActivationHash,
} from "@pirate/domain";
import { bech32m } from "@scure/base";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneHandleNationalityAuthoringStore } from "./handle-nationality-authoring-repository.ts";
import { seedAccount, seedSaleNamespace, terms } from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { type NationalityAuthoring, resolveNationalityAuthoring } from "./nationality-authoring.ts";
import { makeControlPlanePersonaWalletStore } from "./persona-repository.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  configureSpacesNetwork,
  enableSpacesDriverForRoot,
  grantSpacesSalesAuthority,
  recordSpacesAuthorityEvidence,
  seedSpacesOperatorAssignment,
  seedSpacesSeller,
  spacesKeyA,
  spacesKeyB,
  spacesOutpoint,
  spacesRoot,
} from "./spaces-sale-namespace.pg-fixture.ts";
import { makeControlPlaneSpacesSaleNamespaceStore } from "./spaces-sale-namespace-repository.ts";
import { makeControlPlaneSpacesTaprootIntentStore } from "./spaces-taproot-intent-repository.ts";
import { makeControlPlaneSpacesTaprootPreparationStore } from "./spaces-taproot-preparation-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_SPACES_SALE_NAMESPACE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-spaces-sale-namespace-suite-complete";
const testCount = 15;
let completed = 0;

const communityId = "community_00000000-0000-4000-8000-00000000a001";
const seller = "spaces-seller";
const delegation = "bcrt1pspacesdelegationaddress01";
const sourceHash = "19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75";
const policyHash = "f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482";
const freshness = { observation_max_age_ms: 3_600_000, anchor_max_age_ms: 86_400_000 };

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_sale_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("SET session_replication_role = origin");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

const spaces = (connection: string): SpacesSaleNamespaceStore =>
  makeControlPlaneSpacesSaleNamespaceStore(makeDirectPostgresControlPlaneLayer(connection));
const taproot = (connection: string) =>
  makeControlPlaneSpacesTaprootPreparationStore(makeDirectPostgresControlPlaneLayer(connection));

const regtestAddress = (programHex: string) =>
  bech32m.encode("bcrt", [1, ...bech32m.toWords(Buffer.from(programHex, "hex"))], 90);

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E | undefined> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

const sqlState = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const insertRow = (admin: Client, table: string, row: Readonly<Record<string, unknown>>) => {
  const columns = Object.keys(row);
  return admin.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
    Object.values(row),
  );
};

const observation = (
  overrides: Partial<Parameters<SpacesSaleNamespaceStore["recordRootObservation"]>[0]> = {},
  root: Partial<{
    key: string;
    anchorCoversRootOutpoint: boolean;
    anchoredAt: string;
    publication: "verified" | "failed";
    delegationAddress: string | null;
  }> = {},
): Parameters<SpacesSaleNamespaceStore["recordRootObservation"]>[0] => ({
  canonicalRoot: spacesRoot,
  observerReference: "independent-node-1",
  observedAt: new Date(Date.now() - 1_000).toISOString(),
  root: {
    kind: "resolved",
    outpoint: spacesOutpoint,
    key: spacesKeyA,
    anchoredAt: new Date(Date.now() - 60_000).toISOString(),
    anchorCoversRootOutpoint: true,
    publication: "verified",
    delegationAddress: delegation,
    ...root,
  },
  commitmentHistory: { kind: "verified", commitmentCount: 0, latestCommitmentRootHex: null },
  freshness,
  ...overrides,
});

const capability = (assignmentId: string, generation: number) => ({
  operatorAssignmentId: assignmentId,
  operatorAssignmentGeneration: generation,
  observedAt: new Date(Date.now() - 1_000).toISOString(),
  capability: "observed" as const,
  observationMaxAgeMs: 3_600_000,
});

const command = (
  overrides: Partial<Parameters<SpacesSaleNamespaceStore["createSaleNamespace"]>[0]> = {},
) => ({
  accountId: seller,
  communityId,
  idempotencyKey: "spaces-create-1",
  namespaceAuthorityReference: "namespace_authority_spaces_01",
  expectedNamespaceAuthorityGeneration: 1,
  operatorAssignmentId: "spaces_operator_assignment_01",
  expectedOperatorAssignmentGeneration: 1,
  operatorFundingTermsConfirmed: true as const,
  activationId: "sale_namespace_activation_spaces_01",
  actionId: "spaces-create-action-1",
  ...overrides,
});

/** Network, seller, evidence, assignment, observations, and optionally the root enablement. */
async function seedReadySpace(
  admin: Client,
  connection: string,
  options: Readonly<{ enable: boolean }>,
) {
  await configureSpacesNetwork(admin);
  await seedSpacesSeller(admin, { communityId, sellerId: seller });
  await recordSpacesAuthorityEvidence(admin, {
    reference: "namespace_authority_spaces_01",
    generation: 1,
    communityId,
    controllingAccountId: seller,
  });
  await seedSpacesOperatorAssignment(admin, {
    assignmentId: "spaces_operator_assignment_01",
    generation: 1,
    delegationAddress: delegation,
  });
  await Effect.runPromise(spaces(connection).recordRootObservation(observation()));
  await Effect.runPromise(
    spaces(connection).recordOperatorCapabilityObservation(
      capability("spaces_operator_assignment_01", 1),
    ),
  );
  if (options.enable) await enableSpacesDriverForRoot(admin, { enablementId: "enable-charizard" });
}

async function createActive(admin: Client, connection: string) {
  await seedReadySpace(admin, connection, { enable: true });
  const created = await Effect.runPromise(spaces(connection).createSaleNamespace(command()));
  expect(created.activation.status).toBe("active");
  return created.activation;
}

const currentGeneration = async (admin: Client, activationId: string) =>
  Number(
    (
      await admin.query(
        `SELECT current_generation FROM community_handle_sale_namespace_activation_current
          WHERE sale_namespace_activation_id=$1`,
        [activationId],
      )
    ).rows[0]?.current_generation,
  );

const effectiveCount = async (admin: Client, activationId: string) =>
  Number(
    (
      await admin.query(
        `SELECT count(*)::int AS count
           FROM effective_community_handle_sale_namespace_v1($1, clock_timestamp())`,
        [activationId],
      )
    ).rows[0]?.count,
  );

const hnsActivationRow = {
  sale_namespace_activation_id: "hns-shape",
  sale_namespace_activation_generation: 1,
  sale_namespace_activation_hash: "1".repeat(64),
  community_id: communityId,
  family: "hns",
  canonical_root: "charizard",
  display_root: "charizard",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "namespace-evidence-test",
  namespace_authority_generation: 1,
  serving_kind: "hns_dns_zone_activation_v1",
  dns_zone_activation_id: "dns-zone-test",
  dns_zone_activation_generation: 1,
  root_replacement_kind: "dedicated_root_replace_v1",
  dedicated_root_replacement_confirmed: true,
  status: "pending",
  actor_account_id: seller,
  authority_grant_id: "grant",
  created_at: "2026-09-23T00:00:00.000Z",
} as const;

const spacesActivationRow = {
  sale_namespace_activation_id: "spaces-shape",
  sale_namespace_activation_generation: 1,
  sale_namespace_activation_hash: "2".repeat(64),
  community_id: communityId,
  family: "spaces",
  canonical_root: "charizard",
  display_root: "charizard",
  namespace_authority_kind: "verified_namespace_v1",
  spaces_network: "regtest",
  spaces_namespace_authority_reference: "namespace_authority_spaces_01",
  spaces_namespace_authority_generation: 1,
  spaces_operator_assignment_kind: "spaces_operator_assignment_v1",
  spaces_operator_assignment_id: "spaces_operator_assignment_01",
  spaces_operator_assignment_generation: 1,
  spaces_operator_funding_terms_kind: "spaces_operator_funding_confirm_v1",
  spaces_operator_funding_terms_confirmed: true,
  status: "pending",
  actor_account_id: seller,
  authority_grant_id: "grant",
  created_at: "2026-09-23T00:00:00.000Z",
} as const;

suite("Spaces sale-namespace activation and Taproot storage", () => {
  test("seeds the members-only policy, its source, Spaces reserved labels, and a disabled driver", async () => {
    await withSchema(async (admin) => {
      const source = await admin.query("SELECT * FROM handle_spaces_membership_source_revisions");
      expect(source.rows).toEqual([
        expect.objectContaining({
          source_revision: "1",
          source_id: "spec-016-active-membership-v1",
          source_hash: handleSpacesMembershipSourceHash({ source_revision: 1 }).sha256,
        }),
      ]);
      expect(source.rows[0]?.source_hash).toBe(sourceHash);
      const policy = await admin.query(
        `SELECT * FROM handle_qualification_policy_revisions WHERE policy_kind='spaces_membership_v1'`,
      );
      expect(policy.rows).toHaveLength(1);
      const row = policy.rows[0];
      expect(row).toMatchObject({
        policy_id: "qualification_policy_spaces_members_01",
        community_id: null,
        requirement_id: "requirement_spaces_membership_01",
        requirement_kind: "community_membership_v1",
        provider_binding_kind: "membership_source_v1",
        provider_binding_version: "1",
        provider_binding_hash: sourceHash,
        created_by_account_id: null,
        status: "active",
      });
      expect(row?.policy_hash).toBe(
        handleSpacesMembershipPolicyHash({
          policy_id: "qualification_policy_spaces_members_01",
          policy_revision: 1,
          requirement_id: "requirement_spaces_membership_01",
          requirement_revision: 1,
          source_revision: 1,
          source_hash: sourceHash,
        }).sha256,
      );
      expect(
        compileSpacesMembershipQualificationV1(
          {
            policy_id: "qualification_policy_spaces_members_01",
            policy_revision: 1,
            requirement_id: "requirement_spaces_membership_01",
            requirement_revision: 1,
            source_revision: 1,
          },
          1,
        ),
      ).toEqual({
        kind: "curated_policy_v1",
        policy_id: "qualification_policy_spaces_members_01",
        policy_revision: 1,
        policy_hash: policyHash,
        provider_binding_hash: sourceHash,
      });
      // A policy whose hash is outside the Spaces membership domain is refused.
      expect(
        await sqlState(
          admin.query(`INSERT INTO handle_qualification_policy_revisions
            (policy_id,policy_revision,policy_kind,request_hash,policy_hash,requirement_id,requirement_revision,
             requirement_kind,provider_binding_kind,provider_binding_version,provider_binding_hash,status,created_at)
            VALUES ('qualification_policy_spaces_members_01',2,'spaces_membership_v1',repeat('a',64),repeat('a',64),
             'requirement_spaces_membership_01',1,'community_membership_v1','membership_source_v1','1',
             '${sourceHash}','active',clock_timestamp())`),
        ),
      ).toBe("23514");
      const reserved = await admin.query(
        `SELECT reserved_labels_id,family,platform_labels,namespace_labels,reserved_labels_hash
           FROM handle_reserved_label_revisions ORDER BY family`,
      );
      expect(reserved.rows.map((entry) => [entry.reserved_labels_id, entry.family])).toEqual([
        ["reserved_labels_01", "hns"],
        ["reserved_labels_spaces_01", "spaces"],
      ]);
      expect(reserved.rows[1]?.platform_labels).toEqual(reserved.rows[0]?.platform_labels);
      expect(reserved.rows[1]?.namespace_labels).toEqual([]);
      expect(reserved.rows[1]?.reserved_labels_hash).toMatch(/^[0-9a-f]{64}$/u);
      const drivers = await admin.query(
        `SELECT family,driver_id,driver_version,fulfillment_kind,status
           FROM handle_issuance_driver_revisions ORDER BY family`,
      );
      expect(drivers.rows).toEqual([
        {
          family: "hns",
          driver_id: "hosted_persona-local",
          driver_version: "1",
          fulfillment_kind: "hosted_persona_v1",
          status: "enabled",
        },
        {
          family: "spaces",
          driver_id: "spaces_native-local",
          driver_version: "1",
          fulfillment_kind: "spaces_native_v1",
          status: "disabled",
        },
      ]);
      for (const table of [
        "spaces_network_configuration",
        "spaces_issuance_driver_root_enablements",
        "spaces_namespace_authority_evidence",
        "spaces_operator_assignment_revisions",
      ]) {
        expect(
          (await admin.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
        ).toBe(0);
      }
      expect(
        await sqlState(
          admin.query(
            "INSERT INTO handle_issuance_driver_revisions VALUES ('hns','mixed','1','spaces_native_v1','disabled')",
          ),
        ),
      ).toBe("23514");
    });
    completed++;
  });

  test("admits exactly the two checked activation shapes and keeps every HNS predicate", async () => {
    await withSchema(async (admin) => {
      await admin.query("INSERT INTO users (user_id,status) VALUES ($1,'active')", [seller]);
      await admin.query(
        `INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at,route_slug,route_authority_version)
        VALUES ($1,'Shapes','active',$2,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
        [communityId, seller],
      );
      // Replica mode skips triggers and foreign keys, so only the checks judge each shape.
      await admin.query("SET session_replication_role = replica");
      const table = "community_handle_sale_namespace_activation_revisions";
      const rejected = async (row: Readonly<Record<string, unknown>>) =>
        sqlState(insertRow(admin, table, row));
      expect(await rejected(hnsActivationRow)).toBeUndefined();
      expect(await rejected(spacesActivationRow)).toBeUndefined();
      const hnsMutations: readonly Readonly<Record<string, unknown>>[] = [
        { family: "spaces" },
        { family: "other" },
        { serving_kind: null },
        { serving_kind: "spaces_operator_assignment_v1" },
        { root_replacement_kind: null },
        { root_replacement_kind: "other_replace_v1" },
        { dedicated_root_replacement_confirmed: false },
        { dedicated_root_replacement_confirmed: null },
        { sale_namespace_activation_hash: "not-a-hash" },
        { sale_namespace_activation_generation: 0 },
        { canonical_root: "pirate", display_root: "pirate" },
        { canonical_root: "Charizard" },
        { canonical_root: "localhost", display_root: "localhost" },
        { display_root: "chari.zard" },
        { namespace_authority_reference: null },
        { namespace_authority_generation: null },
        { namespace_authority_generation: 0 },
        { dns_zone_activation_id: null },
        { dns_zone_activation_id: " padded" },
        { dns_zone_activation_generation: null },
        { dns_zone_activation_generation: 0 },
        { spaces_network: "regtest" },
        { spaces_namespace_authority_reference: "namespace_authority_spaces_01" },
        { spaces_namespace_authority_generation: 1 },
        { spaces_operator_assignment_kind: "spaces_operator_assignment_v1" },
        { spaces_operator_assignment_id: "spaces_operator_assignment_01" },
        { spaces_operator_assignment_generation: 1 },
        { spaces_operator_funding_terms_kind: "spaces_operator_funding_confirm_v1" },
        { spaces_operator_funding_terms_confirmed: true },
      ];
      for (const [index, mutation] of hnsMutations.entries()) {
        expect(
          await rejected({
            ...hnsActivationRow,
            ...mutation,
            sale_namespace_activation_id: `hns-${index}`,
          }),
          JSON.stringify(mutation),
        ).toBe("23514");
      }
      const spacesMutations: readonly Readonly<Record<string, unknown>>[] = [
        { family: "hns" },
        { namespace_authority_reference: "namespace-evidence-test" },
        { namespace_authority_generation: 1 },
        { serving_kind: "hns_dns_zone_activation_v1" },
        { dns_zone_activation_id: "dns-zone-test" },
        { dns_zone_activation_generation: 1 },
        { root_replacement_kind: "dedicated_root_replace_v1" },
        { dedicated_root_replacement_confirmed: true },
        { spaces_network: null },
        { spaces_network: "signet" },
        { spaces_namespace_authority_reference: null },
        { spaces_namespace_authority_generation: 0 },
        { spaces_operator_assignment_kind: null },
        { spaces_operator_assignment_id: null },
        { spaces_operator_assignment_generation: null },
        { spaces_operator_funding_terms_kind: "funding_placeholder" },
        { spaces_operator_funding_terms_confirmed: false },
        { spaces_operator_funding_terms_confirmed: null },
        { canonical_root: "Charizard" },
        { canonical_root: "pirate", display_root: "pirate" },
        { canonical_root: "char--izard" },
      ];
      for (const [index, mutation] of spacesMutations.entries()) {
        expect(
          await rejected({
            ...spacesActivationRow,
            ...mutation,
            sale_namespace_activation_id: `spaces-${index}`,
          }),
          JSON.stringify(mutation),
        ).toBe("23514");
      }
      const current = "community_handle_sale_namespace_activation_current";
      const currentRow = {
        sale_namespace_activation_id: "spaces-shape",
        family: "spaces",
        canonical_root: "charizard",
        community_id: communityId,
        current_generation: 1,
        updated_at: "2026-09-23T00:00:00.000Z",
      };
      expect(await sqlState(insertRow(admin, current, currentRow))).toBeUndefined();
      expect(
        await sqlState(
          insertRow(admin, current, {
            ...currentRow,
            sale_namespace_activation_id: "hns-shape",
            family: "hns",
          }),
        ),
      ).toBeUndefined();
      expect(
        await sqlState(
          insertRow(admin, current, {
            ...currentRow,
            sale_namespace_activation_id: "other-shape",
            family: "other",
            canonical_root: "other",
          }),
        ),
      ).toBe("23514");
      await admin.query("SET session_replication_role = origin");
    });
    completed++;
  });

  test("derives readiness in the ratified order and fails closed while the driver is disabled", async () => {
    await withSchema(async (admin, connection) => {
      const store = spaces(connection);
      const readiness = () =>
        Effect.runPromise(
          store.readCandidateReadiness({
            accountId: seller,
            communityId,
            canonicalRoot: spacesRoot,
          }),
        );
      await configureSpacesNetwork(admin);
      await seedSpacesSeller(admin, { communityId, sellerId: seller });
      expect(await readiness()).toBeNull();
      await recordSpacesAuthorityEvidence(admin, {
        reference: "namespace_authority_spaces_01",
        generation: 1,
        communityId,
        controllingAccountId: seller,
      });
      expect((await readiness())?.readiness).toEqual({
        kind: "not_ready_v1",
        reason: "anchor_pending",
      });
      await Effect.runPromise(
        store.recordRootObservation(observation({ commitmentHistory: { kind: "unverified" } }, {})),
      );
      expect((await readiness())?.readiness).toEqual({
        kind: "not_ready_v1",
        reason: "delegation_required",
      });
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: "spaces_operator_assignment_01",
        generation: 1,
        delegationAddress: delegation,
      });
      expect((await readiness())?.readiness).toEqual({
        kind: "not_ready_v1",
        reason: "operator_capability_unverified",
      });
      await Effect.runPromise(
        store.recordOperatorCapabilityObservation(capability("spaces_operator_assignment_01", 1)),
      );
      expect((await readiness())?.readiness).toEqual({
        kind: "not_ready_v1",
        reason: "commitment_history_unverified",
      });
      await Effect.runPromise(store.recordRootObservation(observation()));
      const disabled = await readiness();
      expect(disabled?.readiness).toEqual({ kind: "not_ready_v1", reason: "driver_disabled" });
      expect(disabled?.facts).toEqual({
        namespace_authority_current: true,
        owner_challenge_current: true,
        anchor_covers_root_outpoint: true,
        publication_verified: true,
        delegation_observed: true,
        operator_capability_observed: true,
        commitment_history_verified: true,
        driver_enabled: false,
      });
      expect(await failureOf(store.createSaleNamespace(command()))).toEqual(
        new SpacesSaleNamespaceNotReady({ reason: "driver_disabled" }),
      );
      const directCreatedAt = new Date(Date.now() - 1_000).toISOString();
      await expect(
        insertRow(admin, "community_handle_sale_namespace_activation_revisions", {
          ...spacesActivationRow,
          status: "active",
          activated_at: directCreatedAt,
          authority_grant_id: (
            await admin.query("SELECT grant_id FROM community_handle_sales_authority_grants")
          ).rows[0]?.grant_id,
          created_at: directCreatedAt,
        }),
      ).rejects.toThrow("driver_disabled");
      // A retired driver revision or a disabled enablement never counts.
      await enableSpacesDriverForRoot(admin, { enablementId: "enable-charizard" });
      expect((await readiness())?.readiness).toEqual({ kind: "ready_v1" });
      await admin.query(
        `UPDATE spaces_issuance_driver_root_enablements
            SET status='disabled',disabled_at=clock_timestamp() WHERE enablement_id='enable-charizard'`,
      );
      expect((await readiness())?.readiness).toEqual({
        kind: "not_ready_v1",
        reason: "driver_disabled",
      });
      await expect(
        admin.query(
          "UPDATE spaces_issuance_driver_root_enablements SET status='enabled',disabled_at=NULL",
        ),
      ).rejects.toThrow();
      await enableSpacesDriverForRoot(admin, { enablementId: "enable-charizard-2" });
      const created = await Effect.runPromise(store.createSaleNamespace(command()));
      expect(created).toMatchObject({
        replayed: false,
        activation: {
          family: "spaces",
          network: "regtest",
          canonical_root: spacesRoot,
          status: "active",
          namespace_authority: {
            kind: "verified_namespace_v1",
            namespace_authority_reference: "namespace_authority_spaces_01",
            namespace_authority_generation: 1,
          },
          operator: {
            kind: "spaces_operator_assignment_v1",
            operator_assignment_id: "spaces_operator_assignment_01",
            operator_assignment_generation: 1,
          },
          operator_funding_terms: { kind: "spaces_operator_funding_confirm_v1", confirmed: true },
        },
      });
      expect(created.activation.sale_namespace_activation_hash).toBe(
        handleSpacesSaleNamespaceActivationHash({
          sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
          sale_namespace_activation_generation: 1,
          community_id: communityId,
          network: "regtest",
          canonical_root: spacesRoot,
          namespace_authority_reference: "namespace_authority_spaces_01",
          namespace_authority_generation: 1,
          operator_assignment_id: "spaces_operator_assignment_01",
          operator_assignment_generation: 1,
          operator_funding_terms_confirmed: true,
        }).sha256,
      );
      expect(JSON.stringify(created)).not.toContain(delegation);
      expect(
        await Effect.runPromise(
          store.createSaleNamespace(command({ activationId: "unused", actionId: "unused" })),
        ),
      ).toEqual({ ...created, replayed: true });
      expect(
        await failureOf(
          store.createSaleNamespace(
            command({ expectedOperatorAssignmentGeneration: 2, actionId: "changed" }),
          ),
        ),
      ).toEqual(new HandleSalesRejected({ reason: "idempotency_conflict", retryable: false }));
      expect(await effectiveCount(admin, "sale_namespace_activation_spaces_01")).toBe(1);
      const item = await Effect.runPromise(
        store.getSaleNamespaceReadiness({
          accountId: seller,
          communityId,
          activationId: "sale_namespace_activation_spaces_01",
        }),
      );
      expect(item?.readiness).toEqual({ kind: "ready_v1" });
      expect(
        await Effect.runPromise(
          store.getSaleNamespaceReadiness({
            accountId: "stranger",
            communityId,
            activationId: "sale_namespace_activation_spaces_01",
          }),
        ),
      ).toBeNull();
      // The HNS offering mutation refuses a Spaces activation before any write.
      const sales = makeControlPlaneHandleSalesStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      expect(
        await failureOf(
          sales.createOffering({
            accountId: seller,
            communityId,
            idempotencyKey: "hns-offering-on-spaces",
            offeringId: "hns-offering-on-spaces",
            actionId: "hns-offering-on-spaces",
            terms: terms("sale_namespace_activation_spaces_01"),
          }),
        ),
      ).toEqual(new HandleSalesRejected({ reason: "offering_unavailable", retryable: false }));
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM community_handle_offering_revisions",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    completed++;
  });

  test("keeps anchor lag retryable and suspends only when a fresh observation confirms loss", async () => {
    await withSchema(async (admin, connection) => {
      const store = spaces(connection);
      const activation = await createActive(admin, connection);
      const id = activation.sale_namespace_activation_id;
      const lag = await Effect.runPromise(
        store.recordRootObservation(observation({}, { anchorCoversRootOutpoint: false })),
      );
      expect(lag).toMatchObject({
        kind: "recorded",
        drift: { kind: "anchor_lag" },
        suspended: null,
      });
      expect(await currentGeneration(admin, id)).toBe(1);
      expect(await effectiveCount(admin, id)).toBe(0);
      expect(
        (
          await Effect.runPromise(
            store.getSaleNamespaceReadiness({ accountId: seller, communityId, activationId: id }),
          )
        )?.readiness,
      ).toEqual({ kind: "not_ready_v1", reason: "anchor_pending" });
      // A degraded observer is indeterminate: it blocks commerce but never suspends.
      const degraded = await Effect.runPromise(
        store.recordRootObservation(
          observation({ freshness: { ...freshness, observation_max_age_ms: 1 } }, {}),
        ),
      );
      expect(degraded).toMatchObject({ drift: { kind: "indeterminate" }, suspended: null });
      expect(await currentGeneration(admin, id)).toBe(1);
      expect(
        await Effect.runPromise(
          store.recordRootObservation(
            observation({ observedAt: new Date(Date.now() - 3_600_000).toISOString() }),
          ),
        ),
      ).toEqual({ kind: "stale" });
      const current = await Effect.runPromise(store.recordRootObservation(observation()));
      expect(current).toMatchObject({ drift: { kind: "current" }, suspended: null });
      expect(await effectiveCount(admin, id)).toBe(1);
      const stale = await Effect.runPromise(
        store.recordRootObservation(
          observation({}, { anchoredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
        ),
      );
      expect(stale).toMatchObject({
        kind: "recorded",
        drift: { kind: "authority_lost", reason: "anchor_stale" },
        suspended: {
          sale_namespace_activation_generation: 2,
          status: "suspended",
        },
      });
      expect(await currentGeneration(admin, id)).toBe(2);
      expect(await effectiveCount(admin, id)).toBe(0);
      const reason = await admin.query(
        `SELECT reason_code FROM community_handle_sale_namespace_activation_revisions
          WHERE sale_namespace_activation_id=$1 AND sale_namespace_activation_generation=2`,
        [id],
      );
      expect(reason.rows[0]?.reason_code).toBe("anchor_stale");
      // Restoration needs fresh authority and assignment generations.
      await Effect.runPromise(store.recordRootObservation(observation()));
      const restore = (overrides: Record<string, unknown>) =>
        store.reviseSaleNamespace({
          ...command(),
          idempotencyKey: `restore-${JSON.stringify(overrides)}`,
          actionId: `restore-${JSON.stringify(overrides)}`,
          expectedActivationHash: (
            stale as { suspended: { sale_namespace_activation_hash: string } }
          ).suspended.sale_namespace_activation_hash,
          requestedStatus: "active",
          ...overrides,
        });
      expect(await failureOf(restore({}))).toEqual(
        new HandleSalesRejected({ reason: "sale_namespace_inactive", retryable: true }),
      );
      await recordSpacesAuthorityEvidence(admin, {
        reference: "namespace_authority_spaces_01",
        generation: 2,
        communityId,
        controllingAccountId: seller,
      });
      expect(await failureOf(restore({ expectedNamespaceAuthorityGeneration: 2 }))).toEqual(
        new HandleSalesRejected({ reason: "sale_namespace_inactive", retryable: true }),
      );
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: "spaces_operator_assignment_01",
        generation: 2,
        delegationAddress: delegation,
      });
      expect(
        await failureOf(
          restore({
            expectedNamespaceAuthorityGeneration: 2,
            expectedOperatorAssignmentGeneration: 2,
          }),
        ),
      ).toEqual(new SpacesSaleNamespaceNotReady({ reason: "operator_capability_unverified" }));
      await Effect.runPromise(
        store.recordOperatorCapabilityObservation(capability("spaces_operator_assignment_01", 2)),
      );
      const restored = await Effect.runPromise(
        restore({
          expectedNamespaceAuthorityGeneration: 2,
          expectedOperatorAssignmentGeneration: 2,
        }),
      );
      expect(restored.activation).toMatchObject({
        sale_namespace_activation_generation: 3,
        status: "active",
        activated_at: activation.activated_at,
      });
      expect(await effectiveCount(admin, id)).toBe(1);
      // An unresolved root is authority loss as well.
      const unresolved = await Effect.runPromise(
        store.recordRootObservation({
          ...observation(),
          root: { kind: "unresolved" },
          commitmentHistory: { kind: "unverified" },
        }),
      );
      expect(unresolved).toMatchObject({
        drift: { kind: "authority_lost", reason: "authority_unresolved" },
        suspended: { sale_namespace_activation_generation: 4, status: "suspended" },
      });
    });
    completed++;
  });

  test("requires a fresh owner challenge by the same controlling account after a key change", async () => {
    await withSchema(async (admin, connection) => {
      const store = spaces(connection);
      const activation = await createActive(admin, connection);
      const id = activation.sale_namespace_activation_id;
      const changed = await Effect.runPromise(
        store.recordRootObservation(observation({}, { key: spacesKeyB })),
      );
      expect(changed).toMatchObject({
        drift: { kind: "key_changed", observed_root_key: spacesKeyB },
        suspended: null,
      });
      expect(await currentGeneration(admin, id)).toBe(1);
      expect(await effectiveCount(admin, id)).toBe(0);
      expect(
        (
          await Effect.runPromise(
            store.getSaleNamespaceReadiness({ accountId: seller, communityId, activationId: id }),
          )
        )?.readiness,
      ).toEqual({ kind: "not_ready_v1", reason: "owner_challenge_required" });
      const refresh = (accountId: string, generation: number, key: string) =>
        store.reviseSaleNamespace({
          ...command(),
          accountId,
          idempotencyKey: key,
          actionId: key,
          expectedNamespaceAuthorityGeneration: generation,
          expectedActivationHash: activation.sale_namespace_activation_hash,
          requestedStatus: "active",
        });
      // The root now answers to another Pirate account with its own sales authority.
      await admin.query("INSERT INTO users (user_id,status) VALUES ('intruder','active')");
      await grantSpacesSalesAuthority(admin, { communityId, sellerId: "intruder" });
      await recordSpacesAuthorityEvidence(admin, {
        reference: "namespace_authority_spaces_01",
        generation: 2,
        communityId,
        controllingAccountId: "intruder",
        rootKeyHex: spacesKeyB,
        keyChangedSecondsAgo: 60,
      });
      expect(await failureOf(refresh(seller, 2, "seller-refresh-2"))).toEqual(
        new HandleSalesRejected({ reason: "offering_unavailable", retryable: false }),
      );
      expect(await failureOf(refresh("intruder", 2, "intruder-refresh-2"))).toEqual(
        new HandleSalesRejected({ reason: "offering_unavailable", retryable: false }),
      );
      const intruderGrant = (
        await admin.query(
          "SELECT grant_id FROM community_handle_sales_authority_grants WHERE principal_account_id='intruder'",
        )
      ).rows[0]?.grant_id;
      await expect(
        insertRow(admin, "community_handle_sale_namespace_activation_revisions", {
          ...spacesActivationRow,
          sale_namespace_activation_id: id,
          sale_namespace_activation_generation: 2,
          spaces_namespace_authority_generation: 2,
          status: "active",
          actor_account_id: "intruder",
          authority_grant_id: intruderGrant,
          created_at: activation.created_at,
          activated_at: activation.activated_at,
        }),
      ).rejects.toThrow("never transfers");
      // A fresh challenge by the original controlling account under the new key.
      await recordSpacesAuthorityEvidence(admin, {
        reference: "namespace_authority_spaces_01",
        generation: 3,
        communityId,
        controllingAccountId: seller,
        rootKeyHex: spacesKeyB,
        keyChangedSecondsAgo: 30,
      });
      const refreshed = await Effect.runPromise(refresh(seller, 3, "seller-refresh-3"));
      expect(refreshed.activation).toMatchObject({
        sale_namespace_activation_generation: 2,
        status: "active",
        namespace_authority: { namespace_authority_generation: 3 },
        activated_at: activation.activated_at,
      });
      expect(await effectiveCount(admin, id)).toBe(1);
      expect(await failureOf(refresh(seller, 3, "seller-refresh-3-again"))).toEqual(
        new HandleSalesRejected({ reason: "sale_namespace_inactive", retryable: true }),
      );
      // A stale generation can never reactivate commerce.
      await expect(
        admin.query(`UPDATE community_handle_sale_namespace_activation_revisions
          SET status='suspended' WHERE sale_namespace_activation_id='${id}'`),
      ).rejects.toThrow("append-only");
    });
    completed++;
  });

  test("keeps one Spaces network per database", async () => {
    await withSchema(async (admin) => {
      await configureSpacesNetwork(admin, "regtest");
      expect(await sqlState(configureSpacesNetwork(admin, "mainnet"))).toBe("23505");
      expect(
        await sqlState(
          admin.query("INSERT INTO spaces_network_configuration VALUES ('another_key','mainnet')"),
        ),
      ).toBe("23514");
      await expect(
        admin.query("UPDATE spaces_network_configuration SET network='mainnet'"),
      ).rejects.toThrow("append-only");
      await expect(admin.query("DELETE FROM spaces_network_configuration")).rejects.toThrow(
        "append-only",
      );
      await seedSpacesSeller(admin, { communityId, sellerId: seller });
      expect(
        await sqlState(
          recordSpacesAuthorityEvidence(admin, {
            reference: "mainnet-evidence",
            generation: 1,
            communityId,
            controllingAccountId: seller,
            network: "mainnet",
          }),
        ),
      ).toBe("23503");
      expect(
        await sqlState(enableSpacesDriverForRoot(admin, { enablementId: "m", network: "mainnet" })),
      ).toBe("23503");
      expect(
        await sqlState(
          admin.query(
            "INSERT INTO spaces_operator_instances VALUES ('mainnet-instance','mainnet','active',clock_timestamp(),NULL)",
          ),
        ),
      ).toBe("23503");
      const personaId = await seedAccount(admin, "taproot-mainnet", { humanEvidence: false });
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO persona_wallet_assignments (
               assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
               reservation_idempotency_key,bitcoin_network
             ) VALUES ('taproot-mainnet',$1,'taproot-mainnet','bitcoin-taproot',NULL,'pending','t','mainnet')`,
            [personaId],
          ),
        ),
      ).toBe("23503");
      // One evidence reference continues per root, and one wallet serves one space.
      await recordSpacesAuthorityEvidence(admin, {
        reference: "namespace_authority_spaces_01",
        generation: 1,
        communityId,
        controllingAccountId: seller,
      });
      await expect(
        recordSpacesAuthorityEvidence(admin, {
          reference: "namespace_authority_other",
          generation: 1,
          communityId,
          controllingAccountId: seller,
        }),
      ).rejects.toThrow("one evidence reference per root");
      await expect(
        recordSpacesAuthorityEvidence(admin, {
          reference: "namespace_authority_spaces_01",
          generation: 3,
          communityId,
          controllingAccountId: seller,
        }),
      ).rejects.toThrow("generation or identity");
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: "assignment-a",
        generation: 1,
        delegationAddress: "bcrt1pwalletaaaa",
        walletReference: "wallet-shared",
      });
      await expect(
        seedSpacesOperatorAssignment(admin, {
          assignmentId: "assignment-b",
          generation: 1,
          delegationAddress: "bcrt1pwalletbbbb",
          walletReference: "wallet-shared",
          root: "blastoise",
        }),
      ).rejects.toThrow("exactly one space");
      await expect(
        seedSpacesOperatorAssignment(admin, {
          assignmentId: "assignment-c",
          generation: 1,
          delegationAddress: "bcrt1pwalletcccc",
        }),
      ).rejects.toThrow();
    });
    completed++;
  });

  test("compiles only the members-only free first-come Spaces offering", async () => {
    await withSchema(async (admin, connection) => {
      const activation = await createActive(admin, connection);
      const reserved = (
        await admin.query(
          "SELECT reserved_labels_hash FROM handle_reserved_label_revisions WHERE reserved_labels_id='reserved_labels_spaces_01'",
        )
      ).rows[0]?.reserved_labels_hash;
      const pricing = (await admin.query("SELECT pricing_hash FROM handle_pricing_revisions"))
        .rows[0]?.pricing_hash;
      const base = {
        offering_id: "offering_spaces_free_01",
        offering_revision: 1,
        offering_hash: "6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",
        community_id: communityId,
        family: "spaces",
        namespace_root: spacesRoot,
        display_root: spacesRoot,
        sale_namespace_activation_id: activation.sale_namespace_activation_id,
        sale_namespace_activation_generation: 1,
        label_scope_kind: "label_rule_v2",
        label_grammar_id: "spaces_subspace_label_v1",
        exact_label: null,
        min_label_length: 8,
        max_label_length: 32,
        reserved_labels_id: "reserved_labels_spaces_01",
        reserved_labels_revision: 1,
        reserved_labels_hash: reserved,
        allocation_kind: "first_come_v1",
        max_active_grants_per_account: 1,
        fulfillment_kind: "spaces_native_v1",
        qualification_policy_id: "qualification_policy_spaces_members_01",
        qualification_policy_revision: 1,
        qualification_policy_hash: policyHash,
        provider_binding_hash: sourceHash,
        pricing_id: "platform_free_handles_v1",
        pricing_revision: 1,
        pricing_hash: pricing,
        atomic_amount: 0,
        issuance_driver_id: "spaces_native-local",
        issuance_driver_version: "1",
        quote_ttl_seconds: 120,
        reservation_ttl_seconds: 300,
        status: "active",
        actor_account_id: seller,
        created_at: new Date(Date.now() - 1_000).toISOString(),
      };
      const offering = (id: string, overrides: Record<string, unknown>) =>
        insertRow(admin, "community_handle_offering_revisions", {
          ...base,
          offering_id: id,
          ...overrides,
        });
      const none = (
        await admin.query(
          "SELECT policy_hash FROM handle_qualification_policy_revisions WHERE policy_id='none_v1'",
        )
      ).rows[0]?.policy_hash;
      const authoring = makeControlPlaneHandleNationalityAuthoringStore(
        makeDirectPostgresControlPlaneLayer(connection),
        resolveNationalityAuthoring({
          enabled: true,
          policyRevision: 1,
          evidenceLifetimeSeconds: 31_536_000,
          environment: "test",
          selfPass: { callbackOrigin: "https://api.example.invalid", mockPassport: false },
          zkPassport: { domain: "api.example.invalid", devMode: false },
        }) as NationalityAuthoring,
      );
      const context = await Effect.runPromise(
        authoring.getContext({ accountId: seller, communityId }),
      );
      const nationality = await Effect.runPromise(
        authoring.createPolicy({
          accountId: seller,
          communityId,
          policyId: "spaces-nationality",
          actionId: "spaces-nationality",
          idempotencyKey: "spaces-nationality",
          authoringReference: context.authoring_reference,
          allowedCountries: ["US"],
        }),
      );
      const members = "require the members-only qualification policy";
      const shape = "admit only free first-come subspace labels";
      const refused: readonly [string, string, Record<string, unknown>][] = [
        [
          "none_v1",
          members,
          {
            qualification_policy_id: "none_v1",
            qualification_policy_hash: none,
            provider_binding_hash: null,
          },
        ],
        [
          "nationality",
          members,
          {
            qualification_policy_id: nationality.qualification_policy.policy_id,
            qualification_policy_revision: nationality.qualification_policy.policy_revision,
            qualification_policy_hash: nationality.qualification_policy.policy_hash,
            provider_binding_hash: null,
          },
        ],
        [
          "exact label",
          shape,
          {
            label_scope_kind: "exact_label_v2",
            exact_label: "charizardfan",
            min_label_length: null,
            max_label_length: null,
            allocation_kind: "direct_grant_v1",
            max_active_grants_per_account: null,
          },
        ],
        [
          "direct grant",
          shape,
          { allocation_kind: "direct_grant_v1", max_active_grants_per_account: null },
        ],
        [
          "mismatched source hash",
          "membership source hash does not match",
          { provider_binding_hash: "a".repeat(64) },
        ],
        ["mismatched policy hash", members, { qualification_policy_hash: "a".repeat(64) }],
        ["HNS grammar", shape, { label_grammar_id: "hns_ascii_ldh_1_63_v1" }],
        [
          "HNS reserved labels",
          "reserved-label reference is inconsistent",
          { reserved_labels_id: "reserved_labels_01" },
        ],
        ["hosted fulfillment", shape, { fulfillment_kind: "hosted_persona_v1" }],
        ["out of band", "community_handle_offering_label_scope_shape", { min_label_length: 4 }],
        ["paid", "pricing reference is inconsistent", { atomic_amount: 1 }],
      ];
      for (const [name, message, overrides] of refused) {
        await expect(offering(`refused-${name}`, overrides), name).rejects.toThrow(message);
      }
      await offering("offering_spaces_free_01", {});
      // A newer membership source makes the pinned revision stale.
      await admin.query(
        `INSERT INTO handle_spaces_membership_source_revisions (source_revision,source_id,source_hash)
         VALUES (2,'spec-016-active-membership-v1',$1)`,
        [handleSpacesMembershipSourceHash({ source_revision: 2 }).sha256],
      );
      await expect(offering("stale-source", {})).rejects.toThrow("stale membership source");
    });
    completed++;
  });

  test("refuses the members-only Spaces policy on an HNS offering", async () => {
    await withSchema(async (admin, connection) => {
      await admin.query("INSERT INTO users (user_id,status) VALUES ('seller','active')");
      const activationId = await seedSaleNamespace(
        admin,
        "seller",
        "community_00000000-0000-4000-8000-000000000001",
      );
      const sales = makeControlPlaneHandleSalesStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const input = {
        accountId: "seller",
        communityId: "community_00000000-0000-4000-8000-000000000001",
        idempotencyKey: "hns-members-only",
        offeringId: "hns-members-only",
        actionId: "hns-members-only",
      };
      expect(
        await failureOf(
          sales.createOffering({
            ...input,
            terms: {
              ...terms(activationId),
              qualification_policy_id: "qualification_policy_spaces_members_01",
              expected_qualification_policy_revision: 1,
            },
          }),
        ),
      ).toEqual(new HandleSalesRejected({ reason: "offering_unavailable", retryable: false }));
      const created = await Effect.runPromise(
        sales.createOffering({
          ...input,
          idempotencyKey: "hns-none",
          offeringId: "hns-none",
          actionId: "hns-none",
          terms: terms(activationId),
        }),
      );
      expect(created.offering.qualification_policy.kind).toBe("none_v1");
      await expect(
        admin.query(`INSERT INTO community_handle_offering_revisions (
            offering_id,offering_revision,offering_hash,community_id,family,namespace_root,
            display_root,sale_namespace_activation_id,sale_namespace_activation_generation,
            label_scope_kind,label_grammar_id,exact_label,min_label_length,max_label_length,
            reserved_labels_id,reserved_labels_revision,reserved_labels_hash,allocation_kind,
            max_active_grants_per_account,fulfillment_kind,qualification_policy_id,
            qualification_policy_revision,qualification_policy_hash,provider_binding_hash,
            pricing_id,pricing_revision,pricing_hash,atomic_amount,issuance_driver_id,
            issuance_driver_version,quote_ttl_seconds,reservation_ttl_seconds,status,
            actor_account_id,created_at,recorded_at
          )
          SELECT offering_id,2,offering_hash,community_id,family,namespace_root,display_root,
                 sale_namespace_activation_id,sale_namespace_activation_generation,label_scope_kind,
                 label_grammar_id,exact_label,min_label_length,max_label_length,reserved_labels_id,
                 reserved_labels_revision,reserved_labels_hash,allocation_kind,
                 max_active_grants_per_account,fulfillment_kind,
                 'qualification_policy_spaces_members_01',1,'${policyHash}','${sourceHash}',
                 pricing_id,pricing_revision,pricing_hash,atomic_amount,issuance_driver_id,
                 issuance_driver_version,quote_ttl_seconds,reservation_ttl_seconds,status,
                 actor_account_id,created_at,clock_timestamp()
            FROM community_handle_offering_revisions WHERE offering_id='hns-none'`),
      ).rejects.toThrow("does not admit this qualification policy");
    });
    completed++;
  });

  test("stores one live Taproot recipient per persona without advancing its public footprint", async () => {
    await withSchema(async (admin) => {
      await configureSpacesNetwork(admin);
      const account = "taproot-owner";
      const personaA = await seedAccount(admin, account, { humanEvidence: false });
      await createActivePersonaFixture(admin, {
        accountId: account,
        personaId: "persona-taproot-b",
      });
      const personaB = "persona-taproot-b";
      const footprint = async (personaId: string) =>
        (
          await admin.query(
            "SELECT public_linkage_generation FROM handle_persona_public_linkage_states WHERE persona_id=$1",
            [personaId],
          )
        ).rows[0]?.public_linkage_generation;
      const before = await footprint(personaA);
      const addressA = `bcrt1p${"q".repeat(58)}`;
      const scriptA = `5120${"1".repeat(64)}`;
      const pending = (assignmentId: string, personaId: string, network = "regtest") =>
        admin.query(
          `INSERT INTO persona_wallet_assignments (
             assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
             reservation_idempotency_key,bitcoin_network
           ) VALUES ($1,$2,$3,'bitcoin-taproot',NULL,'pending',$1,$4)`,
          [assignmentId, personaId, account, network],
        );
      const confirm = (assignmentId: string, address: string, script: string) =>
        admin.query(
          `UPDATE persona_wallet_assignments
              SET status='active',privy_wallet_id='privy-' || assignment_id,address=$2,
                  output_script_hex=$3,assigned_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE assignment_id=$1`,
          [assignmentId, address, script],
        );
      await pending("taproot-a", personaA);
      await confirm("taproot-a", addressA, scriptA);
      expect(await footprint(personaA)).toBe(before);
      expect(await sqlState(pending("taproot-a-2", personaA))).toBe("23505");
      await pending("taproot-b", personaB);
      expect(await sqlState(confirm("taproot-b", `bcrt1p${"p".repeat(58)}`, scriptA))).toBe(
        "23505",
      );
      expect(await sqlState(confirm("taproot-b", addressA, `5120${"2".repeat(64)}`))).toBe("23505");
      for (const [address, script] of [
        [`0x${"a".repeat(40)}`, `5120${"2".repeat(64)}`],
        [`bc1p${"p".repeat(58)}`, `5120${"2".repeat(64)}`],
        [`bcrt1p${"p".repeat(58)}`, `0014${"2".repeat(40)}`],
        [`bcrt1p${"b".repeat(58)}`, `5120${"2".repeat(64)}`],
      ] as const) {
        expect(await sqlState(confirm("taproot-b", address, script)), address).toBe("23514");
      }
      expect(
        await sqlState(
          admin.query(
            `UPDATE persona_wallet_assignments SET status='active',address=$1,
               assigned_at=clock_timestamp() WHERE assignment_id='taproot-b'`,
            [`bcrt1p${"p".repeat(58)}`],
          ),
        ),
      ).toBe("23514");
      // EVM rows keep every EVM check and carry no Taproot fields.
      expect(
        await sqlState(
          admin.query(
            `UPDATE persona_wallet_assignments SET bitcoin_network='regtest'
              WHERE persona_id=$1 AND chain_account_kind='evm'`,
            [personaA],
          ),
        ),
      ).toBeDefined();
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO persona_wallet_assignments (
               assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
               reservation_idempotency_key,tombstoned_at
             ) VALUES ('evm-null-index',$1,$2,'evm',NULL,'tombstoned','evm-null',clock_timestamp())`,
            [personaA, account],
          ),
        ),
      ).toBe("23514");
      // Confirmed Taproot authority is immutable; tombstones are never recycled.
      await expect(
        admin.query(
          "UPDATE persona_wallet_assignments SET output_script_hex=$1 WHERE assignment_id='taproot-a'",
          [`5120${"3".repeat(64)}`],
        ),
      ).rejects.toThrow("immutable");
      await admin.query(
        `UPDATE persona_wallet_assignments SET status='tombstoned',tombstoned_at=clock_timestamp(),
           updated_at=clock_timestamp() WHERE assignment_id='taproot-a'`,
      );
      expect(await footprint(personaA)).toBe(before);
      await expect(
        admin.query(
          `UPDATE persona_wallet_assignments SET status='active',tombstoned_at=NULL
            WHERE assignment_id='taproot-a'`,
        ),
      ).rejects.toThrow("immutable");
      await confirm("taproot-b", `bcrt1p${"p".repeat(58)}`, `5120${"2".repeat(64)}`);
      await pending("taproot-a-3", personaA);
      expect(await sqlState(confirm("taproot-a-3", addressA, `5120${"4".repeat(64)}`))).toBe(
        "23505",
      );
      expect(await sqlState(confirm("taproot-a-3", `bcrt1p${"z".repeat(58)}`, scriptA))).toBe(
        "23505",
      );
      await confirm("taproot-a-3", `bcrt1p${"z".repeat(58)}`, `5120${"4".repeat(64)}`);
      const evm = await admin.query(
        `SELECT persona_id,count(*)::int AS count FROM persona_wallet_assignments
          WHERE chain_account_kind='evm' AND status='active' GROUP BY persona_id ORDER BY persona_id`,
      );
      expect(evm.rows.map((row) => row.count)).toEqual([1, 1]);
      // A persona that is not active or suspended cannot hold a live Taproot recipient.
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO personas (persona_id,account_id,status,is_first_persona)
         VALUES ('persona-taproot-pending',$1,'pending_wallet',false)`,
        [account],
      );
      await admin.query(
        "INSERT INTO persona_pending_profiles (persona_id) VALUES ('persona-taproot-pending')",
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
           reservation_idempotency_key
         ) VALUES ('evm-pending','persona-taproot-pending',$1,'evm',99,'pending','evm-pending')`,
        [account],
      );
      await pending("taproot-pending", "persona-taproot-pending");
      expect(await sqlState(admin.query("COMMIT"))).toBe("23514");
    });
    completed++;
  });

  test("retirement tombstones the Taproot recipient beside the single EVM wallet", async () => {
    await withSchema(async (admin, connection) => {
      await configureSpacesNetwork(admin);
      const account = "taproot-retiree";
      await seedAccount(admin, account, { humanEvidence: false });
      await createActivePersonaFixture(admin, {
        accountId: account,
        personaId: "persona-retiring",
      });
      await createActivePersonaFixture(admin, {
        accountId: account,
        personaId: "persona-evm-only",
      });
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
           reservation_idempotency_key,bitcoin_network,privy_wallet_id,address,output_script_hex,
           assigned_at,created_at,updated_at
         ) VALUES ('taproot-retiring','persona-retiring',$1,'bitcoin-taproot',NULL,'active',
                   'taproot-retiring','regtest','privy-taproot',$2,$3,
                   statement_timestamp(),statement_timestamp(),statement_timestamp())`,
        [account, `bcrt1p${"q".repeat(58)}`, `5120${"5".repeat(64)}`],
      );
      // Direct retirement with a live Taproot recipient fails at commit.
      await admin.query("BEGIN");
      await admin.query(
        `UPDATE persona_wallet_assignments SET status='tombstoned',tombstoned_at=clock_timestamp(),
           updated_at=clock_timestamp()
          WHERE persona_id='persona-retiring' AND chain_account_kind='evm'`,
      );
      await admin.query(
        "UPDATE personas SET status='retired',retired_at=clock_timestamp() WHERE persona_id='persona-retiring'",
      );
      expect(await sqlState(admin.query("COMMIT"))).toBe("23514");
      const wallets = makeControlPlanePersonaWalletStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const retired = await Effect.runPromise(
        wallets.retire({ accountId: account, personaId: "persona-retiring", idempotencyKey: "r1" }),
      );
      expect(retired).toMatchObject({ persona_id: "persona-retiring", status: "retired" });
      const rows = await admin.query(
        `SELECT chain_account_kind,status FROM persona_wallet_assignments
          WHERE persona_id='persona-retiring' ORDER BY chain_account_kind`,
      );
      expect(rows.rows).toEqual([
        { chain_account_kind: "bitcoin-taproot", status: "tombstoned" },
        { chain_account_kind: "evm", status: "tombstoned" },
      ]);
      expect(
        await Effect.runPromise(
          wallets.retire({
            accountId: account,
            personaId: "persona-retiring",
            idempotencyKey: "r1",
          }),
        ),
      ).toEqual(retired);
      // The retired recipient's script is never recycled to a sibling persona.
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO persona_wallet_assignments (
               assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
               reservation_idempotency_key,bitcoin_network,privy_wallet_id,address,
               output_script_hex,assigned_at,created_at,updated_at
             ) VALUES ('taproot-reuse','persona-evm-only',$1,'bitcoin-taproot',NULL,'active',
                       'taproot-reuse','regtest','privy-reuse',$2,$3,
                       statement_timestamp(),statement_timestamp(),statement_timestamp())`,
            [account, `bcrt1p${"p".repeat(58)}`, `5120${"5".repeat(64)}`],
          ),
        ),
      ).toBe("23505");
      // A persona without a Taproot recipient retires exactly as before.
      expect(
        await Effect.runPromise(
          wallets.retire({
            accountId: account,
            personaId: "persona-evm-only",
            idempotencyKey: "r2",
          }),
        ),
      ).toMatchObject({ status: "retired" });
    });
    completed++;
  });

  test("records operator capability and funding observations in order", async () => {
    await withSchema(async (admin, connection) => {
      const store = spaces(connection);
      await configureSpacesNetwork(admin);
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: "spaces_operator_assignment_01",
        generation: 1,
        delegationAddress: delegation,
      });
      const observedAt = new Date(Date.now() - 5_000).toISOString();
      const funded = await Effect.runPromise(
        store.recordFundingObservation({
          operatorAssignmentId: "spaces_operator_assignment_01",
          operatorAssignmentGeneration: 1,
          observedAt,
          confirmedBalanceSats: "25000",
          nextCommitFeeSats: "12000",
        }),
      );
      expect(funded).toEqual({
        kind: "recorded",
        funding: {
          status: "funded_v1",
          confirmed_balance_sats: "25000",
          top_up_address: null,
          observed_at: observedAt,
        },
      });
      const paused = await Effect.runPromise(
        store.recordFundingObservation({
          operatorAssignmentId: "spaces_operator_assignment_01",
          operatorAssignmentGeneration: 1,
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          confirmedBalanceSats: "11999",
          nextCommitFeeSats: "12000",
        }),
      );
      expect(paused).toMatchObject({
        funding: { status: "commits_paused_insufficient_funds_v1" },
      });
      expect(
        await Effect.runPromise(
          store.recordFundingObservation({
            operatorAssignmentId: "spaces_operator_assignment_01",
            operatorAssignmentGeneration: 1,
            observedAt,
            confirmedBalanceSats: "1",
            nextCommitFeeSats: "1",
          }),
        ),
      ).toEqual({ kind: "stale" });
      expect(
        await failureOf(
          store.recordFundingObservation({
            operatorAssignmentId: "spaces_operator_assignment_01",
            operatorAssignmentGeneration: 2,
            observedAt,
            confirmedBalanceSats: "1",
            nextCommitFeeSats: "1",
          }),
        ),
      ).toEqual(new HandleSalesRejected({ reason: "sale_namespace_inactive", retryable: true }));
      expect(
        await sqlState(
          admin.query(`INSERT INTO spaces_operator_funding_observations
            (operator_assignment_id,operator_assignment_generation,observation_generation,observed_at,
             confirmed_balance_sats,next_commit_fee_sats,funding_status)
            VALUES ('spaces_operator_assignment_01',1,3,clock_timestamp(),1,2,'funded_v1')`),
        ),
      ).toBe("23514");
      const first = await Effect.runPromise(
        store.recordOperatorCapabilityObservation(capability("spaces_operator_assignment_01", 1)),
      );
      expect(first).toEqual({ kind: "recorded", observation_generation: 1 });
      expect(
        await Effect.runPromise(
          store.recordOperatorCapabilityObservation({
            ...capability("spaces_operator_assignment_01", 1),
            observedAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ),
      ).toEqual({ kind: "stale" });
      await expect(
        admin.query("DELETE FROM spaces_operator_capability_observations"),
      ).rejects.toThrow("append-only");
      // Deployment records are contiguous and append-only per assignment.
      const deployment = (generation: number) =>
        admin.query(
          `INSERT INTO spaces_operator_deployment_records (
             operator_assignment_id,deployment_generation,operator_assignment_generation,
             driver_family,driver_id,driver_version,upstream_operator_revision,node_version,
             prover_image_digest,adapter_revision,acceptance_reference,accepted_at
           ) VALUES ('spaces_operator_assignment_01',$1,1,'spaces','spaces_native-local','1',
                     'subs-4dcc923','spaced-0.0.0',$2,'adapter-1','acceptance-record',
                     clock_timestamp())`,
          [generation, `sha256:${"9".repeat(64)}`],
        );
      await deployment(1);
      await expect(deployment(3)).rejects.toThrow("not contiguous");
      await expect(
        admin.query("UPDATE spaces_operator_deployment_records SET node_version='other'"),
      ).rejects.toThrow("append-only");
      // A retired operator instance is terminal and serves no new active assignment.
      await admin.query(
        `UPDATE spaces_operator_instances SET status='retired',retired_at=clock_timestamp()
          WHERE operator_instance_id='operator-instance-1'`,
      );
      await expect(
        admin.query(
          `UPDATE spaces_operator_instances SET status='active',retired_at=NULL
            WHERE operator_instance_id='operator-instance-1'`,
        ),
      ).rejects.toThrow("retired once");
      await expect(
        seedSpacesOperatorAssignment(admin, {
          assignmentId: "spaces_operator_assignment_01",
          generation: 2,
          delegationAddress: delegation,
        }),
      ).rejects.toThrow("live operator instance");
    });
    completed++;
  });

  test("marks one provider create, reconciles inventory and activates only a signed wallet", async () => {
    await withSchema(async (admin, connection) => {
      await configureSpacesNetwork(admin);
      const accountId = "taproot-intent-owner";
      const personaId = await seedAccount(admin, accountId, { humanEvidence: false });
      const assignment = await Effect.runPromise(
        taproot(connection).prepare({
          accountId,
          personaId,
          idempotencyKey: "taproot-intent-one",
          network: "regtest",
        }),
      );
      const store = makeControlPlaneSpacesTaprootIntentStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const identity = {
        accountId,
        personaId,
        assignmentId: assignment.assignmentId,
        network: "regtest" as const,
      };
      const key = new Uint8Array(32).fill(7);
      const outputKey = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
      const address = regtestAddress(outputKey);
      const wallet = {
        providerId: "wallet_taproot_1",
        index: 2,
        address,
        outputScriptHex: `5120${outputKey}`,
        publicKeyHex: `02${outputKey}`,
      };
      expect(await Effect.runPromise(store.prepare(identity, []))).toMatchObject({
        state: "prepared",
      });
      expect(await Effect.runPromise(store.prepare(identity, []))).toMatchObject({
        state: "prepared",
      });
      expect(await Effect.runPromise(store.beginCreate(identity))).toMatchObject({
        mayCreate: true,
      });
      expect(await Effect.runPromise(store.beginCreate(identity))).toMatchObject({
        mayCreate: false,
      });
      expect(await Effect.runPromise(store.status(identity, []))).toMatchObject({
        kind: "pending",
      });
      const candidate = await Effect.runPromise(store.status(identity, [wallet]));
      if (candidate.kind !== "candidate") throw new Error("missing wallet candidate");
      // A new process/session recovers the same candidate from durable state.
      const recovered = makeControlPlaneSpacesTaprootIntentStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      expect(await Effect.runPromise(recovered.status(identity, [wallet]))).toEqual(candidate);
      expect(
        await failureOf(store.confirm(identity, [wallet], wallet.providerId, "00".repeat(64))),
      ).toMatchObject({ reason: "invalid" });
      const signature = Buffer.from(
        schnorr.sign(Buffer.from(candidate.challengeDigestHex, "hex"), key),
      ).toString("hex");
      expect(
        await Effect.runPromise(store.confirm(identity, [wallet], wallet.providerId, signature)),
      ).toMatchObject({
        address,
        outputScriptHex: wallet.outputScriptHex,
        replay: false,
      });
      expect(
        await Effect.runPromise(store.confirm(identity, [wallet], wallet.providerId, signature)),
      ).toMatchObject({ replay: true });
      expect(
        (
          await admin.query(
            "SELECT status,hd_wallet_index,privy_wallet_id FROM persona_wallet_assignments WHERE assignment_id=$1",
            [assignment.assignmentId],
          )
        ).rows[0],
      ).toMatchObject({
        status: "active",
        hd_wallet_index: "2",
        privy_wallet_id: wallet.providerId,
      });
      expect(await failureOf(store.beginCreate(identity))).toMatchObject({ reason: "conflict" });
    });
    completed++;
  });

  test("persists Taproot creation intent before provider work and recovers an exact retry", async () => {
    await withSchema(async (admin, connection) => {
      await configureSpacesNetwork(admin);
      const accountId = "taproot-prepare-owner";
      const personaId = await seedAccount(admin, accountId, { humanEvidence: false });
      const store = taproot(connection);
      const request = {
        accountId,
        personaId,
        idempotencyKey: "taproot-prep-1",
        network: "regtest" as const,
      };
      const pending = await Effect.runPromise(store.prepare(request));
      expect(pending).toMatchObject({
        personaId,
        network: "regtest",
        hdWalletIndex: null,
        status: "pending",
        address: null,
        outputScriptHex: null,
      });
      expect(await Effect.runPromise(store.read({ accountId, personaId }))).toEqual(pending);
      expect(await Effect.runPromise(store.prepare(request))).toEqual(pending);
      expect(
        await failureOf(store.prepare({ ...request, idempotencyKey: "changed" })),
      ).toMatchObject({
        _tag: "SpacesTaprootPreparationConflict",
        reason: "request-mismatch",
      });
      expect(await failureOf(store.prepare({ ...request, network: "mainnet" }))).toMatchObject({
        _tag: "SpacesTaprootPreparationConflict",
        reason: "request-mismatch",
      });
      // An interrupted provider call leaves a durable pending assignment and an active persona.
      expect(
        (await admin.query("SELECT status FROM personas WHERE persona_id=$1", [personaId])).rows[0]
          ?.status,
      ).toBe("active");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM persona_wallet_assignments WHERE persona_id=$1 AND chain_account_kind='bitcoin-taproot'",
            [personaId],
          )
        ).rows[0]?.count,
      ).toBe(1);
    });
    completed++;
  });

  test("reads an existing verified Taproot script without inventing a provider index", async () => {
    await withSchema(async (admin, connection) => {
      await configureSpacesNetwork(admin);
      const accountId = "taproot-verified-owner";
      const personaId = await seedAccount(admin, accountId, { humanEvidence: false });
      const store = taproot(connection);
      const program = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
      const address = regtestAddress(program);
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
           reservation_idempotency_key,bitcoin_network,privy_wallet_id,address,output_script_hex,
           assigned_at,created_at,updated_at
         ) VALUES ('taproot-verified',$1,$2,'bitcoin-taproot',NULL,'active',
                   'taproot-verified','regtest','provider-wallet-1',$3,$4,
                   statement_timestamp(),statement_timestamp(),statement_timestamp())`,
        [personaId, accountId, address, `5120${program}`],
      );
      expect(await Effect.runPromise(store.read({ accountId, personaId }))).toMatchObject({
        status: "active",
        address,
        outputScriptHex: `5120${program}`,
        hdWalletIndex: null,
      });
    });
    completed++;
  });

  test("serializes concurrent preparations and blocks a sibling while provider outcome is unknown", async () => {
    await withSchema(async (admin, connection) => {
      await configureSpacesNetwork(admin);
      const accountId = "taproot-concurrent-owner";
      const firstPersona = await seedAccount(admin, accountId, { humanEvidence: false });
      const secondPersona = "persona-taproot-concurrent-second";
      await createActivePersonaFixture(admin, { accountId, personaId: secondPersona });
      const store = taproot(connection);
      const firstRequest = {
        accountId,
        personaId: firstPersona,
        idempotencyKey: "taproot-concurrent-1",
        network: "regtest" as const,
      };
      const [first, replay] = await Promise.all([
        Effect.runPromise(store.prepare(firstRequest)),
        Effect.runPromise(store.prepare(firstRequest)),
      ]);
      expect(replay).toEqual(first);
      expect(
        await failureOf(store.prepare({ ...firstRequest, personaId: secondPersona })),
      ).toMatchObject({
        _tag: "SpacesTaprootPreparationConflict",
        reason: "request-mismatch",
      });
      expect(
        await failureOf(
          store.prepare({
            ...firstRequest,
            personaId: secondPersona,
            idempotencyKey: "taproot-concurrent-2",
          }),
        ),
      ).toMatchObject({
        _tag: "SpacesTaprootPreparationConflict",
        reason: "account-busy",
      });
      await admin.query(
        `UPDATE persona_wallet_assignments
            SET status='tombstoned',tombstoned_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE assignment_id=$1`,
        [first.assignmentId],
      );
      const second = await Effect.runPromise(
        store.prepare({
          ...firstRequest,
          personaId: secondPersona,
          idempotencyKey: "taproot-concurrent-2",
        }),
      );
      expect(first.hdWalletIndex).toBeNull();
      expect(second.hdWalletIndex).toBeNull();
      expect(second.assignmentId).not.toBe(first.assignmentId);
    });
    completed++;
  });
});

afterAll(async () => {
  if (connectionString && completed === testCount)
    await Bun.write(
      sentinel,
      "api-next-control-plane-postgres-spaces-sale-namespace-suite-complete\n",
    );
});
