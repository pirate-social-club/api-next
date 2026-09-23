import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  HandleRecipientTokenVault,
  HandleSalesRejected,
  HandleSalesStorageFailed,
  type HandleSalesStore,
  IdGen,
  makeHandleSalesService,
  type SpacesRegistryStore,
  type SpacesSaleNamespaceStore,
} from "@pirate/application";
import type { HandleSpacesClaimV1, HandleSpacesQuoteV1 } from "@pirate/contracts";
import {
  handleSpacesGrantFinalizeV3Hash,
  handleSpacesQuoteV3Hash,
  handleSpacesReservationV3Hash,
} from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { makeHandleRecipientTokenVault } from "./handle-recipient-token-vault.ts";
import {
  bindPersonaToCommunity,
  seedAccount,
  seedSaleNamespace,
  terms,
} from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSpacesReconciliationStore } from "./spaces-reconciliation-repository.ts";
import { mintSpacesRegistryCredentialV1 } from "./spaces-registry-credential.ts";
import { makeControlPlaneSpacesRegistryStore } from "./spaces-registry-repository.ts";
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

/**
 * Native Spaces quote, reservation, and atomic claim against a fresh schema
 * (spec 012 §5.3.13.6-§5.3.13.8, §5.3.13.12, and §5.3.13.13). The Spaces
 * driver stays disabled; each test enables one root through the test-only
 * root enablement of ruling Q3.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_SPACES_HANDLE_CLAIMS_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-spaces-handle-claims-suite-complete";
const testCount = 20;
let completed = 0;

const communityId = "community_00000000-0000-4000-8000-00000000b001";
const seller = "spaces-claims-seller";
const delegation = "bcrt1pspacesdelegationaddress01";
const activationId = "sale_namespace_activation_spaces_01";
const offeringId = "offering_spaces_free_01";
const policyHash = "f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482";
const sourceHash = "19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_claims_${crypto.randomUUID().replaceAll("-", "")}`;
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

const salesStore = (connection: string): HandleSalesStore =>
  makeControlPlaneHandleSalesStore(makeDirectPostgresControlPlaneLayer(connection));

const spacesStore = (connection: string): SpacesSaleNamespaceStore =>
  makeControlPlaneSpacesSaleNamespaceStore(makeDirectPostgresControlPlaneLayer(connection));

const registryStore = (connection: string): SpacesRegistryStore =>
  makeControlPlaneSpacesRegistryStore(makeDirectPostgresControlPlaneLayer(connection));

const reconciliationStore = (connection: string) =>
  makeControlPlaneSpacesReconciliationStore(makeDirectPostgresControlPlaneLayer(connection));

async function registryCredential(connection: string) {
  const result = await Effect.runPromise(
    Effect.provide(makeDirectPostgresControlPlaneLayer(connection))(
      mintSpacesRegistryCredentialV1({
        operatorInstanceId: "operator-instance-1",
        environment: "development",
        allowedRoots: [spacesRoot],
        authorizationReference: "spaces-registry-test-authorization",
        rotationOverlapSeconds: 0,
      }),
    ),
  );
  const authenticated = await Effect.runPromise(
    registryStore(connection).authenticate({ token: result.token, environment: "development" }),
  );
  if (authenticated === null) throw new Error("minted credential was refused");
  return { ...result, authenticated };
}

async function registryClaim(admin: Client, connection: string, label: string, key: string) {
  const buyer = await seedBuyer(admin, `registry-${key}`);
  const { reservation } = await reserved(salesStore(connection), buyer, label, key);
  return spacesClaim(
    (
      await Effect.runPromise(
        salesStore(connection).submitFreeClaim(claimInput(buyer, reservation, key)),
      )
    ).claim,
  );
}

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E | undefined> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

const rejected = (reason: HandleSalesRejected["reason"], retryable = false) =>
  new HandleSalesRejected({ reason, retryable });

const sqlState = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const count = async (admin: Client, table: string, where = "TRUE", values: unknown[] = []) =>
  Number(
    (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0]
      ?.n,
  );

/** Every table a members-only refusal must leave untouched. */
const WATCHED_TABLES = [
  "community_memberships",
  "community_follows",
  "evidence_receipts",
  "assertions",
  "persona_wallet_assignments",
  "handle_nationality_decisions",
  "handle_nationality_qualification_intents",
  "handle_quotes",
  "handle_quote_actions",
  "handle_reservations",
  "handle_claims",
  "handle_key_fences",
  "handle_account_offering_grant_counters",
  "spaces_registry_items",
  "spaces_issuance_verifications",
] as const;

const snapshot = async (admin: Client) => {
  const counts: Record<string, number> = {};
  for (const table of WATCHED_TABLES) counts[table] = await count(admin, table);
  counts.available_link_confirmations = await count(
    admin,
    "handle_persona_link_confirmations",
    "status='available'",
  );
  counts.memberships_by_status = Number(
    (
      await admin.query(
        "SELECT count(DISTINCT (user_id, status))::int AS n FROM community_memberships",
      )
    ).rows[0]?.n,
  );
  return counts;
};

/** Seeds a ready, enabled Spaces root with an active members-only offering. */
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
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      root: {
        kind: "resolved",
        outpoint: spacesOutpoint,
        key: spacesKeyA,
        anchoredAt: new Date(Date.now() - 60_000).toISOString(),
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
      observedAt: new Date(Date.now() - 1_000).toISOString(),
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
  const createdAt = new Date(Date.now() - 1_000).toISOString();
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
  input: Readonly<{ accountId: string; personaId: string; assignmentId: string }>,
) {
  taprootSequence += 1;
  const n = taprootSequence;
  const address = `bcrt1p${"q".repeat(56)}${BECH32[Math.floor(n / 32) % 32]}${BECH32[n % 32]}`;
  const script = `5120${n.toString(16).padStart(64, "0")}`;
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
    [input.assignmentId, address, script],
  );
  return { assignmentId: input.assignmentId, script };
}

const tombstoneTaproot = (admin: Client, assignmentId: string) =>
  admin.query(
    `UPDATE persona_wallet_assignments
        SET status='tombstoned',tombstoned_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE assignment_id=$1`,
    [assignmentId],
  );

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

const spacesClaim = (claim: unknown): HandleSpacesClaimV1 => {
  const value = claim as HandleSpacesClaimV1;
  if (value.fulfillment.kind !== "spaces_native_v1") throw new Error("expected a Spaces claim");
  return value;
};

const setMembership = (admin: Client, accountId: string, status: "left" | "banned" | "member") =>
  admin.query(
    `UPDATE community_memberships
        SET status=$2,
            left_at=CASE WHEN $2='left' THEN clock_timestamp() ELSE left_at END,
            banned_at=CASE WHEN $2='banned' THEN clock_timestamp() ELSE banned_at END,
            updated_at=clock_timestamp()
      WHERE community_id=$1 AND user_id=$3`,
    [communityId, status, accountId],
  );

