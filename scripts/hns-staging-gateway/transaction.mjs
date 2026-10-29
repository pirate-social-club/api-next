import { promoteHnsAuthoritySuccessorInTransaction } from "../../packages/platform-cf/src/hns-authority-successor-promotion.ts";
import { requireHnsGatewayRotationFence } from "../../packages/platform-cf/src/hns-gateway-rotation.ts";
import { readContinuityState } from "../hns-continuity/database.mjs";
import { bytes, fail, reference, stateIdentity } from "./identity.mjs";

/** Both modes use the same atomic writer and uncertain-COMMIT boundary.
 * The caller supplies its fixed, reviewed tenant fences; this is not a CLI root option. */
export async function executeGatewayEntries({
  client,
  plan,
  confirmedSha256,
  mode,
  beforeEntries,
  afterEntries,
}) {
  let open = false;
  try {
    await client.query(
      `BEGIN ISOLATION LEVEL SERIALIZABLE${mode === "preflight" ? " READ ONLY" : ""}`,
    );
    open = true;
    await client.query("SET LOCAL search_path TO api_next, public");
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    await beforeEntries();
    for (const entry of plan.entries) {
      if (mode !== "preflight") {
        const locked = await client.query(
          `SELECT dns.current_generation FROM hns_dns_zone_activation_current dns
          JOIN hns_community_app_host_activation_current app ON app.normalized_host='app.'||dns.canonical_root
          JOIN community_handle_sale_namespace_activation_current sale ON sale.canonical_root=dns.canonical_root
          WHERE dns.canonical_root=$1 FOR UPDATE OF dns,app,sale`,
          [entry.root],
        );
        fail(locked.rows.length === 1, "Root selector lock unavailable");
      }
      const current = await readContinuityState(client, entry.root);
      fail(
        stateIdentity(current) === entry.predecessor_sha256,
        "Predecessor changed; prepare again",
      );
      fail(
        Date.parse(current.database_time) <= Date.parse(plan.execute_by),
        "Execution window elapsed",
      );
      await requireHnsGatewayRotationFence({
        client,
        dnsActivationId: current.dns.dns_zone_activation_id,
        successorGeneration: entry.generations.dns_activation_generation,
        successorGatewayReference: reference(plan.next_manifest),
        certificateSpki: current.dns.gateway_certificate_spki_sha256,
        rotation: {
          reviewed: plan.readiness,
          previousHealthGeneration: Number(current.health.health_generation),
        },
      });
      const s = current.sale,
        d = current.dns;
      const dependency = await client.query(
        "SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())",
        [
          s.community_id,
          s.namespace_authority_reference,
          Number(s.namespace_authority_generation),
          d.dns_zone_activation_id,
          Number(d.dns_zone_activation_generation),
        ],
      );
      fail(
        dependency.rows.length === 1 &&
          dependency.rows[0].namespace_authority_current &&
          dependency.rows[0].dns_zone_current &&
          dependency.rows[0].dns_delegation_current,
        "Current namespace authority unavailable",
      );
    }
    const results = [];
    if (mode !== "preflight")
      for (const entry of plan.entries) {
        const state = entry.predecessor;
        const result = await promoteHnsAuthoritySuccessorInTransaction({
          client,
          inventoryRegistryReference: state.inventory.registry_reference,
          authorityInventoryBytes: bytes(state.inventory.bytes_hex),
          dnsActivationBytes: bytes(entry.dns_hex),
          appActivationBytes: bytes(entry.app_hex),
          healthObservationBytes: bytes(entry.health_hex),
          successorId: entry.successor_id,
          gatewayRotation: {
            reviewed: plan.readiness,
            previousHealthGeneration: Number(state.health.health_generation),
          },
          rootLabel: entry.root,
          generations: entry.generations,
          sale: state.sale,
        });
        const after = await readContinuityState(client, entry.root);
        for (const key of [
          "community_id",
          "canonical_root",
          "normalized_host",
          "route_binding_id",
          "route_authority_kind",
          "route_authority_reference",
          "route_authority_generation",
        ]) {
          fail(
            after.app[key] === state.app[key],
            "Successor changed unrelated app route authority",
          );
        }
        fail(
          after.app.gateway_deployment_reference === reference(plan.next_manifest),
          "Successor app gateway mismatch",
        );
        fail(
          new Date(after.health.valid_until).getTime() <= Date.parse(entry.health_deadline) &&
            Date.parse(after.database_time) <= Date.parse(plan.execute_by),
          "Successor would extend evidence or exceed execution window",
        );
        results.push({ root: entry.root, ...result, health_valid_until: after.health.valid_until });
      }
    await afterEntries();
    if (mode === "commit") {
      open = false;
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
      open = false;
    }
    return { mode, committed: mode === "commit", plan_sha256: confirmedSha256, results };
  } finally {
    if (open) await client.query("ROLLBACK");
  }
}
