import { ControlPlaneDb, type ControlPlaneTransaction } from "@pirate/application";
import { Data, Effect } from "effect";
import { makeControlPlaneHandleSalesRepository } from "./handle-sales-repository.ts";

class HnsHostRefreshFailed extends Data.TaggedError("HnsHostRefreshFailed")<
  Record<string, never>
> {}

/** Rebind existing active hosts inside the ownership transaction. Owner-paused
 * or revoked capabilities remain paused; no claim or DNS resource is rewritten. */
export const refreshVerifiedHnsHosts = Effect.fn("refreshVerifiedHnsHosts")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    community_id: string;
    route_binding_id: string;
    root_label: string;
    actor_id: string;
    expected_binding_generation: number;
    evidence_ref: string;
    operation_id: string;
    result_hash: string;
  }>,
) {
  const app = yield* transaction.execute<{
    app_host_activation_id: string;
    current_generation: string;
  }>({
    label: "hns-ownership.app-current",
    text: `SELECT current.app_host_activation_id, current.current_generation
        FROM hns_community_app_host_activation_current AS current
        JOIN hns_community_app_host_activation_revisions AS revision
          ON revision.app_host_activation_id=current.app_host_activation_id
         AND revision.app_host_activation_generation=current.current_generation
        WHERE revision.community_id=$1 AND revision.route_binding_id=$2
          AND revision.canonical_root=$3 AND revision.route_authority_kind='verified_namespace_v1'
          AND revision.status='active' FOR UPDATE OF current`,
    values: [input.community_id, input.route_binding_id, input.root_label],
    readonly: false,
  });
  if (app.rows.length > 1) return yield* new HnsHostRefreshFailed({});
  const currentApp = app.rows[0];
  if (currentApp !== undefined) {
    const refreshed = yield* transaction.execute<{ outcome: string }>({
      label: "hns-ownership.refresh-app",
      text: "SELECT * FROM change_hns_community_app_host_status_v1($1,$2,$3,$4,$5::bigint,'active',NULL)",
      values: [
        `hns-ownership-app:${input.operation_id}`,
        `hns-ownership-app:${input.operation_id}`,
        input.result_hash,
        currentApp.app_host_activation_id,
        currentApp.current_generation,
      ],
      readonly: false,
    });
    if (refreshed.rows.length !== 1 || refreshed.rows[0]?.outcome !== "changed")
      return yield* new HnsHostRefreshFailed({});
  }
  const sale = yield* transaction.execute<{
    sale_namespace_activation_id: string;
    sale_namespace_activation_hash: string;
    dns_zone_activation_id: string;
    dns_zone_activation_generation: string;
  }>({
    label: "hns-ownership.sale-current",
    text: `SELECT revision.sale_namespace_activation_id, revision.sale_namespace_activation_hash,
          revision.dns_zone_activation_id, revision.dns_zone_activation_generation
        FROM community_handle_sale_namespace_activation_current AS current
        JOIN community_handle_sale_namespace_activation_revisions AS revision
          ON revision.sale_namespace_activation_id=current.sale_namespace_activation_id
         AND revision.sale_namespace_activation_generation=current.current_generation
        WHERE revision.community_id=$1 AND revision.family='hns' AND revision.canonical_root=$2
          AND revision.namespace_authority_kind='verified_namespace_v1' AND revision.status='active'
        FOR UPDATE OF current`,
    values: [input.community_id, input.root_label],
    readonly: false,
  });
  if (sale.rows.length > 1) return yield* new HnsHostRefreshFailed({});
  const currentSale = sale.rows[0];
  if (currentSale !== undefined) {
    // The maintained revision writer joins the already-held transaction.
    // Its normal authority, DNS, hashing, history and constraint checks run.
    yield* makeControlPlaneHandleSalesRepository()
      .reviseSaleNamespace({
        accountId: input.actor_id,
        communityId: input.community_id,
        activationId: currentSale.sale_namespace_activation_id,
        expectedActivationHash: currentSale.sale_namespace_activation_hash,
        requestedStatus: "active",
        namespaceAuthorityReference: input.evidence_ref,
        expectedNamespaceAuthorityGeneration: input.expected_binding_generation + 1,
        dnsZoneActivationId: currentSale.dns_zone_activation_id,
        expectedDnsZoneActivationGeneration: Number(currentSale.dns_zone_activation_generation),
        dedicatedRootReplacementConfirmed: true,
        idempotencyKey: `hns-ownership-sale:${input.operation_id}`,
        actionId: `hns-ownership-sale:${input.operation_id}`,
      })
      .pipe(
        Effect.provideService(ControlPlaneDb, {
          execute: transaction.execute,
          withTransaction: (use) => use(transaction),
        }),
        Effect.mapError(() => new HnsHostRefreshFailed({})),
      );
  }
});
