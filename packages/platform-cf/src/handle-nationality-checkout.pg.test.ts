import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { compileNationalityPolicy } from "@pirate/domain";
import { startNationalityFixture } from "@pirate/testing/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { advanceCommunityJoinNationalityVerificationInTransaction } from "./community-join-nationality-completion.ts";
import { makeControlPlaneHandleNationalityAuthoringStore } from "./handle-nationality-authoring-repository.ts";
import {
  makeControlPlaneHandleNationalityIntentResolver,
  makeControlPlaneHandleNationalityQualificationStore,
} from "./handle-nationality-qualification-repository.ts";
import { seedAccount, seedSaleNamespace, terms } from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import type { NationalityAuthoring } from "./nationality-authoring.ts";
import {
  insertCompletedNationalityEvidence,
  providerFixtures,
} from "./nationality-evidence.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Missing PostgreSQL URL");
const suite = connectionString ? describe : describe.skip;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_HANDLE_NATIONALITY_CHECKOUT_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-handle-nationality-checkout-suite-complete";
let completed = 0;
const communityId = "community_00000000-0000-4000-8000-000000000001";
const authoring = {
  policy_revision: 1,
  evidence_lifetime: { kind: "max_age_seconds", seconds: 31_536_000 },
  provider_bindings: providerFixtures,
} as unknown as NationalityAuthoring;
async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing PostgreSQL URL");
  const schema = `handle_checkout_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: url.toString() });
    await use(admin, url.toString());
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
async function setup(admin: Client, connection: string) {
  await seedAccount(admin, "seller", { humanEvidence: false });
  const personaId = await seedAccount(admin, "user-a", { humanEvidence: false });
  const activationId = await seedSaleNamespace(admin, "seller", communityId);
  // A community-scoped persona is required; membership is deliberately absent.
  await admin.query(
    "INSERT INTO persona_community_bindings (persona_id,account_id,community_id,binding_source) VALUES ($1,'user-a',$2,'persona_creation')",
    [personaId, communityId],
  );
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const policies = makeControlPlaneHandleNationalityAuthoringStore(layer, authoring);
  const actor = { accountId: "seller", communityId };
  const context = await Effect.runPromise(policies.getContext(actor));
  const policy = await Effect.runPromise(
    policies.createPolicy({
      ...actor,
      policyId: "policy",
      actionId: "policy-action",
      idempotencyKey: "policy-command",
      authoringReference: context.authoring_reference,
      allowedCountries: ["US"],
    }),
  );
  const sales = makeControlPlaneHandleSalesStore(layer);
  const offering = await Effect.runPromise(
    sales.createOffering({
      ...actor,
      offeringId: "offering",
      actionId: "offering-action",
      idempotencyKey: "offering-command",
      terms: {
        ...terms(activationId),
        qualification_policy_id: policy.qualification_policy.policy_id,
        expected_qualification_policy_revision: 1,
      },
    }),
  );
  await Effect.runPromise(
    sales.confirmPersonaReuse({
      accountId: "user-a",
      personaId,
      offeringId: "offering",
      idempotencyKey: "link-command",
      confirmationId: "link-confirmation",
      actionId: "link-action",
    }),
  );
  const quote = () =>
    Effect.runPromise(
      sales.createQuote({
        accountId: "user-a",
        personaId,
        offeringId: "offering",
        desiredLabel: "pikachux",
        idempotencyKey: "quote-command",
        quoteId: "quote",
        actionId: "quote-action",
      }),
    );
  return { sales, personaId, offering, quote };
}
const evidence = (admin: Client, provider: "self.pass" | "zkpassport") =>
  insertCompletedNationalityEvidence(admin, {
    suffix: provider,
    provider,
    requirement: { claim_id: "nationality.allowed", allowed_countries: ["US"] },
  });

suite("handle nationality checkout", () => {
  for (const provider of ["self.pass", "zkpassport"] as const)
    test(`qualifies a nonmember with ${provider} and issues only the requested handle`, async () => {
      await withSchema(async (admin, connection) => {
        const { sales, personaId, quote } = await setup(admin, connection);
        await evidence(admin, provider);
        const result = await quote();
        if (result.kind !== "quoted") throw new Error("Expected qualified quote");
        expect(result.quote.eligibility).toMatchObject({
          kind: "curated_nationality_v1",
          snapshot: {
            selected_provider_id: provider,
            accepted_provider_ids: ["self.pass", "zkpassport"],
            lifetime: { kind: "max_age_seconds", seconds: 31_536_000 },
          },
        });
        expect(await quote()).toEqual({ ...result, replayed: true });
        const reservation = await Effect.runPromise(
          sales.createReservation({
            accountId: "user-a",
            personaId,
            quoteId: "quote",
            expectedQuoteHash: result.quote.quote_hash,
            idempotencyKey: "reserve",
            reservationId: "reservation",
            actionId: "reservation-action",
          }),
        );
        const claimInput = {
          accountId: "user-a",
          personaId,
          reservationId: "reservation",
          expectedReservationHash: reservation.reservation.reservation_hash,
          idempotencyKey: "claim",
          claimId: "claim",
          actionId: "claim-action",
          issuanceOperationId: "issuance",
          grantId: "grant",
        };
        const claim = await Effect.runPromise(sales.submitFreeClaim(claimInput));
        expect(claim.claim.state).toBe("issued");
        expect((await Effect.runPromise(sales.submitFreeClaim(claimInput))).replayed).toBe(true);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM community_follows WHERE user_id='user-a'",
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await admin.query(
              "SELECT purpose,outcome FROM handle_nationality_decisions ORDER BY evaluated_at",
            )
          ).rows,
        ).toEqual([
          { purpose: "quote", outcome: "pass" },
          { purpose: "reservation", outcome: "pass" },
          { purpose: "claim", outcome: "pass" },
        ]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM community_memberships WHERE user_id='user-a'",
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM evidence_receipts WHERE user_id='user-a' AND method<>'document'",
            )
          ).rows[0].n,
        ).toBe(0);
        const pin = (await admin.query("SELECT nationality_qualification_pin FROM handle_quotes"))
          .rows[0].nationality_qualification_pin;
        expect(JSON.stringify(pin)).not.toContain("allowed_countries");
        await expect(
          admin.query("UPDATE handle_quotes SET nationality_qualification_pin='{}'::jsonb"),
        ).rejects.toThrow();
      });
      completed++;
    });
  test("expires between reservation and claim without issuing a grant", async () => {
    await withSchema(async (admin, connection) => {
      const { sales, personaId, quote } = await setup(admin, connection);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "expiry",
        provider: "self.pass",
        requirement: { claim_id: "nationality.allowed", allowed_countries: ["US"] },
        expirySeconds: 2,
      });
      const result = await quote();
      if (result.kind !== "quoted") throw new Error("Expected quote");
      const reservation = await Effect.runPromise(
        sales.createReservation({
          accountId: "user-a",
          personaId,
          quoteId: "quote",
          expectedQuoteHash: result.quote.quote_hash,
          idempotencyKey: "reserve",
          reservationId: "reservation",
          actionId: "reserve-action",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const resultClaim = await Effect.runPromise(
        Effect.exit(
          sales.submitFreeClaim({
            accountId: "user-a",
            personaId,
            reservationId: "reservation",
            expectedReservationHash: reservation.reservation.reservation_hash,
            idempotencyKey: "claim",
            claimId: "claim",
            actionId: "claim-action",
            issuanceOperationId: "issuance",
            grantId: "grant",
          }),
        ),
      );
      expect(resultClaim._tag).toBe("Failure");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM handle_grants WHERE owner_account_id='user-a'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT purpose,outcome FROM handle_nationality_decisions WHERE purpose='claim'",
          )
        ).rows[0],
      ).toEqual({ purpose: "claim", outcome: "needs_evidence" });
    });
    completed++;
  });
  test("starts either provider, fences a switched child, and returns for a fresh quote without a grant", async () => {
    await withSchema(async (admin, connection) => {
      const { sales, personaId, quote } = await setup(admin, connection);
      const required = await quote();
      if (required.kind !== "nationality_required")
        throw new Error("Expected buyer qualification intent");
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const progressStore = makeControlPlaneHandleNationalityQualificationStore(layer);
      const resolver = makeControlPlaneHandleNationalityIntentResolver(layer);
      const sessionStore = makeControlPlaneVerificationSessionStartStore(layer);
      const compilation = compileNationalityPolicy({
        policy_revision: 1,
        allowed_countries: ["US"],
        evidence_lifetime: authoring.evidence_lifetime,
        provider_bindings: providerFixtures,
      });
      if (compilation.kind !== "compiled") throw new Error("Invalid policy fixture");
      const input = { accountId: "user-a", intentId: required.qualification_intent_id };
      const progress = await Effect.runPromise(progressStore.getProgress(input));
      if (progress.next_action.kind !== "start_verification")
        throw new Error("Expected start action");
      const original = progress.next_action.intent_id;
      const first = await startNationalityFixture(sessionStore, resolver, compilation.policy, {
        actor_id: "user-a",
        intent_id: original,
        provider_id: "self.pass",
      });
      await admin.query("BEGIN");
      try {
        await admin.query(
          "UPDATE proof_sessions SET status='failed',completion_idempotency_key='failed-start',completion_result_hash=repeat('f',64),terminal_at=clock_timestamp() WHERE proof_session_id=$1",
          [first.proof_session_id],
        );
        await admin.query(
          "INSERT INTO proof_session_completion_events (completion_event_id,proof_session_id,actor_id,idempotency_key,terminal_status,result_hash,terminal_at) SELECT 'failed-start',proof_session_id,actor_id,completion_idempotency_key,status,completion_result_hash,terminal_at FROM proof_sessions WHERE proof_session_id=$1",
          [first.proof_session_id],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const retried = await startNationalityFixture(sessionStore, resolver, compilation.policy, {
        actor_id: "user-a",
        intent_id: original,
        provider_id: "self.pass",
      });
      expect(retried.proof_session_id).not.toBe(first.proof_session_id);
      const retryProgress = await Effect.runPromise(progressStore.getProgress(input));
      if (retryProgress.next_action.kind !== "start_verification")
        throw new Error("Expected retry action");
      const switched = await startNationalityFixture(sessionStore, resolver, compilation.policy, {
        actor_id: "user-a",
        intent_id: retryProgress.next_action.intent_id,
        provider_id: "zkpassport",
      });
      expect(switched.proof_session_id).not.toBe(first.proof_session_id);
      expect(
        await Effect.runPromise(
          resolver.resolve({ actor_id: "user-a", intent_id: original, provider_id: "self.pass" }),
        ),
      ).toBeNull();
      const bound = await Effect.runPromise(progressStore.getProgress(input));
      expect(bound.next_action).toMatchObject({ provider_id: "zkpassport", generation: 3 });
      await insertCompletedNationalityEvidence(admin, {
        suffix: "buyer-flow",
        provider: "zkpassport",
        requirement: compilation.policy.requirement,
        startedSessionId: switched.proof_session_id,
      });
      const advance = Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            advanceCommunityJoinNationalityVerificationInTransaction(
              transaction,
              {
                actor_id: "user-a",
                proof_session_id: switched.proof_session_id,
                result_hash: "b".repeat(64),
              },
              "handle_claim",
            ),
          );
        }),
      ).pipe(Effect.provide(layer));
      expect(await Effect.runPromise(advance)).toBe("advanced");
      expect(await quote()).toEqual(required);
      expect((await Effect.runPromise(progressStore.getProgress(input))).next_action).toEqual({
        kind: "request_new_quote",
      });
      const fresh = await Effect.runPromise(
        sales.createQuote({
          accountId: "user-a",
          personaId,
          offeringId: "offering",
          desiredLabel: "pikachux",
          idempotencyKey: "fresh-quote",
          quoteId: "fresh-quote",
          actionId: "fresh-action",
        }),
      );
      expect(fresh.kind).toBe("quoted");
      expect((await admin.query("SELECT count(*)::int AS n FROM handle_grants")).rows[0].n).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM community_memberships WHERE user_id='user-a'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    completed++;
  });
  test("a changed allowlist invalidates the quote and asks for fresh evidence", async () => {
    await withSchema(async (admin, connection) => {
      const { sales, personaId, offering, quote } = await setup(admin, connection);
      await evidence(admin, "self.pass");
      const result = await quote();
      if (result.kind !== "quoted") throw new Error("Expected quote");
      const original = (
        await admin.query("SELECT nationality_qualification_pin FROM handle_quotes")
      ).rows[0];
      const policies = makeControlPlaneHandleNationalityAuthoringStore(
        makeDirectPostgresControlPlaneLayer(connection),
        authoring,
      );
      const actor = { accountId: "seller", communityId };
      const context = await Effect.runPromise(policies.getContext(actor));
      await Effect.runPromise(
        policies.createPolicy({
          ...actor,
          policyId: "policy-ca",
          actionId: "policy-ca-action",
          idempotencyKey: "policy-ca",
          authoringReference: context.authoring_reference,
          allowedCountries: ["CA"],
        }),
      );
      await Effect.runPromise(
        sales.reviseOffering({
          ...actor,
          offeringId: "offering",
          actionId: "revision-action",
          idempotencyKey: "revision",
          expectedOfferingHash: offering.offering.offering_hash,
          requestedStatus: "active",
          terms: {
            ...terms("sale-activation-test"),
            qualification_policy_id: "policy-ca",
            expected_qualification_policy_revision: 1,
          },
        }),
      );
      expect(
        (
          await Effect.runPromise(
            Effect.exit(
              sales.createReservation({
                accountId: "user-a",
                personaId,
                quoteId: "quote",
                expectedQuoteHash: result.quote.quote_hash,
                idempotencyKey: "reserve",
                reservationId: "reservation",
                actionId: "reserve-action",
              }),
            ),
          )
        )._tag,
      ).toBe("Failure");
      expect(
        (await admin.query("SELECT nationality_qualification_pin FROM handle_quotes")).rows[0],
      ).toEqual(original);
      const fresh = await Effect.runPromise(
        sales.createQuote({
          accountId: "user-a",
          personaId,
          offeringId: "offering",
          desiredLabel: "pikachux",
          idempotencyKey: "revised-quote",
          quoteId: "revised-quote",
          actionId: "revised-action",
        }),
      );
      expect(fresh.kind).toBe("nationality_required");
    });
    completed++;
  });
  test("rolls back the decision, claim and reservation consumption when grant insertion fails", async () => {
    await withSchema(async (admin, connection) => {
      const { sales, personaId, quote } = await setup(admin, connection);
      await evidence(admin, "self.pass");
      const result = await quote();
      if (result.kind !== "quoted") throw new Error("Expected quote");
      const reservation = await Effect.runPromise(
        sales.createReservation({
          accountId: "user-a",
          personaId,
          quoteId: "quote",
          expectedQuoteHash: result.quote.quote_hash,
          idempotencyKey: "reserve",
          reservationId: "reservation",
          actionId: "reserve-action",
        }),
      );
      await admin.query(
        "CREATE FUNCTION reject_test_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test grant rejection'; END; $$; CREATE TRIGGER reject_test_grant BEFORE INSERT ON handle_grants FOR EACH ROW EXECUTE FUNCTION reject_test_grant()",
      );
      expect(
        (
          await Effect.runPromise(
            Effect.exit(
              sales.submitFreeClaim({
                accountId: "user-a",
                personaId,
                reservationId: "reservation",
                expectedReservationHash: reservation.reservation.reservation_hash,
                idempotencyKey: "claim",
                claimId: "claim",
                actionId: "claim-action",
                issuanceOperationId: "issuance",
                grantId: "grant",
              }),
            ),
          )
        )._tag,
      ).toBe("Failure");
      expect((await admin.query("SELECT count(*)::int AS n FROM handle_claims")).rows[0].n).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM handle_nationality_decisions WHERE purpose='claim'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await admin.query("SELECT status FROM handle_reservations")).rows[0].status).toBe(
        "reserved",
      );
    });
    completed++;
  });
  test("membership does not qualify a buyer without nationality evidence", async () => {
    await withSchema(async (admin, connection) => {
      const { quote } = await setup(admin, connection);
      await admin.query("BEGIN");
      try {
        await admin.query(
          "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'membership','user-a','member',clock_timestamp(),clock_timestamp(),clock_timestamp())",
          [communityId],
        );
        await admin.query(
          "INSERT INTO community_follows (community_follow_id,community_id,user_id,status,created_at,updated_at) VALUES ('follow',$1,'user-a','active',clock_timestamp(),clock_timestamp())",
          [communityId],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      expect((await quote()).kind).toBe("nationality_required");
      expect((await admin.query("SELECT count(*)::int AS n FROM handle_quotes")).rows[0].n).toBe(0);
      expect(
        (await admin.query("SELECT status FROM community_memberships WHERE user_id='user-a'"))
          .rows[0].status,
      ).toBe("member");
    });
    completed++;
  });
  test("records missing evidence without issuing a quote", async () => {
    await withSchema(async (admin, connection) => {
      const { quote } = await setup(admin, connection);
      expect((await quote()).kind).toBe("nationality_required");
      expect((await admin.query("SELECT count(*)::int AS n FROM handle_quotes")).rows[0].n).toBe(0);
      expect(
        (await admin.query("SELECT outcome FROM handle_nationality_decisions")).rows[0].outcome,
      ).toBe("needs_evidence");
    });
    completed++;
  });
  test("refuses evidence revoked between quote and reservation without changing the pin", async () => {
    await withSchema(async (admin, connection) => {
      const { sales, personaId, quote } = await setup(admin, connection);
      await evidence(admin, "self.pass");
      const result = await quote();
      if (result.kind !== "quoted") throw new Error("Expected quote");
      const before = (await admin.query("SELECT nationality_qualification_pin FROM handle_quotes"))
        .rows[0];
      await admin.query(
        "INSERT INTO assertion_revalidation_events (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at) VALUES ('revoked','assertion-nationality-self.pass','user-a','receipt-nationality-self.pass','revoked',clock_timestamp())",
      );
      const denied = await Effect.runPromise(
        Effect.exit(
          sales.createReservation({
            accountId: "user-a",
            personaId,
            quoteId: "quote",
            expectedQuoteHash: result.quote.quote_hash,
            idempotencyKey: "reserve",
            reservationId: "reservation",
            actionId: "reservation-action",
          }),
        ),
      );
      expect(denied._tag).toBe("Failure");
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM handle_reservations")).rows[0].n,
      ).toBe(0);
      expect(
        (await admin.query("SELECT nationality_qualification_pin FROM handle_quotes")).rows[0],
      ).toEqual(before);
    });
    completed++;
  });
});
afterAll(async () => {
  if (connectionString && completed === 9)
    await Bun.write(
      sentinel,
      "api-next-control-plane-postgres-handle-nationality-checkout-suite-complete\n",
    );
});
