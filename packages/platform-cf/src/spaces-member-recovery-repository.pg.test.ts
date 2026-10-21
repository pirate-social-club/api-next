import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HandleSalesPageRejected, type HandleSalesStore } from "@pirate/application";
import type { HandleSpacesQuoteV1 } from "@pirate/contracts";
import { bech32m } from "@scure/base";
import { Cause, DateTime, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { bindPersonaToCommunity, seedAccount } from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  configureSpacesNetwork,
  enableSpacesDriverForRoot,
  recordSpacesAuthorityEvidence,
  seedSpacesOperatorAssignment,
  seedSpacesSeller,
  spacesKeyA,
  spacesOutpoint,
  spacesRoot,
} from "./spaces-sale-namespace.pg-fixture.ts";
import { makeControlPlaneSpacesSaleNamespaceStore } from "./spaces-sale-namespace-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = connectionString ? describe : describe.skip;
const communityId = "community_00000000-0000-4000-8000-00000000b001";
const seller = "spaces-claims-seller";
const delegation = "bcrt1pspacesdelegationaddress01";
const activationId = "sale_namespace_activation_spaces_01";
const offeringId = "offering_spaces_free_01";
const policyHash = "f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482";
const sourceHash = "19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75";
const fixtureAt = (seconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { seconds }));
let completed = 0;

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_member_readback_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  let connected = false;
  let primary: { readonly error: unknown } | undefined;
  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyPostgresTestBaselineConnection({ connectionString: url.toString() });
    await use(admin, url.toString());
  } catch (error) {
    primary = { error };
  }
  const cleanupErrors: unknown[] = [];
  const cleanup = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (connected) {
    await cleanup(() => admin.query("ROLLBACK"));
    await cleanup(() => admin.query("SET session_replication_role = origin"));
    await cleanup(() => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  }
  await cleanup(() => admin.end());
  if (primary !== undefined) {
    if (cleanupErrors.length === 0) throw primary.error;
    throw new AggregateError(
      [primary.error, ...cleanupErrors],
      "Native readback test and cleanup failed",
      { cause: primary.error },
    );
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "Native readback cleanup failed");
}
const salesStore = (connection: string): HandleSalesStore =>
  makeControlPlaneHandleSalesStore(makeDirectPostgresControlPlaneLayer(connection), (binding) =>
    Effect.succeed(binding.network === "regtest"),
  );
const spacesStore = (connection: string) =>
  makeControlPlaneSpacesSaleNamespaceStore(makeDirectPostgresControlPlaneLayer(connection));
const failureOf = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) return undefined;
  const error = Cause.findError(exit.cause);
  return Result.isSuccess(error) ? error.success : undefined;
};
const readback = (
  store: HandleSalesStore,
  accountId: string,
  extra: Partial<Parameters<HandleSalesStore["listSpacesMemberRequests"]>[0]> = {},
) => Effect.runPromise(store.listSpacesMemberRequests({ accountId, ...extra }));

async function rowsSnapshot(admin: Client) {
  const tables = [
    "handle_quotes",
    "handle_quote_actions",
    "handle_reservations",
    "handle_reservation_actions",
    "handle_claims",
    "handle_claim_actions",
    "handle_key_fences",
    "handle_account_offering_grant_counters",
    "spaces_registry_items",
    "spaces_issuance_verifications",
    "persona_wallet_assignments",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (
      await admin.query(
        `SELECT COALESCE(jsonb_agg(data ORDER BY data::text), '[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) AS data FROM ${table} t) s`,
      )
    ).rows[0]?.rows;
  }
  return result;
}

