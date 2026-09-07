import { expect } from "bun:test";
import {
  HandleRecipientTokenVault,
  IdGen,
  makeHandleSalesService,
  resolveActiveHnsHostAuthority,
} from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";
import { makeHandleRecipientTokenVault } from "./handle-recipient-token-vault.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "./hns-handle-host-authority-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

export async function issueImportedRootHandleFixture(admin: Client, connection: string) {
  const accountId = "actor-root-import",
    communityId = "community-root-import";
  await activatePendingPersonaFixtures(admin);
  const personaId = (
    await admin.query<{ persona_id: string }>(
      "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
      [accountId],
    )
  ).rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("Import actor persona missing");
  await admin.query(
    "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,$3,'first_membership') ON CONFLICT DO NOTHING",
    [personaId, accountId, communityId],
  );
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query(
      `INSERT INTO evidence_receipts(evidence_receipt_id,proof_session_id,user_id,provider_id,issuer,method,scope_kind,issuer_rp_scope,issuer_rp_action_scope,protocol_version,environment,evidence_kind,evidence_hash,receipt_metadata,observed_at,expires_at,provenance_kind,provider_configuration_kind,provider_configuration_ref,provider_configuration_version)
      VALUES('inventory-human-proof','inventory-proof-session',$1,'very.web','very','web','none',NULL,NULL,'v1','test','very.web.server-verified.v1',repeat('b',64),'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '1 hour','proof_session','managed','very:test','1')`,
      [accountId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const sales = makeHandleSalesService(makeControlPlaneHandleSalesStore(layer));
  let sequence = 0;
  const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(IdGen, { next: Effect.sync(() => `inventory-handle-${++sequence}`) }),
        Effect.provideService(
          HandleRecipientTokenVault,
          makeHandleRecipientTokenVault({
            hmacKeys: `h1:${Buffer.alloc(32, 21).toString("base64url")}`,
            envelopeKeys: `e1:${Buffer.alloc(32, 22).toString("base64url")}`,
          }),
        ),
      ),
    );
  const offering = await run(
    sales.createOffering({
      accountId,
      communityId,
      idempotencyKey: "inventory-offering",
      terms: {
        sale_namespace_activation_id: "sale-root-import",
        expected_sale_namespace_activation_generation: 1,
        label_scope: {
          kind: "label_rule_v2",
          label_grammar_id: "hns_ascii_ldh_1_63_v1",
          reserved_labels_id: "reserved_labels_01",
          expected_reserved_labels_revision: 1,
          availability: { kind: "length_band_v1", min_label_length: 8, max_label_length: 32 },
        },
        allocation_kind: "first_come_v1",
        fulfillment_kind: "hosted_persona_v1",
        qualification_policy_id: "none_v1",
        expected_qualification_policy_revision: 1,
        pricing_id: "platform_free_handles_v1",
        expected_pricing_revision: 1,
        issuance_driver_id: "hosted_persona-local",
        expected_issuance_driver_version: "1",
        quote_ttl_seconds: 120,
        reservation_ttl_seconds: 300,
      },
    }),
  );
  const offeringId = offering.offering.offering_id;
  await run(
    sales.confirmPersonaReuse({
      accountId,
      personaId,
      offeringId,
      idempotencyKey: "inventory-persona-link",
    }),
  );
  const quote = await run(
    sales.createQuote({
      accountId,
      personaId,
      offeringId,
      desiredLabel: "longname",
      idempotencyKey: "inventory-quote",
    }),
  );
  if (quote.kind !== "quoted") throw new Error("Expected inventory handle quote");
  const reservation = await run(
    sales.createReservation({
      accountId,
      personaId,
      quoteId: quote.quote.quote_id,
      expectedQuoteHash: quote.quote.quote_hash,
      idempotencyKey: "inventory-reservation",
    }),
  );
  const claim = await run(
    sales.submitFreeClaim({
      accountId,
      personaId,
      reservationId: reservation.reservation.reservation_id,
      expectedReservationHash: reservation.reservation.reservation_hash,
      idempotencyKey: "inventory-claim",
    }),
  );
  const source = makeControlPlaneHnsHandlePersonaHostAuthoritySource(layer);
  return async () => {
    const authority = await Effect.runPromise(source.resolve("longname.newroot"));
    expect(authority).toMatchObject({
      handle_grant_id: claim.claim.grant?.grant_id,
      owner_persona_id: personaId,
      handle_grant_active: true,
    });
    expect(resolveActiveHnsHostAuthority(authority)).not.toBeNull();
  };
}
