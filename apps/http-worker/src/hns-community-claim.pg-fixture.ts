import { expect } from "bun:test";
import {
  HandleRecipientTokenVault,
  IdGen,
  makeHandleSalesService,
} from "@pirate/application/use-cases/handles/sales";
import { makeHandleRecipientTokenVault } from "@pirate/platform-cf/handle-recipient-token-vault";
import { makeControlPlaneHandleSalesStore } from "@pirate/platform-cf/handle-sales-repository";
import { Effect } from "effect";
import {
  bindPersonaToCommunity,
  seedAccount,
  terms,
} from "../../../packages/platform-cf/src/handle-sales.pg-fixture.ts";
import type { ReadyImport } from "./hns-community-activation.pg-fixture.ts";

/** Issue a real claim through the same sale operations used by the frontend. */
export async function claimImportedHnsHandle(ready: ReadyImport) {
  const buyer = "member-account";
  const persona = await seedAccount(ready.admin, buyer, { humanEvidence: false });
  await bindPersonaToCommunity(ready.admin, {
    accountId: buyer,
    communityId: ready.community,
    personaId: persona,
  });
  const sales = makeHandleSalesService(makeControlPlaneHandleSalesStore(ready.layer));
  let sequence = 0;
  const vault = makeHandleRecipientTokenVault({
    hmacKeys: `h1:${Buffer.alloc(32, 21).toString("base64")}`,
    envelopeKeys: `e1:${Buffer.alloc(32, 22).toString("base64")}`,
  });
  const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(IdGen, { next: Effect.sync(() => `hns-claim-${++sequence}`) }),
        Effect.provideService(HandleRecipientTokenVault, vault),
      ),
    );
  const activation = (
    await ready.admin.query(
      `SELECT sale_namespace_activation_id
    FROM community_handle_sale_namespace_activation_current WHERE community_id=$1`,
      [ready.community],
    )
  ).rows[0];
  const offering = await run(
    sales.createOffering({
      accountId: ready.actor,
      communityId: ready.community,
      idempotencyKey: "claim-offering",
      terms: terms(activation.sale_namespace_activation_id),
    }),
  );
  await run(
    sales.confirmPersonaReuse({
      accountId: buyer,
      personaId: persona,
      offeringId: offering.offering.offering_id,
      idempotencyKey: "claim-link",
    }),
  );
  const quote = await run(
    sales.createQuote({
      accountId: buyer,
      personaId: persona,
      offeringId: offering.offering.offering_id,
      desiredLabel: "journeytest",
      idempotencyKey: "claim-quote",
    }),
  );
  if (quote.kind !== "quoted") throw new Error("claim must be quoted");
  const reservation = await run(
    sales.createReservation({
      accountId: buyer,
      personaId: persona,
      quoteId: quote.quote.quote_id,
      expectedQuoteHash: quote.quote.quote_hash,
      idempotencyKey: "claim-reservation",
    }),
  );
  const claim = await run(
    sales.submitFreeClaim({
      accountId: buyer,
      personaId: persona,
      reservationId: reservation.reservation.reservation_id,
      expectedReservationHash: reservation.reservation.reservation_hash,
      idempotencyKey: "claim-submit",
    }),
  );
  expect(claim.claim).toMatchObject({
    state: "issued",
    display_identifier: "journeytest.harbor",
    grant: { status: "active", owner_persona_id: persona },
  });
  return { buyer, persona, sales, run, claim };
}