// Reuse the existing native Spaces-sale setup, with no registry/provider caller.
async function seedSpacesSale(
  admin: Client,
  connection: string,
  options: Readonly<{ cap?: number | null }> = {},
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
  const store = spacesStore(connection);
  await Effect.runPromise(
    store.recordRootObservation({
      canonicalRoot: spacesRoot,
      observerReference: "independent-node-1",
      observedAt: fixtureAt(-1),
      root: {
        kind: "resolved",
        outpoint: spacesOutpoint,
        key: spacesKeyA,
        anchoredAt: fixtureAt(-60),
        anchorCoversRootOutpoint: true,
        publication: "verified",
        delegationAddress: delegation,
      },
      commitmentHistory: { kind: "verified", commitmentCount: 0, latestCommitmentRootHex: null },
      freshness: { observation_max_age_ms: 3_600_000, anchor_max_age_ms: 86_400_000 },
    }),
  );
  await Effect.runPromise(
    store.recordOperatorCapabilityObservation({
      operatorAssignmentId: "spaces_operator_assignment_01",
      operatorAssignmentGeneration: 1,
      observedAt: fixtureAt(-1),
      capability: "observed",
      observationMaxAgeMs: 3_600_000,
    }),
  );
  await enableSpacesDriverForRoot(admin, { enablementId: "enable-charizard" });
  const created = await Effect.runPromise(
    store.createSaleNamespace({
      accountId: seller,
      communityId,
      idempotencyKey: "spaces-create-1",
      namespaceAuthorityReference: "namespace_authority_spaces_01",
      expectedNamespaceAuthorityGeneration: 1,
      operatorAssignmentId: "spaces_operator_assignment_01",
      expectedOperatorAssignmentGeneration: 1,
      operatorFundingTermsConfirmed: true,
      activationId,
      actionId: "spaces-create-action-1",
    }),
  );
  expect(created.activation.status).toBe("active");
  const reserved = (
    await admin.query(
      "SELECT reserved_labels_hash FROM handle_reserved_label_revisions WHERE reserved_labels_id='reserved_labels_spaces_01'",
    )
  ).rows[0]?.reserved_labels_hash;
  const pricing = (
    await admin.query(
      "SELECT pricing_hash FROM handle_pricing_revisions WHERE pricing_id='platform_free_handles_v1'",
    )
  ).rows[0]?.pricing_hash;
  const createdAt = fixtureAt(-1);
  await admin.query(
    `INSERT INTO community_handle_offering_revisions (
       offering_id,offering_revision,offering_hash,community_id,family,namespace_root,
       display_root,sale_namespace_activation_id,sale_namespace_activation_generation,
       label_scope_kind,label_grammar_id,exact_label,min_label_length,max_label_length,
       reserved_labels_id,reserved_labels_revision,reserved_labels_hash,allocation_kind,
       max_active_grants_per_account,fulfillment_kind,qualification_policy_id,
       qualification_policy_revision,qualification_policy_hash,provider_binding_hash,
       pricing_id,pricing_revision,pricing_hash,atomic_amount,issuance_driver_id,
       issuance_driver_version,quote_ttl_seconds,reservation_ttl_seconds,status,
       actor_account_id,created_at
     ) VALUES (
       $1,1,$2,$3,'spaces',$4,$4,$5,1,'label_rule_v2','spaces_subspace_label_v1',NULL,8,32,
       'reserved_labels_spaces_01',1,$6,'first_come_v1',$7,'spaces_native_v1',
       'qualification_policy_spaces_members_01',1,$8,$9,'platform_free_handles_v1',1,$10,0,
       'spaces_native-local','1',120,300,'active',$11,$12::timestamptz
     )`,
    [
      offeringId,
      createHash("sha256").update(offeringId).digest("hex"),
      communityId,
      spacesRoot,
      activationId,
      reserved,
      options.cap === undefined ? 1 : options.cap,
      policyHash,
      sourceHash,
      pricing,
      seller,
      createdAt,
    ],
  );
  await admin.query(
    `INSERT INTO community_handle_offering_current (
       offering_id,community_id,sale_namespace_activation_id,current_revision,status,
       label_scope_kind,exact_label,updated_at
     ) VALUES ($1,$2,$3,1,'active','label_rule_v2',NULL,clock_timestamp())`,
    [offeringId, communityId, activationId],
  );
}

