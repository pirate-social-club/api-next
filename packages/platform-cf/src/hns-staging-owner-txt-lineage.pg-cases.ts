import { expect } from "bun:test";
import { ControlPlaneDb, type ControlPlaneTransaction } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { deferExpiredHnsRecoveryHosts } from "./hns-owner-recovery-expired-dns.ts";
import { hnsExpiredRecoveryOriginSql } from "./hns-owner-recovery-expired-lineage.ts";
import { readHnsStagingOwnerTxtRecovery } from "./hns-staging-owner-txt-recovery.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

/** Everything the expired-DNS deferral reads. No UPDATE: FOR SHARE on any of these
 * would need it, and the serving role holds none on the immutable evidence tables. */
const DEFERRAL_READS = [
  "community_route_revalidation_sessions",
  "community_route_revalidation_completion_attempts",
  "community_route_revalidation_start_reservations",
  "community_route_lifecycle_transitions",
  "community_route_ownership_evidence",
  "community_canonical_route_bindings",
  "hns_community_app_host_activation_revisions",
  "hns_community_app_host_activation_current",
  "community_handle_sale_namespace_activation_revisions",
  "community_handle_sale_namespace_activation_current",
  "hns_dns_zone_activation_current",
  "hns_dns_zone_activation_revisions",
  "hns_authority_inventories",
  "hns_dns_zone_health_observations",
];

const SESSION = "owner-txt-session";
const origin = (admin: Client, maxHops?: number) =>
  admin.query<{ transition_id: string; expiry_generation: string }>(
    `SELECT expiry_origin.transition_id,expiry_origin.expiry_generation
     FROM community_route_revalidation_sessions session
     JOIN LATERAL (${hnsExpiredRecoveryOriginSql("session", maxHops)}) expiry_origin ON TRUE
     WHERE session.revalidation_session_id=$1`,
    [SESSION],
  );

/** Two real expired polls precede this verified recovery. Each hop must hold on its
 * own: a foreign principal, a forged terminal document or a mismatched reservation
 * anywhere in the chain ends the walk with no origin, rather than skipping that hop.
 * Immutability triggers are off only inside each rolled-back tamper transaction. */
export async function verifyHnsOwnerTxtExpiredLineage(input: {
  readonly admin: Client;
  readonly connection: string;
  readonly review: unknown;
  readonly root_import_session_id: string;
  readonly deferral: null | {
    readonly community_id: string;
    readonly route_binding_id: string;
    readonly expected_binding_generation: number;
    readonly evidence_ref: string;
    readonly recovery_id: string;
  };
}) {
  const { admin } = input;
  expect((await origin(admin, 1)).rows).toEqual([]);
  expect((await origin(admin, 2)).rows).toMatchObject([{ expiry_generation: "2" }]);
  expect((await origin(admin)).rows).toEqual((await origin(admin, 2)).rows);
  const direct: ControlPlaneTransaction = {
    execute: ({ text, values }: { text: string; values?: readonly unknown[] }) =>
      Effect.promise(() => admin.query(text, values as unknown[])),
  } as unknown as ControlPlaneTransaction;
  const deferred = (deferral: NonNullable<typeof input.deferral>) =>
    Effect.runPromise(deferExpiredHnsRecoveryHosts(direct, deferral));
  if (input.deferral !== null) expect(await deferred(input.deferral)).toBe(true);
  for (const session of ["expired-owner-txt-1-session", "expired-owner-txt-0-session"])
    for (const tamper of [
      `UPDATE community_route_revalidation_sessions SET principal_id='foreign-actor'
       WHERE revalidation_session_id=$1`,
      `UPDATE community_route_revalidation_completion_attempts SET result_hash=repeat('0',64)
       WHERE revalidation_session_id=$1`,
      `UPDATE community_route_revalidation_start_reservations SET requirement_hash=repeat('1',64)
       WHERE revalidation_session_id=$1`,
    ]) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role=replica");
        expect((await admin.query(tamper, [session])).rowCount).toBe(1);
        expect((await origin(admin)).rows).toEqual([]);
        await expect(
          readHnsStagingOwnerTxtRecovery(admin, {
            review: input.review,
            root_import_session_id: input.root_import_session_id,
            lock: false,
          }),
        ).rejects.toThrow("recovery lineage is unavailable");
        if (input.deferral !== null) expect(await deferred(input.deferral)).toBe(false);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
  if (input.deferral === null) return;
  const role = `hns_lineage_runtime_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  const schema = (await admin.query("SELECT current_schema() AS name")).rows[0]?.name;
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  try {
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    for (const table of DEFERRAL_READS)
      await admin.query(`GRANT SELECT ON "${table}" TO "${role}"`);
    const url = new URL(input.connection);
    url.username = role;
    url.password = password;
    const runtime = new Client({ connectionString: url.toString() });
    await runtime.connect();
    try {
      expect((await runtime.query("SELECT current_user AS role")).rows[0]?.role).toBe(role);
    } finally {
      await runtime.end();
    }
    const deferral = input.deferral;
    expect(
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            deferExpiredHnsRecoveryHosts(transaction, deferral),
          );
        }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(url.toString()))),
      ),
    ).toBe(true);
  } finally {
    await admin.query(`DROP OWNED BY "${role}"`);
    await admin.query(`DROP ROLE "${role}"`);
  }
}
