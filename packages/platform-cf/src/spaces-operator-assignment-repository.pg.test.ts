import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { bech32m } from "@scure/base";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeSpacesOperatorAssignmentStore,
  mintSpacesOperatorServiceCredential,
} from "./spaces-operator-assignment-repository.ts";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import type { SpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const accountId = "spaces-assignment-account";
const communityId = "community_00000000-0000-4000-8000-00000000c002";
const outpoint = `${"22".repeat(32)}:1`;
const rootKey = "33".repeat(32);
const address = "bcs1p00rgyrzt0gmec52mu3w2un0xl6pzqyq9e8yc9t48fdk0cu3us8ys7rnkp7";

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_assign_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: url.toString() });
    await admin.query("INSERT INTO users (user_id,status) VALUES ($1,'active')", [accountId]);
    await admin.query(
      `
      INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,
        updated_at,route_slug,route_authority_version)
      VALUES ($1,'Spaces Assignment','active',$2,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
      [communityId, accountId],
    );
    await admin.query(
      `
      INSERT INTO community_handle_sales_authority_grants
        (grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,
         status,granted_at,granted_by_account_id)
      VALUES ('spaces-assignment-grant',$1,$2,'manage_handle_sales','community_policy',
              'spaces-assignment-test','active',clock_timestamp(),$2)`,
      [communityId, accountId],
    );
    await admin.query(
      "INSERT INTO spaces_network_configuration (configuration_key,network) VALUES ('spaces_network_v1','mainnet')",
    );
    await admin.query(`
      INSERT INTO spaces_operator_instances (operator_instance_id,network,status,created_at)
      VALUES ('spaces-instance-yahoo','mainnet','active',clock_timestamp())`);
    await admin.query(
      `
      INSERT INTO spaces_namespace_authority_evidence
        (namespace_authority_reference,namespace_authority_generation,evidence_digest,network,
         canonical_root,display_root,community_id,controlling_account_id,challenge_environment,
         challenge_nonce_digest,root_outpoint,root_key_hex,anchor_block_hash,anchor_height,
         anchored_at,key_last_changed_at,challenge_completed_at,publication_verified_at,
         observed_at,fresh_until,raw_verifier_evidence)
      VALUES ('snauth_assignment_01',1,$1,'mainnet','yahoo','yahoo',$2,$3,'staging',$4,
              $5,$6,$7,968544,clock_timestamp()-interval '2 minutes',
              clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',
              clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute',
              clock_timestamp()+interval '9 minutes',$8)`,
      [
        "11".repeat(32),
        communityId,
        accountId,
        "44".repeat(32),
        outpoint,
        rootKey,
        "55".repeat(32),
        Buffer.from("{}"),
      ],
    );
    await use(admin, url.toString());
  } finally {
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

function makeHarness(connection: string, observer: SpacesRootAuthorityObserver) {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const run = <T>(action: (db: ControlPlaneDb["Service"]) => Promise<T>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(layer)(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* Effect.promise(() => action(db));
          }),
        ),
      ),
    );
  return {
    mint: (
      root: string,
      capability:
        | "assignment_prepare"
        | "capability_report"
        | "funding_report" = "assignment_prepare",
    ) =>
      run((db) =>
        mintSpacesOperatorServiceCredential(db, {
          operatorInstanceId: "spaces-instance-yahoo",
          environment: "staging",
          canonicalRoot: root,
          capability,
          authorizationReference: "spaces-assignment-test",
        }),
      ),
    store: {
      prepare: (token: string, body: unknown) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" }).prepare(
            token,
            body,
          ),
        ),
      readback: (token: string, id: string, generation: number) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" }).readback(
            token,
            id,
            generation,
          ),
        ),
      list: (root: string) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" }).list({
            accountId,
            communityId,
            canonicalRoot: root,
          }),
        ),
      confirm: (
        input: Parameters<ReturnType<typeof makeSpacesOperatorAssignmentStore>["confirm"]>[0],
      ) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" }).confirm(
            input,
          ),
        ),
      reportCapability: (token: string, body: unknown) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({
            db,
            observer,
            environment: "staging",
          }).reportCapability(token, body),
        ),
      reportFunding: (token: string, body: unknown) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" }).reportFunding(
            token,
            body,
          ),
        ),
      readbackReport: (
        token: string,
        capability: "capability_report" | "funding_report",
        id: string,
      ) =>
        run((db) =>
          makeSpacesOperatorAssignmentStore({
            db,
            observer,
            environment: "staging",
          }).readbackReport(token, capability, id),
        ),
    },
  };
}

const evidence = (outpointValue = outpoint) =>
  ({
    root: "@yahoo",
    network: "mainnet",
    anchor_bound_outpoint: true,
    outpoint: outpointValue,
    owner_xonly_key_hex: rootKey,
  }) as SpacesRootAuthorityEvidenceV1;

suite("Spaces operator assignment persistence", () => {
  test("prepare is scoped, exactly replayed and not an active assignment", async () => {
    await withSchema(async (admin, connection) => {
      const observer: SpacesRootAuthorityObserver = {
        observe: async () => ({
          kind: "verified",
          bytes: Buffer.from("{}"),
          evidence: evidence(),
        }),
      };
      const { mint, store } = makeHarness(connection, observer);
      const { token } = await mint("yahoo");
      const body = {
        idempotency_key: "prepare-1",
        operator_instance_id: "spaces-instance-yahoo",
        network: "mainnet",
        canonical_root: "yahoo",
        operator_wallet_reference: "wallet-yahoo-1",
        delegation_address: address,
      };
      await expect(
        store.prepare("pirate-spaces-registry-v1.fake.fake", body),
      ).rejects.toMatchObject({ reason: "unauthorized" });
      const prepared = await store.prepare(token, body);
      expect(prepared.replayed).toBe(false);
      expect(prepared.delegation_address).toBe(address);
      expect((await store.prepare(token, body)).replayed).toBe(true);
      expect((await store.readback(token, prepared.operator_assignment_id, 1)).replayed).toBe(true);
      await expect(
        store.prepare(token, { ...body, operator_wallet_reference: "other-wallet" }),
      ).rejects.toMatchObject({ reason: "conflict" });
      const otherAddress = bech32m.encode(
        "bcs",
        [1, ...bech32m.toWords(Uint8Array.from({ length: 32 }, () => 7))],
        120,
      );
      await expect(
        store.prepare(token, {
          ...body,
          idempotency_key: "prepare-4",
          operator_wallet_reference: "other-wallet",
          delegation_address: otherAddress,
        }),
      ).rejects.toMatchObject({ reason: "conflict" });
      await expect(
        store.prepare(token, { ...body, idempotency_key: "prepare-2", canonical_root: "ceramic" }),
      ).rejects.toMatchObject({ reason: "forbidden" });
      await expect(
        store.prepare(token, {
          ...body,
          idempotency_key: "prepare-3",
          delegation_address: `${address.slice(0, -1)}q`,
        }),
      ).rejects.toMatchObject({ reason: "invalid" });
      expect((await store.list("yahoo")).candidate?.operator_assignment_id).toBe(
        prepared.operator_assignment_id,
      );
      const revisions = await admin.query(
        "SELECT count(*)::int AS count FROM spaces_operator_assignment_revisions",
      );
      expect(revisions.rows[0]?.count).toBe(0);
    });
  });

  test("owner confirmation rejects stale root, then activates once and replays without observation", async () => {
    await withSchema(async (admin, connection) => {
      let changed = true;
      let observed = 0;
      const observer: SpacesRootAuthorityObserver = {
        observe: async () => {
          observed += 1;
          return {
            kind: "verified",
            bytes: Buffer.from("{}"),
            evidence: evidence(changed ? `${"66".repeat(32)}:1` : outpoint),
          };
        },
      };
      const { mint, store } = makeHarness(connection, observer);
      const { token } = await mint("yahoo");
      const prepared = await store.prepare(token, {
        idempotency_key: "prepare-1",
        operator_instance_id: "spaces-instance-yahoo",
        network: "mainnet",
        canonical_root: "yahoo",
        operator_wallet_reference: "wallet-yahoo-1",
        delegation_address: address,
      });
      const input = {
        accountId,
        communityId,
        idempotencyKey: "confirm-1",
        assignmentId: prepared.operator_assignment_id,
        expectedGeneration: 1,
        authorityReference: "snauth_assignment_01",
        expectedAuthorityGeneration: 1,
      };
      await expect(store.confirm(input)).rejects.toMatchObject({ reason: "unavailable" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM spaces_operator_assignment_revisions",
          )
        ).rows[0]?.count,
      ).toBe(0);
      changed = false;
      const confirmed = await store.confirm(input);
      expect(confirmed.replayed).toBe(false);
      expect((await store.confirm(input)).replayed).toBe(true);
      expect(observed).toBe(2);
      await expect(store.confirm({ ...input, idempotencyKey: "confirm-2" })).rejects.toMatchObject({
        reason: "conflict",
      });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM spaces_operator_assignment_current"))
          .rows[0]?.count,
      ).toBe(1);
    });
  });

  test("capability and funding reports use distinct scoped tokens and durable readback", async () => {
    await withSchema(async (admin, connection) => {
      const observer: SpacesRootAuthorityObserver = {
        observe: async () => ({
          kind: "verified",
          bytes: Buffer.from("{}"),
          evidence: evidence(),
        }),
      };
      const { mint, store } = makeHarness(connection, observer);
      const prepareToken = (await mint("yahoo")).token;
      const prepared = await store.prepare(prepareToken, {
        idempotency_key: "prepare-1",
        operator_instance_id: "spaces-instance-yahoo",
        network: "mainnet",
        canonical_root: "yahoo",
        operator_wallet_reference: "wallet-yahoo-1",
        delegation_address: address,
      });
      await store.confirm({
        accountId,
        communityId,
        idempotencyKey: "confirm-1",
        assignmentId: prepared.operator_assignment_id,
        expectedGeneration: 1,
        authorityReference: "snauth_assignment_01",
        expectedAuthorityGeneration: 1,
      });
      const capabilityToken = (await mint("yahoo", "capability_report")).token;
      const fundingToken = (await mint("yahoo", "funding_report")).token;
      const common = {
        idempotency_key: "report-1",
        operator_assignment_id: prepared.operator_assignment_id,
        operator_assignment_generation: 1,
        network: "mainnet",
        canonical_root: "yahoo",
        operator_wallet_reference: "wallet-yahoo-1",
        delegation_address: address,
        observed_at: new Date(Date.now() - 1000).toISOString(),
      };
      await expect(
        store.reportCapability(prepareToken, { ...common, can_operate: true }),
      ).rejects.toMatchObject({ reason: "unauthorized" });
      const capability = await store.reportCapability(capabilityToken, {
        ...common,
        can_operate: true,
      });
      expect(capability.status).toBe("observed");
      expect(
        (await store.reportCapability(capabilityToken, { ...common, can_operate: true })).replayed,
      ).toBe(true);
      await expect(
        store.reportCapability(capabilityToken, { ...common, can_operate: false }),
      ).rejects.toMatchObject({ reason: "conflict" });
      expect(
        (await store.readbackReport(capabilityToken, "capability_report", capability.report_id))
          .replayed,
      ).toBe(true);
      const fundingBody = {
        ...common,
        confirmed_balance_sats: "2500",
        next_commit_fee_sats: "3000",
      };
      await expect(store.reportFunding(capabilityToken, fundingBody)).rejects.toMatchObject({
        reason: "unauthorized",
      });
      const funding = await store.reportFunding(fundingToken, fundingBody);
      expect(funding.status).toBe("commits_paused_insufficient_funds_v1");
      expect(
        (await store.readbackReport(fundingToken, "funding_report", funding.report_id)).status,
      ).toBe("commits_paused_insufficient_funds_v1");
      const reports = await admin.query(
        "SELECT count(*)::int AS count FROM spaces_operator_service_reports",
      );
      expect(reports.rows[0]?.count).toBe(2);
    });
  });
});