let taprootSequence = 0;
/** A confirmed Spec 014 §12 Taproot recipient on the regtest network. */
async function addTaproot(
  admin: Client,
  input: Readonly<{
    accountId: string;
    personaId: string;
    assignmentId: string;
    scriptOverride?: string;
  }>,
) {
  taprootSequence += 1;
  const n = taprootSequence;
  const outputKeyHex = n.toString(16).padStart(64, "0");
  const address = bech32m.encode(
    "bcrt",
    [1, ...bech32m.toWords(Buffer.from(outputKeyHex, "hex"))],
    90,
  );
  const script = `5120${outputKeyHex}`;
  await admin.query(
    `INSERT INTO persona_wallet_assignments (
       assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
       reservation_idempotency_key,bitcoin_network
     ) VALUES ($1,$2,$3,'bitcoin-taproot',NULL,'pending',$1,'regtest')`,
    [input.assignmentId, input.personaId, input.accountId],
  );
  await admin.query(
    `UPDATE persona_wallet_assignments
        SET status='active',privy_wallet_id='privy-' || assignment_id,address=$2,
            output_script_hex=$3,assigned_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE assignment_id=$1`,
    [input.assignmentId, address, input.scriptOverride ?? script],
  );
  return { assignmentId: input.assignmentId, script };
}

type Buyer = Readonly<{ accountId: string; personaId: string }>;

/** A buyer account whose first persona is bound to the offering's community. */
async function seedBuyer(
  admin: Client,
  accountId: string,
  options: Readonly<{ member?: boolean; bind?: boolean; taproot?: boolean }> = {},
): Promise<Buyer> {
  const personaId = await seedAccount(admin, accountId, { humanEvidence: false });
  if (options.bind !== false)
    await bindPersonaToCommunity(admin, { accountId, communityId, personaId });
  if (options.member !== false) {
    await insertActiveCommunityMembershipFixture(admin, {
      communityId,
      membershipId: `membership-${accountId}`,
      userId: accountId,
    });
  }
  if (options.taproot !== false) {
    await addTaproot(admin, { accountId, personaId, assignmentId: `taproot-${accountId}` });
  }
  return { accountId, personaId };
}

async function confirmLink(store: HandleSalesStore, buyer: Buyer, key: string) {
  await Effect.runPromise(
    store.confirmPersonaReuse({
      accountId: buyer.accountId,
      personaId: buyer.personaId,
      offeringId,
      idempotencyKey: `link-${key}`,
      confirmationId: `link-${key}`,
      actionId: `link-action-${key}`,
    }),
  );
}

const quoteInput = (buyer: Buyer, label: string, key: string) => ({
  accountId: buyer.accountId,
  personaId: buyer.personaId,
  offeringId,
  desiredLabel: label,
  idempotencyKey: `quote-${key}`,
  quoteId: `quote-${key}`,
  actionId: `quote-action-${key}`,
});

async function quoted(store: HandleSalesStore, buyer: Buyer, label: string, key: string) {
  await confirmLink(store, buyer, key);
  const result = await Effect.runPromise(store.createQuote(quoteInput(buyer, label, key)));
  if (result.kind !== "quoted" || result.quote.fulfillment.kind !== "spaces_native_v1") {
    throw new Error(`expected a Spaces quote, got ${JSON.stringify(result)}`);
  }
  return result.quote as HandleSpacesQuoteV1;
}

const reservationInput = (buyer: Buyer, quote: HandleSpacesQuoteV1, key: string) => ({
  accountId: buyer.accountId,
  personaId: buyer.personaId,
  quoteId: quote.quote_id,
  expectedQuoteHash: quote.quote_hash,
  idempotencyKey: `reservation-${key}`,
  reservationId: `reservation-${key}`,
  actionId: `reservation-action-${key}`,
});

