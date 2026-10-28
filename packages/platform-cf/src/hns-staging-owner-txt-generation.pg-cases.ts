import { expect } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import { makeControlPlaneHandleSalesRepository } from "./handle-sales-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

/** Real active-to-active writers must invalidate the already reviewed app and
 * sale predecessors, even though both services remain active. */
export async function verifyHnsOwnerTxtServingGenerationFences(input: {
  readonly admin: Client;
  readonly connection: string;
  readonly dns_id: string;
  readonly dns_generation: number;
  readonly app_generation: number;
  readonly sale_generation: number;
  readonly refuse_stale: () => Promise<unknown>;
}) {
  await input.admin.query(
    `SELECT * FROM change_hns_community_app_host_status_v1(
    'txt-fixture-active-app','txt-fixture-active-app',repeat('f',64),'app-root-import',$1,'active',NULL)`,
    [input.app_generation],
  );
  await expect(input.refuse_stale()).rejects.toThrow("fence changed");
  const sale = (
    await input.admin.query<{
      sale_namespace_activation_hash: string;
    }>(`SELECT revision.sale_namespace_activation_hash
    FROM community_handle_sale_namespace_activation_current current
    JOIN community_handle_sale_namespace_activation_revisions revision
      ON revision.sale_namespace_activation_id=current.sale_namespace_activation_id
      AND revision.sale_namespace_activation_generation=current.current_generation
    WHERE current.sale_namespace_activation_id='sale-root-import'`)
  ).rows[0];
  if (sale === undefined) throw new Error("owner TXT fixture sale is unavailable");
  // The caller explicitly reviews the new app generation before this second
  // refusal, so a stale sale cannot be hidden by the earlier app mismatch.
  return {
    app_generation: input.app_generation + 1,
    change_sale: () =>
      Effect.runPromise(
        makeControlPlaneHandleSalesRepository()
          .reviseSaleNamespace({
            accountId: "actor-root-import",
            communityId: "community-root-import",
            activationId: "sale-root-import",
            expectedActivationHash: sale.sale_namespace_activation_hash,
            requestedStatus: "active",
            namespaceAuthorityReference: "owner-txt-evidence",
            expectedNamespaceAuthorityGeneration: 3,
            dnsZoneActivationId: input.dns_id,
            expectedDnsZoneActivationGeneration: input.dns_generation,
            dedicatedRootReplacementConfirmed: true,
            idempotencyKey: "txt-fixture-active-sale",
            actionId: "txt-fixture-active-sale",
          })
          .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(input.connection))),
      ),
    sale_generation: input.sale_generation + 1,
  };
}
