import type { ControlPlaneTransaction } from "@pirate/application";
import { handleSaleNamespaceActivationHash } from "@pirate/domain";
import { Data, Effect } from "effect";

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
    current_generation: string;
    dns_zone_activation_id: string;
    dns_zone_activation_generation: string;
  }>({
    label: "hns-ownership.sale-current",
    text: `SELECT revision.sale_namespace_activation_id, current.current_generation,
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
    const generation = Number(currentSale.current_generation) + 1;
    const dnsGeneration = Number(currentSale.dns_zone_activation_generation);
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(dnsGeneration))
      return yield* new HnsHostRefreshFailed({});
    const hash = handleSaleNamespaceActivationHash({
      sale_namespace_activation_id: currentSale.sale_namespace_activation_id,
      sale_namespace_activation_generation: generation,
      community_id: input.community_id,
      family: "hns",
      canonical_root: input.root_label,
      namespace_authority_reference: input.evidence_ref,
      namespace_authority_generation: input.expected_binding_generation + 1,
      dns_zone_activation_id: currentSale.dns_zone_activation_id,
      dns_zone_activation_generation: dnsGeneration,
    }).sha256;
    // The insert trigger requires a completed renewal/recovery proof tied to
    // the current binding. Preserve the original seller attribution and grant.
    const revision = yield* transaction.execute({
      label: "hns-ownership.refresh-sale",
      text: `INSERT INTO community_handle_sale_namespace_activation_revisions (
        sale_namespace_activation_id,sale_namespace_activation_generation,
        sale_namespace_activation_hash,community_id,family,canonical_root,display_root,
        namespace_authority_kind,namespace_authority_reference,namespace_authority_generation,
        serving_kind,dns_zone_activation_id,dns_zone_activation_generation,root_replacement_kind,
        dedicated_root_replacement_confirmed,status,reason_code,actor_account_id,authority_grant_id,
        created_at,activated_at,suspended_at,revoked_at,recorded_at
      ) SELECT sale_namespace_activation_id,$2,$3,community_id,family,canonical_root,display_root,
        namespace_authority_kind,$4,$5,serving_kind,dns_zone_activation_id,dns_zone_activation_generation,
        root_replacement_kind,dedicated_root_replacement_confirmed,status,reason_code,
        actor_account_id,authority_grant_id,created_at,activated_at,suspended_at,revoked_at,clock_timestamp()
        FROM community_handle_sale_namespace_activation_revisions
        WHERE sale_namespace_activation_id=$1 AND sale_namespace_activation_generation=$6`,
      values: [
        currentSale.sale_namespace_activation_id,
        generation,
        hash,
        input.evidence_ref,
        input.expected_binding_generation + 1,
        currentSale.current_generation,
      ],
      readonly: false,
    });
    if (revision.rowCount !== 1) return yield* new HnsHostRefreshFailed({});
    const current = yield* transaction.execute({
      label: "hns-ownership.refresh-sale-current",
      text: `UPDATE community_handle_sale_namespace_activation_current SET current_generation=$2,
        updated_at=clock_timestamp() WHERE sale_namespace_activation_id=$1 AND current_generation=$3`,
      values: [
        currentSale.sale_namespace_activation_id,
        generation,
        currentSale.current_generation,
      ],
      readonly: false,
    });
    if (current.rowCount !== 1) return yield* new HnsHostRefreshFailed({});
  }
});