async function reserved(store: HandleSalesStore, buyer: Buyer, label: string, key: string) {
  const quote = await quoted(store, buyer, label, key);
  const result = await Effect.runPromise(
    store.createReservation(reservationInput(buyer, quote, key)),
  );
  return { quote, reservation: result.reservation };
}

const claimInput = (
  buyer: Buyer,
  reservation: Readonly<{ reservation_id: string; reservation_hash: string }>,
  key: string,
) => ({
  accountId: buyer.accountId,
  personaId: buyer.personaId,
  reservationId: reservation.reservation_id,
  expectedReservationHash: reservation.reservation_hash,
  idempotencyKey: `claim-${key}`,
  claimId: `claim-${key}`,
  grantId: `grant-${key}`,
  actionId: `claim-action-${key}`,
});

suite("Spaces member retained request readback", () => {
  test("discovers all committed phases after a lost response and preserves them after membership and persona changes", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const buyer = await seedBuyer(admin, "readback-owner");
      const other = await seedBuyer(admin, "readback-other");
      const store = salesStore(connection);
      const { quote, reservation } = await reserved(store, buyer, "retainedname", "retained");
      // The caller deliberately retains no claim response or claim locator.
      await Effect.runPromise(store.submitFreeClaim(claimInput(buyer, reservation, "retained")));
      await admin.query(
        `UPDATE community_memberships SET status='left', left_at=clock_timestamp(),
        updated_at=clock_timestamp() WHERE user_id=$1 AND community_id=$2`,
        [buyer.accountId, communityId],
      );
      await admin.query("BEGIN");
      await admin.query(
        `UPDATE persona_wallet_assignments SET status='tombstoned',
        tombstoned_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE persona_id=$1 AND status IN ('active','pending')`,
        [buyer.personaId],
      );
      await admin.query(
        "UPDATE personas SET status='retired',retired_at=clock_timestamp() WHERE persona_id=$1",
        [buyer.personaId],
      );
      await admin.query("COMMIT");
      const before = await rowsSnapshot(admin);
      const page = await readback(store, buyer.accountId);
      expect(page.items.map((item) => item.kind)).toEqual(["quote", "reservation", "claim"]);
      for (const item of page.items) {
        if (item.kind === "quote_refusal") throw new Error("unexpected refusal");
        expect(item.context).toEqual({
          community_id: communityId,
          offering_id: offeringId,
          offering_revision: quote.offering_revision,
          offering_hash: quote.offering_hash,
          sale_namespace_activation_id: activationId,
          sale_namespace_activation_generation: 1,
          owner_persona_id: buyer.personaId,
          network: "regtest",
          namespace_root: spacesRoot,
        });
      }
      const retained = page.items.find((item) => item.kind === "claim");
      if (retained?.kind !== "claim") throw new Error("lost committed claim was not discovered");
      expect(retained.claim.recipient).toEqual(quote.recipient);
      expect(retained.claim.state).toBe("issuance_pending");
      expect(retained.action.idempotency_key).toBe("claim-retained");
      expect((await readback(store, other.accountId)).items).toEqual([]);
      expect(await rowsSnapshot(admin)).toEqual(before);
      expect(page.new_submission_admission).toBe("not_established_by_readback");
      expect(page.unlocated_request_outcome).toBe("unknown");
      expect(JSON.stringify(page)).not.toContain("recipient_taproot_assignment_id");
    });
    completed++;
  }, 60_000);

  test("paginates losslessly within one millisecond and refuses foreign or contradictory cursors", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const buyer = await seedBuyer(admin, "page-owner");
      const store = salesStore(connection);
      for (const key of ["a", "b", "c"])
        await quoted(store, buyer, `pagelabel${key}`, `page-${key}`);
      // Adversarial ordering fixture only: preserve three distinct native
      // microseconds that the public millisecond DTO cannot distinguish.
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE handle_quote_actions SET committed_at=
          '2026-10-19T01:00:00.123000Z'::timestamptz +
          CASE action_id WHEN 'quote-action-page-a' THEN interval '1 microsecond'
            WHEN 'quote-action-page-b' THEN interval '2 microseconds' ELSE interval '3 microseconds' END
          WHERE actor_account_id=$1`,
          [buyer.accountId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const first = await readback(store, buyer.accountId, { limit: 1 });
      expect(first.items.map((item) => item.action.action_id)).toEqual(["quote-action-page-a"]);
      if (first.next_cursor === null) throw new Error("missing next cursor");
      const next = await readback(store, buyer.accountId, { limit: 1, cursor: first.next_cursor });
      if (next.next_cursor === null) throw new Error("missing third cursor");
      const last = await readback(store, buyer.accountId, { limit: 1, cursor: next.next_cursor });
      expect(next.items.map((item) => item.action.action_id)).toEqual(["quote-action-page-b"]);
      expect(last.items.map((item) => item.action.action_id)).toEqual(["quote-action-page-c"]);
      expect(last.next_cursor).toBeNull();
      for (const extra of [
        { accountId: "foreign-account" },
        { limit: 2 },
        { communityId },
        { offeringId },
        { namespaceRoot: spacesRoot },
        { network: "regtest" as const },
      ]) {
        expect(
          await failureOf(
            store.listSpacesMemberRequests({
              accountId: buyer.accountId,
              limit: 1,
              cursor: first.next_cursor,
              ...extra,
            }),
          ),
        ).toEqual(new HandleSalesPageRejected({ reason: "invalid_cursor" }));
      }
      const cursor = JSON.parse(
        Buffer.from(first.next_cursor.slice(5), "base64url").toString("utf8"),
      );
      for (const value of [
        "smr1.YQ",
        "smr1.e30",
        "smr1._",
        `smr1.${"a".repeat(2050)}`,
        `smr1.${Buffer.from(JSON.stringify({ ...cursor, after: "9223372036854775808" })).toString("base64url")}`,
        `smr1.${Buffer.from(JSON.stringify({ ...cursor, after: String(BigInt(cursor.cutoff) + 1n) })).toString("base64url")}`,
      ]) {
        expect(
          await failureOf(
            store.listSpacesMemberRequests({ accountId: buyer.accountId, limit: 1, cursor: value }),
          ),
        ).toEqual(new HandleSalesPageRejected({ reason: "invalid_cursor" }));
      }
    });
    completed++;
  }, 60_000);

  test("retains expiry and partial refusals without inventing missing scope or mutating an unknown outcome", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const buyer = await seedBuyer(admin, "partial-owner");
      const store = salesStore(connection);
      const quote = await quoted(store, buyer, "expiredlabel", "expired");
      await admin.query("UPDATE handle_quotes SET status='expired' WHERE quote_id=$1", [
        quote.quote_id,
      ]);
      await admin.query(
        `INSERT INTO handle_quote_actions(action_id,actor_account_id,endpoint_template,
        idempotency_key,request_hash,result_kind,quote_id,offering_id,owner_persona_id,eligibility_reason,committed_at)
        VALUES ('partial-action',$1,'/handle-quotes','partial-key',$2,'eligibility_required',NULL,$3,$4,'evidence_required',clock_timestamp())`,
        [buyer.accountId, "a".repeat(64), offeringId, buyer.personaId],
      );
      const before = await rowsSnapshot(admin);
      const page = await readback(store, buyer.accountId);
      expect(page.items).toHaveLength(2);
      expect(page.items.find((item) => item.kind === "quote")).toMatchObject({
        quote: { status: "expired" },
      });
      expect(page.items.find((item) => item.kind === "quote_refusal")).toMatchObject({
        immutable_context: "not_recorded",
      });
      for (const filter of [
        { communityId },
        { namespaceRoot: spacesRoot },
        { network: "regtest" as const },
      ]) {
        expect(
          (await readback(store, buyer.accountId, filter)).items.map((item) => item.kind),
        ).toEqual(["quote"]);
      }
      expect((await readback(store, buyer.accountId, { offeringId })).items).toHaveLength(2);
      const empty = await readback(store, buyer.accountId, { namespaceRoot: "different-root" });
      expect(empty.items).toEqual([]);
      expect(empty.unlocated_request_outcome).toBe("unknown");
      expect(empty.new_submission_admission).toBe("not_established_by_readback");
      expect(await rowsSnapshot(admin)).toEqual(before);
    });
    completed++;
  }, 60_000);

  test("filters by the retained root instead of the current root and never crosses account scope", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const buyer = await seedBuyer(admin, "roots-owner");
      const store = salesStore(connection);
      const quote = await quoted(store, buyer, "originallabel", "original-root");
      // Projection-only second-root and moved-head fixtures; these do not
      // assert admission or a valid writer transition for the synthetic row.
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO community_handle_sale_namespace_activation_revisions
          SELECT (jsonb_populate_record(NULL::community_handle_sale_namespace_activation_revisions,
            to_jsonb(original) || jsonb_build_object('sale_namespace_activation_id','second-activation','canonical_root','second-root','display_root','second-root'))).*
          FROM community_handle_sale_namespace_activation_revisions original WHERE sale_namespace_activation_id=$1`,
          [activationId],
        );
        await admin.query(
          `INSERT INTO handle_quotes SELECT (jsonb_populate_record(NULL::handle_quotes,
          to_jsonb(original) || jsonb_build_object('quote_id','second-root-quote','namespace_root','second-root',
            'display_root','second-root','display_identifier','originallabel@second-root','sale_namespace_activation_id','second-activation'))).*
          FROM handle_quotes original WHERE quote_id=$1`,
          [quote.quote_id],
        );
        await admin.query(
          `INSERT INTO handle_quote_actions SELECT (jsonb_populate_record(NULL::handle_quote_actions,
          to_jsonb(original) || jsonb_build_object('action_id','second-root-action','quote_id','second-root-quote','idempotency_key','second-root-key'))).*
          FROM handle_quote_actions original WHERE quote_id=$1`,
          [quote.quote_id],
        );
        await admin.query(
          "UPDATE community_handle_sale_namespace_activation_current SET canonical_root='moved-root' WHERE sale_namespace_activation_id=$1",
          [activationId],
        );
        await admin.query(
          "UPDATE community_handle_offering_current SET status='paused' WHERE offering_id=$1",
          [offeringId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const before = await rowsSnapshot(admin);
      expect((await readback(store, buyer.accountId)).items).toHaveLength(2);
      const original = await readback(store, buyer.accountId, {
        namespaceRoot: spacesRoot,
        network: "regtest",
      });
      const second = await readback(store, buyer.accountId, {
        namespaceRoot: "second-root",
        network: "regtest",
      });
      expect(original.items.map((item) => item.action.action_id)).toEqual([
        "quote-action-original-root",
      ]);
      expect(second.items.map((item) => item.action.action_id)).toEqual(["second-root-action"]);
      expect(
        (await readback(store, buyer.accountId, { namespaceRoot: "moved-root" })).items,
      ).toEqual([]);
      expect((await readback(store, "unrelated-account")).items).toEqual([]);
      expect(await rowsSnapshot(admin)).toEqual(before);
    });
    completed++;
  }, 60_000);
});

afterAll(async () => {
  if (connectionString && completed === 4)
    await Bun.write(
      process.env.CONTROL_PLANE_POSTGRES_SPACES_MEMBER_RECOVERY_TEST_SENTINEL ??
        "/tmp/api-next-control-plane-postgres-spaces-member-recovery-suite-complete",
      "api-next-control-plane-postgres-spaces-member-recovery-suite-complete\n",
    );
});
