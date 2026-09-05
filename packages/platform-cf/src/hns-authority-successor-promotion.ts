import { Effect } from "effect";
import type { Client } from "pg";
import { decodeHnsDnsZonePersistenceDocumentV1 } from "../../application/src/hns-host-persistence.ts";
import { decodeHnsAuthorityInventoryBytes } from "../../application/src/namespace-ownership/hns-authority-inventory.ts";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "../../application/src/ports.ts";
import { makeControlPlaneHandleSalesRepository } from "./handle-sales-repository.ts";
import {
  hnsAppHostTransitionStatementFromReviewedDocument,
  hnsDnsHealthStatementFromReviewedDocument,
  hnsDnsZoneFinalizationStatementFromReviewedDocument,
  hnsDnsZoneReservationStatementFromReviewedDocument,
} from "./hns-host-persistence-repository.ts";

export class HnsAuthoritySuccessorPromotionRefusal extends Error {}
function exactRow<A>(rows: readonly A[], label: string): A {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new HnsAuthoritySuccessorPromotionRefusal(`${label} returned invalid rows`);
  return rows[0];
}
function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0)
    throw new HnsAuthoritySuccessorPromotionRefusal(`${label} is invalid`);
  return parsed;
}

/** Caller owns the transaction and locks/revalidates predecessor DNS, app,
 * health and sale fences. This body never commits or retries database work. */