suite("Spaces quote, reservation, and atomic claim", () => {
  test("refuses the members-only matrix before recipient resolution and writes nothing", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const nonmember = await seedBuyer(admin, "nonmember", {
        member: false,
        bind: false,
        taproot: false,
      });
      const pending = await seedBuyer(admin, "pending-member", { member: false, taproot: false });
      await admin.query(
        `INSERT INTO community_memberships (
           community_id,membership_id,user_id,status,created_at,updated_at
         ) VALUES ($1,'membership-pending','pending-member','pending',clock_timestamp(),clock_timestamp())`,
        [communityId],
      );
      const left = await seedBuyer(admin, "left-member", { taproot: false });
      await setMembership(admin, "left-member", "left");
      const banned = await seedBuyer(admin, "banned-member", { taproot: false });
      await setMembership(admin, "banned-member", "banned");
      const follower = await seedBuyer(admin, "follower", {
        member: false,
        bind: false,
        taproot: false,
      });
      await admin.query(
        `INSERT INTO community_follows (
           community_follow_id,community_id,user_id,status,created_at,updated_at
         ) VALUES ('follow-only',$1,'follower','active',clock_timestamp(),clock_timestamp())`,
        [communityId],
      );
      // A persona bound to the community without membership fails too.
      const bound = await seedBuyer(admin, "bound-only", { member: false, taproot: false });
      // A nonmember who does hold a Taproot recipient is refused the same way.
      const walletNonmember = await seedBuyer(admin, "wallet-nonmember", { member: false });
      const cases = [nonmember, pending, left, banned, follower, bound, walletNonmember];
      for (const buyer of cases) await confirmLink(store, buyer, buyer.accountId);

      for (const buyer of cases) {
        const before = await snapshot(admin);
        const result = await Effect.runPromise(
          store.createQuote(quoteInput(buyer, "charizardfan", buyer.accountId)),
        );
        expect(result, buyer.accountId).toEqual({
          kind: "eligibility_required",
          offering_id: offeringId,
          owner_persona_id: buyer.personaId,
          reason: "qualification_unsatisfied",
        });
        expect(await snapshot(admin), buyer.accountId).toEqual(before);
        // Nothing was recorded, so the same key evaluates again rather than replaying.
        expect(
          await Effect.runPromise(
            store.createQuote(quoteInput(buyer, "charizardfan", buyer.accountId)),
          ),
        ).toEqual(result);
      }
      expect(await count(admin, "community_memberships", "status='member'")).toBe(0);
      expect(await count(admin, "handle_quote_actions")).toBe(0);
    });
    completed++;
  }, 60_000);

  test("returns recipient_wallet_required before any write and never falls back", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const member = await seedBuyer(admin, "walletless", { taproot: false });
      await confirmLink(store, member, "walletless");
      const expected = {
        kind: "recipient_wallet_required",
        offering_id: offeringId,
        owner_persona_id: member.personaId,
        reason: "recipient_wallet_required",
      } as const;
      const before = await snapshot(admin);
      expect(
        await Effect.runPromise(store.createQuote(quoteInput(member, "walletlessfan", "w1"))),
      ).toEqual(expected);
      expect(await snapshot(admin)).toEqual(before);

      // An unconfirmed Taproot assignment is not a recipient.
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
           reservation_idempotency_key,bitcoin_network
         ) VALUES ('taproot-unconfirmed',$1,'walletless','bitcoin-taproot',NULL,'pending',
                   'taproot-unconfirmed','regtest')`,
        [member.personaId],
      );
      const pendingBefore = await snapshot(admin);
      expect(
        await Effect.runPromise(store.createQuote(quoteInput(member, "walletlessfan", "w2"))),
      ).toEqual(expected);
      expect(await snapshot(admin)).toEqual(pendingBefore);

      // A tombstoned recipient is never reused.
      await admin.query(
        `UPDATE persona_wallet_assignments
            SET status='tombstoned',tombstoned_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE assignment_id='taproot-unconfirmed'`,
      );
      expect(
        await Effect.runPromise(store.createQuote(quoteInput(member, "walletlessfan", "w3"))),
      ).toEqual(expected);
      expect(await count(admin, "handle_quotes")).toBe(0);
      expect(await count(admin, "handle_quote_actions")).toBe(0);
    });
    completed++;
  }, 60_000);

  test("quotes, reserves, and claims atomically as issuance_pending with nothing public", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const buyer = await seedBuyer(admin, "member-a");
      const recipient = (
        await admin.query(
          "SELECT output_script_hex FROM persona_wallet_assignments WHERE assignment_id='taproot-member-a'",
        )
      ).rows[0]?.output_script_hex as string;
      const binding = {
        kind: "persona_taproot_v1" as const,
        network: "regtest" as const,
        taproot_assignment_id: "taproot-member-a",
        script_pubkey_hex: recipient,
      };
      await confirmLink(store, buyer, "a");
      const quoteResult = await Effect.runPromise(
        store.createQuote(quoteInput(buyer, "charizardfan", "a")),
      );
      if (quoteResult.kind !== "quoted") throw new Error("expected a quote");
      const quote = quoteResult.quote as HandleSpacesQuoteV1;
      expect(quote).toMatchObject({
        fulfillment: { kind: "spaces_native_v1" },
        handle: { family: "spaces", namespace_root: spacesRoot, handle_label: "charizardfan" },
        display_identifier: `charizardfan@${spacesRoot}`,
        recipient: { kind: "persona_taproot_v1", network: "regtest", script_pubkey_hex: recipient },
        eligibility: { decision: "passed", evidence_use_ids: [], policy_hash: policyHash },
      });
      expect(JSON.stringify(quote)).not.toContain("taproot-member-a");
      expect(quote.quote_hash).toBe(
        handleSpacesQuoteV3Hash({
          quote_id: quote.quote_id,
          offering_id: quote.offering_id,
          offering_revision: quote.offering_revision,
          offering_hash: quote.offering_hash,
          sale_namespace_activation_id: quote.sale_namespace_activation_id,
          sale_namespace_activation_generation: quote.sale_namespace_activation_generation,
          fulfillment_kind: "spaces_native_v1",
          owner_persona_id: buyer.personaId,
          recipient: binding,
          family: "spaces",
          namespace_root: spacesRoot,
          handle_label: "charizardfan",
          pricing: quote.pricing,
          eligibility: quote.eligibility,
          quoted_at: quote.quoted_at,
          expires_at: quote.expires_at,
        }).sha256,
      );
      expect(
        await Effect.runPromise(store.createQuote(quoteInput(buyer, "charizardfan", "a"))),
      ).toEqual({ ...quoteResult, replayed: true });

      const reservationResult = await Effect.runPromise(
        store.createReservation(reservationInput(buyer, quote, "a")),
      );
      const reservation = reservationResult.reservation;
      if (reservation.fulfillment.kind !== "spaces_native_v1" || !("recipient" in reservation)) {
        throw new Error("expected a Spaces reservation");
      }
      expect(reservation.reservation_hash).toBe(
        handleSpacesReservationV3Hash({
          reservation_id: reservation.reservation_id,
          quote_id: quote.quote_id,
          quote_hash: quote.quote_hash,
          offering_id: quote.offering_id,
          offering_hash: quote.offering_hash,
          sale_namespace_activation_id: quote.sale_namespace_activation_id,
          sale_namespace_activation_generation: quote.sale_namespace_activation_generation,
          fulfillment_kind: "spaces_native_v1",
          owner_persona_id: buyer.personaId,
          recipient: binding,
          family: "spaces",
          namespace_root: spacesRoot,
          handle_label: "charizardfan",
          reserved_at: reservation.reserved_at,
          expires_at: reservation.expires_at,
        }).sha256,
      );
      expect(
        (await Effect.runPromise(store.createReservation(reservationInput(buyer, quote, "a"))))
          .replayed,
      ).toBe(true);

      const submitted = await Effect.runPromise(
        store.submitFreeClaim({
          ...claimInput(buyer, reservation, "a"),
          issuanceOperationId: "ignored-by-the-store",
        }),
      );
      const claim = spacesClaim(submitted.claim);
      expect(submitted.replayed).toBe(false);
      expect(claim).toMatchObject({
        claim_id: "claim-a",
        state: "issuance_pending",
        safe_reason: "issuance_pending",
        delayed: false,
        grant: null,
        display_identifier: `charizardfan@${spacesRoot}`,
        recipient: { kind: "persona_taproot_v1", network: "regtest", script_pubkey_hex: recipient },
      });
      const claimRow = (await admin.query("SELECT * FROM handle_claims WHERE claim_id='claim-a'"))
        .rows[0];
      expect(claimRow).toMatchObject({
        family: "spaces",
        fulfillment_kind: "spaces_native_v1",
        grant_id: null,
        issuance_operation_id: "issuance:spaces-native:claim-a",
        recipient_taproot_assignment_id: "taproot-member-a",
      });
      expect(claimRow.grant_finalize_hash).toBe(
        handleSpacesGrantFinalizeV3Hash({
          claim_id: "claim-a",
          reservation_id: reservation.reservation_id,
          reservation_hash: reservation.reservation_hash,
          offering_id: offeringId,
          offering_hash: quote.offering_hash,
          sale_namespace_activation_id: activationId,
          sale_namespace_activation_generation: 1,
          fulfillment_kind: "spaces_native_v1",
          family: "spaces",
          namespace_root: spacesRoot,
          handle_label: "charizardfan",
          owner_persona_id: buyer.personaId,
          recipient: binding,
          issuance_operation_id: "issuance:spaces-native:claim-a",
          claim_request_hash: claimRow.request_hash,
        }).sha256,
      );
      expect(
        (
          await admin.query(
            "SELECT * FROM handle_key_fences WHERE family='spaces' AND handle_label='charizardfan'",
          )
        ).rows[0],
      ).toMatchObject({
        live_reservation_id: null,
        permanent_grant_id: null,
        pending_claim_id: "claim-a",
        external_conflict_observation_id: null,
      });
      expect(
        (await admin.query("SELECT * FROM handle_account_offering_grant_counters")).rows,
      ).toMatchObject([
        {
          account_id: "member-a",
          offering_id: offeringId,
          active_grant_count: "0",
          pending_issuance_count: "1",
        },
      ]);
      expect((await admin.query("SELECT * FROM spaces_registry_items")).rows).toMatchObject([
        {
          claim_id: "claim-a",
          issuance_operation_id: "issuance:spaces-native:claim-a",
          network: "regtest",
          handle: `charizardfan@${spacesRoot}`,
          script_pubkey_hex: recipient,
          state: "undelivered",
        },
      ]);
      expect((await admin.query("SELECT * FROM spaces_issuance_verifications")).rows).toMatchObject(
        [{ claim_id: "claim-a", status: "pending", verification_due: false, attempt_count: "0" }],
      );
      expect(await count(admin, "handle_reservations", "status='consumed'")).toBe(1);
      expect(await count(admin, "handle_grants")).toBe(0);

      // Replay and the owner read return the same private pending claim.
      const replay = await Effect.runPromise(
        store.submitFreeClaim(claimInput(buyer, reservation, "a")),
      );
      expect(replay).toEqual({ claim, replayed: true });
      expect(
        await Effect.runPromise(store.getClaim({ accountId: "member-a", claimId: "claim-a" })),
      ).toEqual(claim);
      expect(
        await Effect.runPromise(store.getClaim({ accountId: seller, claimId: "claim-a" })),
      ).toBeNull();

      // Nothing public changes before a grant exists.
      expect(
        await Effect.runPromise(store.listPersonaGrants({ personaId: buyer.personaId })),
      ).toEqual({ items: [], next_cursor: null });
      expect(
        (await Effect.runPromise(store.getPublicPersona({ personaId: buyer.personaId })))
          ?.handle_grants,
      ).toEqual([]);
      expect(
        await Effect.runPromise(
          store.getPublicGrant({
            family: "spaces",
            namespaceRoot: spacesRoot,
            handleLabel: "charizardfan",
          }),
        ),
      ).toBeNull();

      // `delayed` follows a funding pause of the space and the overdue mark.
      const spaces = spacesStore(connection);
      await Effect.runPromise(
        spaces.recordFundingObservation({
          operatorAssignmentId: "spaces_operator_assignment_01",
          operatorAssignmentGeneration: 1,
          observedAt: new Date(Date.now() - 2_000).toISOString(),
          confirmedBalanceSats: "100",
          nextCommitFeeSats: "12000",
        }),
      );
      const paused = spacesClaim(
        await Effect.runPromise(store.getClaim({ accountId: "member-a", claimId: "claim-a" })),
      );
      expect(paused).toMatchObject({ state: "issuance_pending", delayed: true });
      // The member never sees the reason, the balance, or any wallet fact.
      expect(Object.keys(paused).sort()).toEqual(Object.keys(claim).sort());
      await Effect.runPromise(
        spaces.recordFundingObservation({
          operatorAssignmentId: "spaces_operator_assignment_01",
          operatorAssignmentGeneration: 1,
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          confirmedBalanceSats: "50000",
          nextCommitFeeSats: "12000",
        }),
      );
      expect(
        spacesClaim(
          await Effect.runPromise(store.getClaim({ accountId: "member-a", claimId: "claim-a" })),
        ).delayed,
      ).toBe(false);
      await admin.query(
        `UPDATE spaces_issuance_verifications
            SET overdue_marked_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE claim_id='claim-a'`,
      );
      expect(
        spacesClaim(
          await Effect.runPromise(store.getClaim({ accountId: "member-a", claimId: "claim-a" })),
        ).delayed,
      ).toBe(true);

      // A pending key is unavailable to every other buyer.
      const rival = await seedBuyer(admin, "member-rival");
      await confirmLink(store, rival, "rival");
      expect(
        await failureOf(store.createQuote(quoteInput(rival, "charizardfan", "rival"))),
      ).toEqual(rejected("handle_unavailable"));
    });
    completed++;
  }, 60_000);

  test("refuses at claim a membership that ended after the quote and keeps a claim whose membership ends later", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);

      // Membership ends between quote and claim.
      const leaver = await seedBuyer(admin, "leaver");
      const leaving = await reserved(store, leaver, "leaverlabel", "leaver");
      await setMembership(admin, "leaver", "left");
      const before = await snapshot(admin);
      expect(
        await failureOf(store.submitFreeClaim(claimInput(leaver, leaving.reservation, "leaver"))),
      ).toEqual(rejected("qualification_unsatisfied"));
      expect(await snapshot(admin)).toEqual(before);
      expect(await count(admin, "handle_reservations", "status='reserved'")).toBe(1);

      // A sibling persona of a member account is accepted.
      const member = await seedBuyer(admin, "sibling-account", { taproot: false });
      await createActivePersonaFixture(admin, {
        accountId: "sibling-account",
        personaId: "persona-sibling-b",
      });
      const sibling = { accountId: "sibling-account", personaId: "persona-sibling-b" };
      await bindPersonaToCommunity(admin, { ...sibling, communityId });
      await addTaproot(admin, { ...sibling, assignmentId: "taproot-sibling-b" });
      expect(member.personaId).not.toBe(sibling.personaId);
      const siblingReserved = await reserved(store, sibling, "siblinglabel", "sibling");
      const claim = spacesClaim(
        (
          await Effect.runPromise(
            store.submitFreeClaim(claimInput(sibling, siblingReserved.reservation, "sibling")),
          )
        ).claim,
      );
      expect(claim).toMatchObject({
        state: "issuance_pending",
        owner_persona_id: sibling.personaId,
      });

      // Losing membership after submission changes community privileges only.
      const pendingState = async () => ({
        claim: (
          await admin.query(
            "SELECT state,safe_reason,updated_at FROM handle_claims WHERE claim_id='claim-sibling'",
          )
        ).rows,
        item: (await admin.query("SELECT state,updated_at FROM spaces_registry_items")).rows,
        fence: (
          await admin.query(
            "SELECT pending_claim_id FROM handle_key_fences WHERE handle_label='siblinglabel'",
          )
        ).rows,
        counter: (
          await admin.query(
            "SELECT pending_issuance_count FROM handle_account_offering_grant_counters WHERE account_id='sibling-account'",
          )
        ).rows,
      });
      const beforeLeave = await pendingState();
      await setMembership(admin, "sibling-account", "left");
      expect(await pendingState()).toEqual(beforeLeave);
      expect(
        await Effect.runPromise(
          store.getClaim({ accountId: "sibling-account", claimId: "claim-sibling" }),
        ),
      ).toEqual(claim);
    });
    completed++;
  }, 60_000);

  test("refuses a reservation or claim whose recipient changed after the quote", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);

      // Changed between quote and reservation.
      const early = await seedBuyer(admin, "early-change");
      const earlyQuote = await quoted(store, early, "earlylabel", "early");
      await tombstoneTaproot(admin, "taproot-early-change");
      await addTaproot(admin, { ...early, assignmentId: "taproot-early-change-2" });
      expect(
        await failureOf(store.createReservation(reservationInput(early, earlyQuote, "early"))),
      ).toEqual(rejected("persona_unavailable"));
      expect(await count(admin, "handle_reservations")).toBe(0);

      // Changed between reservation and claim.
      const late = await seedBuyer(admin, "late-change");
      const lateReserved = await reserved(store, late, "latelabel", "late");
      await tombstoneTaproot(admin, "taproot-late-change");
      await addTaproot(admin, { ...late, assignmentId: "taproot-late-change-2" });
      const before = await snapshot(admin);
      expect(
        await failureOf(store.submitFreeClaim(claimInput(late, lateReserved.reservation, "late"))),
      ).toEqual(rejected("persona_unavailable"));
      expect(await snapshot(admin)).toEqual(before);

      // The database guard refuses the same stale recipient.
      await expect(
        admin.query(
          `INSERT INTO handle_claims (
             claim_id,request_hash,actor_account_id,owner_persona_id,offering_id,offering_hash,
             quote_id,reservation_id,reservation_hash,sale_namespace_activation_id,
             sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
             handle_label,display_identifier,pricing_revision,pricing_hash,atomic_amount,
             payment_status,state,safe_reason,issuance_operation_id,grant_finalize_hash,grant_id,
             created_at,updated_at,recipient_kind,recipient_network,
             recipient_taproot_assignment_id,recipient_script_pubkey_hex
           ) SELECT 'claim-stale',repeat('1',64),reservation.actor_account_id,
                    reservation.owner_persona_id,reservation.offering_id,reservation.offering_hash,
                    reservation.quote_id,reservation.reservation_id,reservation.reservation_hash,
                    reservation.sale_namespace_activation_id,
                    reservation.sale_namespace_activation_generation,'spaces_native_v1','spaces',
                    reservation.namespace_root,reservation.handle_label,quote.display_identifier,
                    quote.pricing_revision,quote.pricing_hash,0,'not_applicable',
                    'issuance_pending','issuance_pending','issuance:spaces-native:claim-stale',
                    repeat('2',64),NULL,clock_timestamp(),clock_timestamp(),
                    reservation.recipient_kind,reservation.recipient_network,
                    reservation.recipient_taproot_assignment_id,
                    reservation.recipient_script_pubkey_hex
               FROM handle_reservations AS reservation
               JOIN handle_quotes AS quote ON quote.quote_id=reservation.quote_id
              WHERE reservation.reservation_id='reservation-late'`,
        ),
      ).rejects.toThrow("recipient changed since its reservation");

      // A fresh quote binds the new recipient and proceeds.
      const fresh = await reserved(store, late, "latelabel2", "late-2");
      expect(fresh.quote.recipient.script_pubkey_hex).toBe(
        (
          await admin.query(
            "SELECT output_script_hex FROM persona_wallet_assignments WHERE assignment_id='taproot-late-change-2'",
          )
        ).rows[0]?.output_script_hex,
      );
    });
    completed++;
  }, 60_000);

  test("admits exactly one reservation and one pending claim for a contended label", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const contenders = [
        await seedBuyer(admin, "contender-a"),
        await seedBuyer(admin, "contender-b"),
      ];
      const quotes = [];
      for (const contender of contenders) {
        quotes.push({
          contender,
          quote: await quoted(store, contender, "contended", contender.accountId),
        });
      }
      const reservations = await Promise.allSettled(
        quotes.map(({ contender, quote }) =>
          Effect.runPromise(
            salesStore(connection).createReservation(
              reservationInput(contender, quote, contender.accountId),
            ),
          ).then((result) => ({ contender, reservation: result.reservation })),
        ),
      );
      const winners = reservations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(winners).toHaveLength(1);
      expect(
        reservations.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ).toMatchObject([{ _tag: "HandleSalesRejected", reason: "handle_unavailable" }]);
      const winner = winners[0];
      if (winner === undefined) throw new Error("missing reservation winner");

      const claims = await Promise.allSettled(
        ["one", "two", "three"].map((key) =>
          Effect.runPromise(
            salesStore(connection).submitFreeClaim(
              claimInput(winner.contender, winner.reservation, `race-${key}`),
            ),
          ),
        ),
      );
      expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(await count(admin, "handle_claims", "state='issuance_pending'")).toBe(1);
      expect(await count(admin, "spaces_registry_items")).toBe(1);
      expect(await count(admin, "spaces_issuance_verifications")).toBe(1);
      expect(
        Number(
          (
            await admin.query(
              "SELECT sum(pending_issuance_count)::int AS n FROM handle_account_offering_grant_counters",
            )
          ).rows[0]?.n,
        ),
      ).toBe(1);
      expect(
        await count(
          admin,
          "handle_key_fences",
          "handle_label='contended' AND pending_claim_id IS NOT NULL",
        ),
      ).toBe(1);
      // No new reservation can take the key while it is pending.
      const loser = contenders.find((contender) => contender !== winner.contender);
      if (loser === undefined) throw new Error("missing loser");
      expect(
        await failureOf(store.createQuote(quoteInput(loser, "contended", "after-pending"))),
      ).toEqual(rejected("handle_unavailable"));
    });
    completed++;
  }, 60_000);

  test("reserves the account cap for a pending claim across sibling personas", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection, { cap: 1 });
      const store = salesStore(connection);
      const first = await seedBuyer(admin, "cap-account");
      await createActivePersonaFixture(admin, {
        accountId: "cap-account",
        personaId: "persona-cap-b",
      });
      const second = { accountId: "cap-account", personaId: "persona-cap-b" };
      await bindPersonaToCommunity(admin, { ...second, communityId });
      await addTaproot(admin, { ...second, assignmentId: "taproot-cap-b" });

      const firstReserved = await reserved(store, first, "capalphalabel", "cap-a");
      const secondReserved = await reserved(store, second, "capbravolabel", "cap-b");
      const contenders = [
        { buyer: first, reservation: firstReserved.reservation, key: "cap-a" },
        { buyer: second, reservation: secondReserved.reservation, key: "cap-b" },
      ];
      const race = await Promise.allSettled(
        contenders.map(({ buyer, reservation, key }) =>
          Effect.runPromise(
            salesStore(connection).submitFreeClaim(claimInput(buyer, reservation, key)),
          ),
        ),
      );
      expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(
        race.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ).toMatchObject([{ _tag: "HandleSalesRejected", reason: "account_grant_limit_reached" }]);
      expect(await count(admin, "handle_claims")).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT active_grant_count,pending_issuance_count FROM handle_account_offering_grant_counters",
          )
        ).rows,
      ).toEqual([{ active_grant_count: "0", pending_issuance_count: "1" }]);

      // The pending slot also closes new quotes for every persona of the account.
      for (const [buyer, key] of [
        [first, "cap-a-2"],
        [second, "cap-b-2"],
      ] as const) {
        await confirmLink(store, buyer, key);
        expect(
          await failureOf(
            store.createQuote(quoteInput(buyer, `${key.replace(/-/gu, "")}label`, key)),
          ),
        ).toEqual(rejected("account_grant_limit_reached"));
      }
    });
    completed++;
  }, 60_000);

  test("creates the claim and its registry item atomically and rolls back both on failure", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const buyer = await seedBuyer(admin, "atomic-member");
      const { reservation } = await reserved(store, buyer, "atomiclabel", "atomic");
      const before = await snapshot(admin);
      const fenceBefore = (
        await admin.query("SELECT * FROM handle_key_fences WHERE handle_label='atomiclabel'")
      ).rows;
      await admin.query(
        `CREATE FUNCTION inject_registry_failure_v1() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected registry insert failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER inject_registry_failure BEFORE INSERT ON spaces_registry_items
         FOR EACH ROW EXECUTE FUNCTION inject_registry_failure_v1()`,
      );
      expect(
        await failureOf(store.submitFreeClaim(claimInput(buyer, reservation, "atomic"))),
      ).toBeInstanceOf(HandleSalesStorageFailed);
      expect(await snapshot(admin)).toEqual(before);
      expect(
        (await admin.query("SELECT * FROM handle_key_fences WHERE handle_label='atomiclabel'"))
          .rows,
      ).toEqual(fenceBefore);
      expect(await count(admin, "handle_reservations", "status='reserved'")).toBe(1);
      expect(await count(admin, "handle_claim_actions")).toBe(0);

      await admin.query("DROP TRIGGER inject_registry_failure ON spaces_registry_items");
      const claim = spacesClaim(
        (await Effect.runPromise(store.submitFreeClaim(claimInput(buyer, reservation, "atomic"))))
          .claim,
      );
      expect(claim.state).toBe("issuance_pending");
      expect(await count(admin, "spaces_registry_items")).toBe(1);
      expect(await count(admin, "spaces_issuance_verifications")).toBe(1);
    });
    completed++;
  }, 60_000);

  test("keeps Spaces fence, claim, registry, and grant shapes checked and HNS claims immutable", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = salesStore(connection);
      const buyer = await seedBuyer(admin, "shape-member");
      const { reservation } = await reserved(store, buyer, "shapelabel", "shape");
      await Effect.runPromise(store.submitFreeClaim(claimInput(buyer, reservation, "shape")));

      // Fence states: Spaces-only, exactly one, and keyed to the fence's own label.
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO handle_key_fences (family,namespace_root,handle_label,pending_claim_id,updated_at)
             VALUES ('hns','charizard','shapelabel','claim-shape',clock_timestamp())`,
          ),
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          admin.query(
            `UPDATE handle_key_fences SET live_reservation_id='reservation-shape'
              WHERE handle_label='shapelabel'`,
          ),
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO handle_key_fences (family,namespace_root,handle_label,pending_claim_id,updated_at)
             VALUES ('spaces','charizard','otherlabel','claim-shape',clock_timestamp())`,
          ),
        ),
      ).toBe("23503");
      expect(
        await sqlState(
          admin.query(
            `INSERT INTO spaces_external_conflict_observations (
               observation_id,family,network,namespace_root,handle_label,evidence_kind,observed_at
             ) VALUES ('conflict-1','spaces','regtest','charizard','conflictlabel',
                       'registry_acknowledgment_v1',clock_timestamp())`,
          ),
        ),
      ).toBe("23514");

      // A quote's recipient is immutable, and the HNS shape never carries one.
      await expect(
        admin.query(
          "UPDATE handle_quotes SET recipient_script_pubkey_hex='5120' || repeat('7',64) WHERE quote_id='quote-shape'",
        ),
      ).rejects.toThrow("handle quote transition is invalid");
      await admin.query("SET session_replication_role = replica");
      for (const table of ["handle_quotes", "handle_reservations", "handle_claims"]) {
        const key =
          table === "handle_quotes"
            ? "quote_id"
            : table === "handle_reservations"
              ? "reservation_id"
              : "claim_id";
        const source =
          table === "handle_quotes"
            ? "quote-shape"
            : table === "handle_reservations"
              ? "reservation-shape"
              : "claim-shape";
        expect(
          await sqlState(
            admin.query(
              `INSERT INTO ${table}
                 SELECT (jsonb_populate_record(NULL::${table},
                   to_jsonb(source_row) || jsonb_build_object(
                     '${key}','hns-with-recipient','family','hns',
                     'fulfillment_kind','hosted_persona_v1',
                     'issuance_operation_id','issuance:hns-hosted:hns-with-recipient'))).*
                 FROM ${table} AS source_row WHERE ${key}='${source}'`,
            ),
          ),
          table,
        ).toBe("23514");
      }
      await admin.query("SET session_replication_role = origin");

      // Claim changes: identity and recipient immutable, one terminal move, no delete.
      for (const change of [
        "owner_persona_id=owner_persona_id || '-x'",
        "recipient_script_pubkey_hex='5120' || repeat('9',64)",
        "grant_finalize_hash=repeat('3',64)",
        "issuance_operation_id='issuance:spaces-native:other'",
      ]) {
        expect(
          await sqlState(
            admin.query(`UPDATE handle_claims SET ${change} WHERE claim_id='claim-shape'`),
          ),
          change,
        ).toBeDefined();
      }
      await expect(
        admin.query(
          "UPDATE handle_claims SET handle_label='shapelabel' WHERE claim_id='claim-shape'",
        ),
      ).rejects.toThrow("Spaces handle claim transition is invalid");
      await expect(
        admin.query("DELETE FROM handle_claims WHERE claim_id='claim-shape'"),
      ).rejects.toThrow("handle claim cannot be deleted");
      // No Spaces grant exists before final issuance evidence, so issued cannot commit.
      expect(
        await sqlState(
          admin.query(
            `UPDATE handle_claims SET state='issued',safe_reason=NULL,grant_id='grant-shape',
                    updated_at=clock_timestamp()
              WHERE claim_id='claim-shape'`,
          ),
        ),
      ).toBe("23503");
      await expect(
        admin.query(
          `INSERT INTO handle_grants (
             grant_id,grant_generation,community_id,offering_id,offering_hash,claim_id,
             owner_account_id,owner_persona_id,sale_namespace_activation_id,
             sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
             handle_label,display_identifier,status,issued_at,updated_at,recipient_kind,
             recipient_network,recipient_taproot_assignment_id,recipient_script_pubkey_hex
           ) SELECT 'grant-shape',1,$1,claim.offering_id,claim.offering_hash,claim.claim_id,
                    claim.actor_account_id,claim.owner_persona_id,
                    claim.sale_namespace_activation_id,claim.sale_namespace_activation_generation,
                    claim.fulfillment_kind,claim.family,claim.namespace_root,claim.handle_label,
                    claim.display_identifier,'active',claim.created_at,claim.created_at,
                    claim.recipient_kind,claim.recipient_network,
                    claim.recipient_taproot_assignment_id,claim.recipient_script_pubkey_hex
               FROM handle_claims AS claim WHERE claim.claim_id='claim-shape'`,
          [communityId],
        ),
      ).rejects.toThrow("requires matching final issuance evidence");

      // Registry items move forward only; a delivered item is never withdrawn.
      const registry = registryStore(connection);
      const registryAuth = await registryCredential(connection);
      const delivered = await Effect.runPromise(
        registry.pending({
          credential: registryAuth.authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      expect(delivered.kind === "handles" && delivered.handles.length === 1).toBe(true);
      for (const state of ["withdrawn", "undelivered"]) {
        await expect(
          admin.query(`UPDATE spaces_registry_items SET state='${state}'`),
          state,
        ).rejects.toThrow("Spaces registry item transition is invalid");
      }
      await expect(admin.query("DELETE FROM spaces_registry_items")).rejects.toThrow(
        "cannot be deleted",
      );
      await expect(
        admin.query("UPDATE spaces_registry_items SET script_pubkey_hex='5120' || repeat('8',64)"),
      ).rejects.toThrow("Spaces registry item transition is invalid");

      // A pending claim fails terminally once; it never returns to pending.
      await admin.query(
        `UPDATE handle_claims SET state='issuance_failed',safe_reason='issuance_failed',
                updated_at=clock_timestamp()
          WHERE claim_id='claim-shape'`,
      );
      await expect(
        admin.query(
          `UPDATE handle_claims SET state='issuance_pending',safe_reason='issuance_pending'
            WHERE claim_id='claim-shape'`,
        ),
      ).rejects.toThrow("Spaces handle claim transition is invalid");
      expect(
        spacesClaim(
          await Effect.runPromise(
            store.getClaim({ accountId: "shape-member", claimId: "claim-shape" }),
          ),
        ),
      ).toMatchObject({ state: "issuance_failed", delayed: false, safe_reason: "issuance_failed" });
    });
    completed++;
  }, 60_000);

  test("still issues an HNS handle synchronously to a nonmember under none_v1", async () => {
    await withSchema(async (admin, connection) => {
      await seedAccount(admin, "hns-seller");
      const buyerPersona = await seedAccount(admin, "hns-nonmember", { humanEvidence: false });
      const hnsCommunity = "community_00000000-0000-4000-8000-00000000b002";
      const hnsActivation = await seedSaleNamespace(admin, "hns-seller", hnsCommunity);
      await bindPersonaToCommunity(admin, {
        accountId: "hns-nonmember",
        communityId: hnsCommunity,
        personaId: buyerPersona,
      });
      expect(await count(admin, "community_memberships", "user_id='hns-nonmember'")).toBe(0);
      const key = (byte: number): string =>
        btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/u, "");
      const vault = makeHandleRecipientTokenVault({
        hmacKeys: `h1:${key(31)}`,
        envelopeKeys: `e1:${key(32)}`,
      });
      let sequence = 0;
      const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(IdGen, {
              next: Effect.sync(() => `${++sequence}`.padStart(4, "0")),
            }),
            Effect.provideService(HandleRecipientTokenVault, vault),
          ),
        );
      const sales = makeHandleSalesService(salesStore(connection));
      const offering = await run(
        sales.createOffering({
          accountId: "hns-seller",
          communityId: hnsCommunity,
          idempotencyKey: "hns-offering",
          terms: terms(hnsActivation),
        }),
      );
      expect(offering.offering.qualification_policy.kind).toBe("none_v1");
      await run(
        sales.confirmPersonaReuse({
          accountId: "hns-nonmember",
          personaId: buyerPersona,
          offeringId: offering.offering.offering_id,
          idempotencyKey: "hns-link",
        }),
      );
      const quote = await run(
        sales.createQuote({
          accountId: "hns-nonmember",
          personaId: buyerPersona,
          offeringId: offering.offering.offering_id,
          desiredLabel: "hnsnonmember",
          idempotencyKey: "hns-quote",
        }),
      );
      if (quote.kind !== "quoted") throw new Error("expected an HNS quote");
      expect(quote.quote.fulfillment.kind).toBe("hosted_persona_v1");
      const reservation = await run(
        sales.createReservation({
          accountId: "hns-nonmember",
          personaId: buyerPersona,
          quoteId: quote.quote.quote_id,
          expectedQuoteHash: quote.quote.quote_hash,
          idempotencyKey: "hns-reservation",
        }),
      );
      const claim = await run(
        sales.submitFreeClaim({
          accountId: "hns-nonmember",
          personaId: buyerPersona,
          reservationId: reservation.reservation.reservation_id,
          expectedReservationHash: reservation.reservation.reservation_hash,
          idempotencyKey: "hns-claim",
        }),
      );
      expect(claim.claim).toMatchObject({
        state: "issued",
        display_identifier: "hnsnonmember.charizard",
        grant: { status: "active", owner_persona_id: buyerPersona },
      });
      expect("delayed" in claim.claim).toBe(false);
      const row = (
        await admin.query("SELECT * FROM handle_claims WHERE claim_id=$1", [claim.claim.claim_id])
      ).rows[0];
      expect(row).toMatchObject({
        family: "hns",
        issuance_operation_id: `issuance:hns-hosted:${claim.claim.claim_id}`,
        recipient_kind: null,
        recipient_network: null,
        recipient_taproot_assignment_id: null,
        recipient_script_pubkey_hex: null,
      });
      expect(
        (
          await admin.query(
            "SELECT live_reservation_id,pending_claim_id,external_conflict_observation_id FROM handle_key_fences WHERE family='hns'",
          )
        ).rows,
      ).toEqual([
        {
          live_reservation_id: null,
          pending_claim_id: null,
          external_conflict_observation_id: null,
        },
      ]);
      expect(await count(admin, "spaces_registry_items")).toBe(0);
      await expect(
        admin.query("UPDATE handle_claims SET updated_at=clock_timestamp() WHERE family='hns'"),
      ).rejects.toThrow("HNS handle claim is immutable");
      const persona = await Effect.runPromise(
        salesStore(connection).getPublicPersona({ personaId: buyerPersona }),
      );
      expect(persona?.handle_grants.map((grant) => grant.display_identifier)).toEqual([
        "hnsnonmember.charizard",
      ]);
    });
    completed++;
  }, 60_000);
});

suite("Spaces private registry delivery and settlement", () => {
  test("records delivery before returning a page, accepts a repeat ack, and only schedules verification", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "registrysame", "registry-same");
      const store = registryStore(connection);
      const { authenticated } = await registryCredential(connection);
      const page = await Effect.runPromise(
        store.pending({
          credential: authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      expect(page.kind).toBe("handles");
      if (page.kind !== "handles") throw new Error("expected registry page");
      expect(page.handles).toHaveLength(1);
      const handle = page.handles[0]?.handle;
      if (!handle) throw new Error("missing delivered handle");
      expect(
        await count(admin, "spaces_registry_deliveries", "claim_id=$1", [claim.claim_id]),
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT state,delivery_generation FROM spaces_registry_items WHERE claim_id=$1",
            [claim.claim_id],
          )
        ).rows[0],
      ).toMatchObject({ state: "delivered", delivery_generation: "1" });
      const ack = { kind: "outcome" as const, handle, outcome: "staged" as const };
      expect(
        await Effect.runPromise(store.acknowledge({ credential: authenticated, entry: ack })),
      ).toBe("applied");
      expect(
        await Effect.runPromise(store.acknowledge({ credential: authenticated, entry: ack })),
      ).toBe("unchanged");
      expect(
        await count(admin, "spaces_registry_acknowledgments", "claim_id=$1", [claim.claim_id]),
      ).toBe(1);
      expect(
        await count(admin, "spaces_registry_occupancy_observations", "handle_label='registrysame'"),
      ).toBe(1);
      expect(
        await Effect.runPromise(
          store.committed({
            credential: authenticated,
            commitment_root_hex: "d".repeat(64),
            handles: [handle],
          }),
        ),
      ).toEqual(["unchanged"]);
      expect(
        (
          await admin.query(
            "SELECT verification_due FROM spaces_issuance_verifications WHERE claim_id=$1",
            [claim.claim_id],
          )
        ).rows[0]?.verification_due,
      ).toBe(true);
      expect(await count(admin, "handle_grants", "claim_id=$1", [claim.claim_id])).toBe(0);
      expect(
        (await admin.query("SELECT state FROM handle_claims WHERE claim_id=$1", [claim.claim_id]))
          .rows[0]?.state,
      ).toBe("issuance_pending");
    });
    completed++;
  }, 60_000);

  test("different recipient evidence fails the claim and keeps a permanent conflict fence", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "registryconflict", "registry-conflict");
      const store = registryStore(connection);
      const { authenticated } = await registryCredential(connection);
      const page = await Effect.runPromise(
        store.pending({
          credential: authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      if (page.kind !== "handles" || !page.handles[0]) throw new Error("missing registry item");
      expect(
        await Effect.runPromise(
          store.acknowledge({
            credential: authenticated,
            entry: {
              kind: "outcome",
              handle: page.handles[0].handle,
              outcome: "already_committed_different_spk",
            },
          }),
        ),
      ).toBe("applied");
      expect(
        (
          await admin.query("SELECT state,safe_reason FROM handle_claims WHERE claim_id=$1", [
            claim.claim_id,
          ])
        ).rows[0],
      ).toMatchObject({ state: "issuance_failed", safe_reason: "handle_unavailable" });
      expect(
        (
          await admin.query(
            "SELECT pending_claim_id,external_conflict_observation_id FROM handle_key_fences WHERE handle_label='registryconflict'",
          )
        ).rows[0],
      ).toMatchObject({
        pending_claim_id: null,
        external_conflict_observation_id: expect.any(String),
      });
      expect(
        await count(
          admin,
          "spaces_external_conflict_observations",
          "registry_acknowledgment_id IS NOT NULL",
        ),
      ).toBe(1);
      expect(await count(admin, "handle_grants", "claim_id=$1", [claim.claim_id])).toBe(0);
    });
    completed++;
  }, 60_000);

  test("stops undelivered work without sending it, but preserves a delivered fence", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection, { cap: 2 });
      const first = await registryClaim(admin, connection, "registryearly", "registry-early");
      const second = await registryClaim(admin, connection, "registrylate", "registry-late");
      const store = registryStore(connection);
      expect(await Effect.runPromise(store.stopClaim({ claimId: first.claim_id }))).toEqual({
        kind: "withdrawn",
      });
      expect(
        await count(admin, "spaces_registry_deliveries", "claim_id=$1", [first.claim_id]),
      ).toBe(0);
      expect(await count(admin, "handle_key_fences", "handle_label='registryearly'")).toBe(0);
      const { authenticated } = await registryCredential(connection);
      const page = await Effect.runPromise(
        store.pending({
          credential: authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      if (page.kind !== "handles") throw new Error("expected registry page");
      expect(page.handles).toHaveLength(1);
      expect(await Effect.runPromise(store.stopClaim({ claimId: second.claim_id }))).toEqual({
        kind: "redelivery_stopped",
      });
      expect(
        await count(
          admin,
          "handle_key_fences",
          "handle_label='registrylate' AND pending_claim_id=$1",
          [second.claim_id],
        ),
      ).toBe(1);
      expect(await Effect.runPromise(store.stopClaim({ claimId: second.claim_id }))).toEqual({
        kind: "unchanged",
      });
      const empty = await Effect.runPromise(
        store.pending({
          credential: authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      expect(empty).toEqual({ kind: "handles", handles: [] });
    });
    completed++;
  }, 60_000);

  test("refuses wrong environment and unassigned spaces while recording a scope anomaly", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const store = registryStore(connection);
      const credential = await registryCredential(connection);
      expect(
        await Effect.runPromise(
          store.authenticate({ token: credential.token, environment: "production" }),
        ),
      ).toBeNull();
      expect(
        await Effect.runPromise(
          store.authenticate({ token: `${credential.token}x`, environment: "development" }),
        ),
      ).toBeNull();
      expect(
        await Effect.runPromise(
          store.pending({
            credential: credential.authenticated,
            space: { kind: "numeric", raw: "#2" },
            capacity: 10,
          }),
        ),
      ).toEqual({ kind: "forbidden" });
      expect(await count(admin, "spaces_registry_scope_anomalies", "reason='numeric_space'")).toBe(
        1,
      );
      expect(
        await Effect.runPromise(
          store.acknowledge({
            credential: credential.authenticated,
            entry: { kind: "outcome", handle: `notthere@${spacesRoot}`, outcome: "staged" },
          }),
        ),
      ).toBe("anomaly");
      expect(
        await count(admin, "spaces_registry_scope_anomalies", "reason='no_delivered_item'"),
      ).toBe(1);
    });
    completed++;
  }, 60_000);

  test("fences a callback from an old assignment generation and revokes a rotated credential", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "registrystale", "registry-stale");
      const store = registryStore(connection);
      const first = await registryCredential(connection);
      const page = await Effect.runPromise(
        store.pending({
          credential: first.authenticated,
          space: { kind: "root", canonical_root: spacesRoot },
          capacity: 10,
        }),
      );
      if (page.kind !== "handles" || !page.handles[0]) throw new Error("missing delivery");
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: "spaces_operator_assignment_01",
        generation: 2,
        delegationAddress: delegation,
      });
      expect(
        await Effect.runPromise(
          store.acknowledge({
            credential: first.authenticated,
            entry: { kind: "outcome", handle: page.handles[0].handle, outcome: "staged" },
          }),
        ),
      ).toBe("stale");
      expect(
        await count(admin, "spaces_registry_acknowledgments", "claim_id=$1", [claim.claim_id]),
      ).toBe(0);
      expect(
        (await admin.query("SELECT state FROM handle_claims WHERE claim_id=$1", [claim.claim_id]))
          .rows[0]?.state,
      ).toBe("issuance_pending");
      const rotated = await registryCredential(connection);
      expect(rotated.retired_credential_id).toBeNull();
      expect(rotated.revoked_credential_ids).toContain(first.credential_id);
      expect(
        await Effect.runPromise(
          store.authenticate({ token: first.token, environment: "development" }),
        ),
      ).toBeNull();
      expect(
        await Effect.runPromise(
          store.authenticate({ token: rotated.token, environment: "development" }),
        ),
      ).not.toBeNull();
    });
    completed++;
  }, 60_000);
});

suite("Spaces final issuance reconciliation", () => {
  const finalEvidence = () => ({
    certificate_sha256_hex: "a".repeat(64),
    commitment_txid_hex: "b".repeat(64),
    commitment_root_hex: "c".repeat(64),
    mined_height: 100,
    verified_tip_height: 245,
    verifier_id: "independent-regtest-verifier",
    verifier_version: "fixture-v1",
    observed_at: new Date(Date.now() - 1_000).toISOString(),
  });

  test("leases a claim without callbacks and finalizes evidence, grant, fence and cap once", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "verifiedname", "verified-name");
      const store = reconciliationStore(connection);
      const due = await Effect.runPromise(store.leaseDue(8));
      expect(due).toHaveLength(1);
      const target = due[0];
      if (target === undefined) throw new Error("missing due claim");
      expect(target.claim_id).toBe(claim.claim_id);
      expect(await Effect.runPromise(store.finalize(target, finalEvidence()))).toBe("issued");
      expect(await Effect.runPromise(store.finalize(target, finalEvidence()))).toBe("stale");
      expect(await Effect.runPromise(store.leaseDue(8))).toEqual([]);
      expect(
        (
          await admin.query("SELECT state,grant_id FROM handle_claims WHERE claim_id=$1", [
            claim.claim_id,
          ])
        ).rows[0],
      ).toMatchObject({ state: "issued", grant_id: expect.any(String) });
      expect(
        (
          await admin.query("SELECT state FROM spaces_registry_items WHERE claim_id=$1", [
            claim.claim_id,
          ])
        ).rows[0]?.state,
      ).toBe("withdrawn");
      expect(
        (
          await admin.query(
            "SELECT status,lease_token FROM spaces_issuance_verifications WHERE claim_id=$1",
            [claim.claim_id],
          )
        ).rows[0],
      ).toMatchObject({ status: "verified", lease_token: null });
      expect(
        await count(admin, "spaces_final_issuance_evidence", "claim_id=$1", [claim.claim_id]),
      ).toBe(1);
      expect(
        await count(
          admin,
          "handle_grants",
          "claim_id=$1 AND spaces_final_evidence_id IS NOT NULL",
          [claim.claim_id],
        ),
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT pending_issuance_count,active_grant_count FROM handle_account_offering_grant_counters WHERE offering_id=$1",
            [offeringId],
          )
        ).rows[0],
      ).toMatchObject({ pending_issuance_count: "0", active_grant_count: "1" });
      const publicGrant = await Effect.runPromise(
        salesStore(connection).getPublicGrant({
          family: "spaces",
          namespaceRoot: spacesRoot,
          handleLabel: "verifiedname",
        }),
      );
      expect(publicGrant?.host).toEqual({ kind: "not_applicable" });
    });
    completed++;
  }, 60_000);

  test("refuses non-final heights and stale leases without writing a grant", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "leasefenced", "lease-fenced");
      const store = reconciliationStore(connection);
      const first = (await Effect.runPromise(store.leaseDue(8)))[0];
      if (first === undefined) throw new Error("missing first lease");
      expect(
        await failureOf(store.finalize(first, { ...finalEvidence(), verified_tip_height: 244 })),
      ).toMatchObject({ reason: "invalid-row" });
      await admin.query(
        `UPDATE spaces_issuance_verifications
            SET leased_until=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()
          WHERE claim_id=$1`,
        [claim.claim_id],
      );
      const second = (await Effect.runPromise(store.leaseDue(8)))[0];
      if (second === undefined) throw new Error("missing second lease");
      expect(second.lease_token).not.toBe(first.lease_token);
      expect(await Effect.runPromise(store.finalize(first, finalEvidence()))).toBe("stale");
      expect(await count(admin, "handle_grants", "claim_id=$1", [claim.claim_id])).toBe(0);
      expect(await Effect.runPromise(store.retryLater(second))).toBe("scheduled");
    });
    completed++;
  }, 60_000);

  test("a verified final name held by another script becomes a permanent conflict", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "otherowner", "other-owner");
      const store = reconciliationStore(connection);
      const target = (await Effect.runPromise(store.leaseDue(8)))[0];
      if (target === undefined) throw new Error("missing due claim");
      expect(
        await Effect.runPromise(
          store.recordConflict(target, `5120${"2".repeat(64)}`, finalEvidence()),
        ),
      ).toBe("conflict");
      expect(
        (
          await admin.query("SELECT state,safe_reason FROM handle_claims WHERE claim_id=$1", [
            claim.claim_id,
          ])
        ).rows[0],
      ).toMatchObject({ state: "issuance_failed", safe_reason: "handle_unavailable" });
      expect(
        (
          await admin.query(
            "SELECT pending_claim_id,external_conflict_observation_id FROM handle_key_fences WHERE family='spaces' AND namespace_root=$1 AND handle_label='otherowner'",
            [spacesRoot],
          )
        ).rows[0],
      ).toMatchObject({
        pending_claim_id: null,
        external_conflict_observation_id: expect.any(String),
      });
      expect(
        await count(admin, "spaces_final_conflict_evidence", "claim_id=$1", [claim.claim_id]),
      ).toBe(1);
      expect(await count(admin, "handle_grants", "claim_id=$1", [claim.claim_id])).toBe(0);
      expect(
        await Effect.runPromise(
          store.recordConflict(target, `5120${"2".repeat(64)}`, finalEvidence()),
        ),
      ).toBe("stale");
    });
    completed++;
  }, 60_000);

  test("marks a pending claim overdue and durably acknowledges a scope alert", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "overduename", "overdue");
      const store = reconciliationStore(connection);
      const credential = await registryCredential(connection);
      await Effect.runPromise(
        registryStore(connection).pending({
          credential: credential.authenticated,
          space: { kind: "numeric", raw: "#3" },
          capacity: 8,
        }),
      );
      const anomalies = await Effect.runPromise(store.unalertedScopeAnomalies(8));
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]?.reason).toBe("numeric_space");
      if (anomalies[0] === undefined) throw new Error("missing scope anomaly");
      await Effect.runPromise(store.markScopeAnomalyAlerted(anomalies[0].anomaly_id));
      expect(await Effect.runPromise(store.unalertedScopeAnomalies(8))).toEqual([]);
      await Bun.sleep(1_100);
      expect(await Effect.runPromise(store.markOverdue(1, 8))).toEqual([claim.claim_id]);
      expect(await Effect.runPromise(store.markOverdue(1, 8))).toEqual([]);
      expect(await Effect.runPromise(store.unalertedOverdue(8))).toEqual([claim.claim_id]);
      await Effect.runPromise(store.markOverdueAlerted(claim.claim_id));
      expect(await Effect.runPromise(store.unalertedOverdue(8))).toEqual([]);
      expect(
        (await admin.query("SELECT state FROM handle_claims WHERE claim_id=$1", [claim.claim_id]))
          .rows[0]?.state,
      ).toBe("issuance_pending");
      const read = await Effect.runPromise(
        salesStore(connection).getClaim({
          accountId: "registry-overdue",
          claimId: claim.claim_id,
        }),
      );
      expect(read?.fulfillment.kind).toBe("spaces_native_v1");
      expect(spacesClaim(read).delayed).toBe(true);
    });
    completed++;
  }, 60_000);

  test("tombstones a grant if its persona retires while issuance is pending", async () => {
    await withSchema(async (admin, connection) => {
      await seedSpacesSale(admin, connection);
      const claim = await registryClaim(admin, connection, "retiredname", "retired-name");
      const store = reconciliationStore(connection);
      const target = (await Effect.runPromise(store.leaseDue(8)))[0];
      if (target === undefined) throw new Error("missing due claim");
      await admin.query("BEGIN");
      await admin.query(
        `UPDATE persona_wallet_assignments
            SET status='tombstoned',tombstoned_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE persona_id=$1 AND status IN ('active','pending')`,
        [claim.owner_persona_id],
      );
      await admin.query(
        "UPDATE personas SET status='retired',retired_at=clock_timestamp() WHERE persona_id=$1",
        [claim.owner_persona_id],
      );
      await admin.query("COMMIT");
      expect(await Effect.runPromise(store.finalize(target, finalEvidence()))).toBe("issued");
      expect(
        (await admin.query("SELECT status FROM handle_grants WHERE claim_id=$1", [claim.claim_id]))
          .rows[0]?.status,
      ).toBe("tombstoned");
      expect(
        (
          await admin.query(
            "SELECT pending_issuance_count,active_grant_count FROM handle_account_offering_grant_counters WHERE offering_id=$1",
            [offeringId],
          )
        ).rows[0],
      ).toMatchObject({ pending_issuance_count: "0", active_grant_count: "0" });
    });
    completed++;
  }, 60_000);
});

afterAll(async () => {
  if (connectionString && completed === testCount)
    await Bun.write(
      sentinel,
      "api-next-control-plane-postgres-spaces-handle-claims-suite-complete\n",
    );
});