export async function promoteHnsAuthoritySuccessorInTransaction(input: {
  readonly client: Client;
  readonly inventoryRegistryReference: string;
  readonly authorityInventoryBytes: Uint8Array;
  readonly dnsActivationBytes: Uint8Array;
  readonly appActivationBytes: Uint8Array;
  readonly healthObservationBytes: Uint8Array;
  readonly successorId: string;
  readonly rootLabel: string;
  readonly generations: {
    readonly dns_activation_generation: number;
    readonly app_host_activation_generation: number;
    readonly health_generation: number;
  };
  readonly sale: {
    readonly actor_account_id: string;
    readonly community_id: string;
    readonly sale_namespace_activation_id: string;
    readonly sale_namespace_activation_hash: string;
    readonly namespace_authority_reference: string;
    readonly namespace_authority_generation: string | number;
    readonly sale_namespace_activation_generation: string | number;
  };
}) {
  const { client, inventoryRegistryReference } = input;
  const inventory = await decodeHnsAuthorityInventoryBytes(input.authorityInventoryBytes);
  const dns = await decodeHnsDnsZonePersistenceDocumentV1(input.dnsActivationBytes);
  const reservationStatement = await hnsDnsZoneReservationStatementFromReviewedDocument(
    input.dnsActivationBytes,
    60,
  );
  const appStatement = hnsAppHostTransitionStatementFromReviewedDocument(input.appActivationBytes);
  const healthStatement = hnsDnsHealthStatementFromReviewedDocument(input.healthObservationBytes);
  const inventoryValues = [
    inventoryRegistryReference,
    inventory.inventory.authority_inventory_reference,
    inventory.inventory.authority_inventory_version,
    inventory.inventory_digest,
    inventory.inventory.environment,
    inventory.inventory.runtime_capability_set_digest,
    Buffer.from(inventory.inventory_bytes),
    inventory.inventory.published_at,
    inventory.inventory.expires_at,
  ];
  const inserted = await client.query({
      text: `INSERT INTO hns_authority_inventories (
               registry_reference,
               authority_inventory_reference,
               authority_inventory_version,
               authority_inventory_digest,
               environment,
               runtime_capability_set_digest,
               inventory_bytes,
               published_at,
               expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::bytea, $8::timestamptz, $9::timestamptz)
             ON CONFLICT DO NOTHING`,
      values: inventoryValues,
    }),
    retainedInventory = await client.query({
      text: `SELECT count(*)::integer AS matching_rows
               FROM hns_authority_inventories
              WHERE registry_reference = $1
                AND authority_inventory_reference = $2
                AND authority_inventory_version = $3
                AND authority_inventory_digest = $4
                AND environment = $5
                AND runtime_capability_set_digest = $6
                AND inventory_bytes = $7::bytea
                AND published_at = $8::timestamptz
                AND expires_at = $9::timestamptz`,
      values: inventoryValues,
    });
  if (exactRow(retainedInventory.rows, "retained inventory").matching_rows !== 1)
    throw new HnsAuthoritySuccessorPromotionRefusal(
      "retained authority inventory differs from reviewed bytes",
    );
  const reservationResult = exactRow(
      (
        await client.query({
          text: reservationStatement.text,
          values: [...reservationStatement.values],
        })
      ).rows,
      reservationStatement.label,
    ),
    reservation = {
      outcome:
        reservationResult.outcome === "reserved" ? ("reserved" as const) : ("replayed" as const),
      operation_id: String(reservationResult.operation_id),
      dns_zone_activation_id: String(reservationResult.dns_zone_activation_id),
      fence_token: positiveInteger(reservationResult.fence_token, "DNS fence token"),
      lease_expires_at: new Date(String(reservationResult.lease_expires_at)).toISOString(),
      activation_generation:
        reservationResult.activation_generation === null
          ? null
          : positiveInteger(reservationResult.activation_generation, "DNS replay generation"),
    };
  if (reservationResult.outcome !== "reserved" && reservationResult.outcome !== "replayed")
    throw new HnsAuthoritySuccessorPromotionRefusal("DNS reservation returned an invalid outcome");
  const finalizationStatement = await hnsDnsZoneFinalizationStatementFromReviewedDocument(
      reservation,
      input.dnsActivationBytes,
    ),
    dnsOutcome = exactRow(
      (
        await client.query({
          text: finalizationStatement.text,
          values: [...finalizationStatement.values],
        })
      ).rows,
      finalizationStatement.label,
    ),
    appOutcome = exactRow(
      (await client.query({ text: appStatement.text, values: [...appStatement.values] })).rows,
      appStatement.label,
    ),
    healthOutcome = exactRow(
      (await client.query({ text: healthStatement.text, values: [...healthStatement.values] }))
        .rows,
      healthStatement.label,
    ),
    transaction: ControlPlaneTransaction = {
      execute: (statement) =>
        Effect.tryPromise({
          try: async () => {
            const result = await client.query({
              text: statement.text,
              values: [...statement.values],
            });
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
          catch: (error) =>
            new ControlPlaneStatementFailed({
              label: statement.label,
              sqlState:
                error instanceof Error && "code" in error && typeof error.code === "string"
                  ? error.code
                  : null,
              constraint:
                error instanceof Error &&
                "constraint" in error &&
                typeof error.constraint === "string"
                  ? error.constraint
                  : null,
              outcomeCertainty: "unknown",
            }),
        }),
    },
    saleOutcome = await Effect.runPromise(
      makeControlPlaneHandleSalesRepository()
        .reviseSaleNamespace({
          accountId: input.sale.actor_account_id,
          communityId: input.sale.community_id,
          activationId: input.sale.sale_namespace_activation_id,
          expectedActivationHash: input.sale.sale_namespace_activation_hash,
          requestedStatus: "active",
          namespaceAuthorityReference: input.sale.namespace_authority_reference,
          expectedNamespaceAuthorityGeneration: Number(input.sale.namespace_authority_generation),
          dnsZoneActivationId: dns.dns_zone_activation_id,
          expectedDnsZoneActivationGeneration: input.generations.dns_activation_generation,
          dedicatedRootReplacementConfirmed: true,
          idempotencyKey: `hns-continuity-sale:${input.successorId}`,
          actionId: `hns-continuity-sale:${input.successorId}`,
        })
        .pipe(
          Effect.provideService(ControlPlaneDb, {
            ...transaction,
            withTransaction: (use) => use(transaction),
          }),
        ),
    );
  if (
    saleOutcome.activation.serving.dns_zone_activation_generation !==
      input.generations.dns_activation_generation ||
    saleOutcome.activation.sale_namespace_activation_generation !==
      Number(input.sale.sale_namespace_activation_generation) + 1
  )
    throw new HnsAuthoritySuccessorPromotionRefusal("Sale namespace did not advance atomically");
  const verified = exactRow(
    (
      await client.query({
        text: `SELECT dns.current_generation AS dns_generation,
                        app.current_generation AS app_generation,
                        COALESCE((
                          SELECT max(health_generation)
                            FROM hns_dns_zone_health_observations
                           WHERE dns_zone_activation_id = dns.dns_zone_activation_id
                             AND activation_generation = dns.current_generation
                        ), 0) AS health_generation
                   FROM hns_dns_zone_activation_current AS dns
                   JOIN hns_community_app_host_activation_current AS app
                     ON app.normalized_host = $2
                  WHERE dns.canonical_root = $1`,
        values: [input.rootLabel, `app.${input.rootLabel}`],
      })
    ).rows,
    "successor verification",
  );
  if (
    positiveInteger(verified.dns_generation, "verified DNS generation") !==
      input.generations.dns_activation_generation ||
    positiveInteger(verified.app_generation, "verified app-host generation") !==
      input.generations.app_host_activation_generation ||
    positiveInteger(verified.health_generation, "verified health generation") !==
      input.generations.health_generation
  )
    throw new HnsAuthoritySuccessorPromotionRefusal(
      "successor selectors do not match the reviewed generations",
    );
  return {
    inventory_inserted: inserted.rowCount === 1,
    dns_outcome: dnsOutcome,
    app_host_outcome: appOutcome,
    health_outcome: healthOutcome,
    sale_generation: saleOutcome.activation.sale_namespace_activation_generation,
  };
}
