import { expect } from "bun:test";
import { ControlPlaneDb, type ControlPlaneTransaction } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { deferExpiredHnsRecoveryHosts } from "./hns-owner-recovery-expired-dns.ts";
import { hnsExpiredRecoveryOriginSql } from "./hns-owner-recovery-expired-lineage.ts";
import { readHnsStagingOwnerTxtRecovery } from "./hns-staging-owner-txt-recovery.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

/** Everything the expired-DNS deferral reads. This role gets SELECT only, deliberately
 * stricter than any real serving role, so a FOR SHARE on any of these fails here. */
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

const TERMINAL_VALIDATOR =
  "validate_hns_owner_recovery_terminal_document(text,text,text,text,text,text,text,bigint,text,text,text)";
const SESSION = "owner-txt-session";
const HOPS = ["expired-owner-txt-1-session", "expired-owner-txt-0-session"] as const;
const SESSIONS = "community_route_revalidation_sessions";
const ATTEMPTS = "community_route_revalidation_completion_attempts";
const RESERVATIONS = "community_route_revalidation_start_reservations";

/** $1 is the hop. Session and reservation move together where they must, so the
 * predicate under test refuses rather than the reservation comparison. */
const both = (set: string) => [
  `UPDATE ${SESSIONS} SET ${set} WHERE revalidation_session_id=$1`,
  `UPDATE ${RESERVATIONS} SET ${set} WHERE revalidation_session_id=$1`,
];
const refusedAtEveryHop: readonly (readonly [string, readonly string[]])[] = [
  ["foreign principal", both("principal_id='foreign-actor'")],
  ["foreign provider binding", both("provider_binding_hash=repeat('9',64)")],
  ["foreign provider configuration", both("provider_configuration_digest=repeat('9',64)")],
  ["foreign community", both("community_id='other-community'")],
  ["foreign environment", both("environment='production'")],
  ["session failed", [`UPDATE ${SESSIONS} SET status='failed' WHERE revalidation_session_id=$1`]],
  [
    "session completed",
    [`UPDATE ${SESSIONS} SET status='completed' WHERE revalidation_session_id=$1`],
  ],
  [
    "attempt consumed as root absent",
    [`UPDATE ${ATTEMPTS} SET consumption_kind='root_absent' WHERE revalidation_session_id=$1`],
  ],
  [
    "attempt consumed as verified",
    [`UPDATE ${ATTEMPTS} SET consumption_kind='verified' WHERE revalidation_session_id=$1`],
  ],
  [
    "attempt bound to evidence",
    [
      `UPDATE ${ATTEMPTS} SET expected_verified_evidence_ref='evidence-root-import'
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "attempt holds a provider response",
    [
      `UPDATE ${ATTEMPTS} SET provider_response_sha256=repeat('a',64)
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "attempt holds raw provider bytes",
    [
      `UPDATE ${ATTEMPTS} SET raw_provider_response_bytes='\\x00'
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "attempt ended after its session",
    [
      `UPDATE ${ATTEMPTS} attempt SET terminal_at=session.terminal_at+INTERVAL '1 second'
       FROM ${SESSIONS} session
       WHERE session.revalidation_session_id=attempt.revalidation_session_id
         AND attempt.revalidation_session_id=$1`,
    ],
  ],
  [
    "reservation fence differs",
    [`UPDATE ${RESERVATIONS} SET fence_token=fence_token+7 WHERE revalidation_session_id=$1`],
  ],
  [
    "attempt created and ended before the challenge expired",
    [
      `UPDATE ${ATTEMPTS} attempt SET created_at=session.challenge_expires_at-INTERVAL '2 seconds',
         terminal_at=session.challenge_expires_at-INTERVAL '1 second'
       FROM ${SESSIONS} session
       WHERE session.revalidation_session_id=attempt.revalidation_session_id
         AND attempt.revalidation_session_id=$1`,
    ],
  ],
  [
    "attempt in system mode with a null version document",
    [
      `UPDATE ${ATTEMPTS} SET operation_mode='system_revalidation',observation_id=NULL,
         terminal_result_version=NULL,
         terminal_result_document=regexp_replace(terminal_result_document,'^\\["[^"]*"','[null'),
         result_hash=encode(sha256(convert_to(
           regexp_replace(terminal_result_document,'^\\["[^"]*"','[null'),'UTF8')),'hex')
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "session window is not one hour",
    [
      `UPDATE ${SESSIONS} SET started_at=started_at-INTERVAL '1 second'
       WHERE revalidation_session_id=$1`,
    ],
  ],
];
/** Each set one chain link wrong; the targets differ by hop, so they are spelled out. */
const refusedOnce: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "reference skips a generation",
    SESSION,
    [
      `UPDATE ${SESSIONS} SET recovery_authority_reference='expired-owner-txt-0-attempt'
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "child is not an owner recovery",
    SESSION,
    [
      `UPDATE ${SESSIONS} SET recovery_authority_kind='route_revalidation_terminal'
       WHERE revalidation_session_id=$1`,
    ],
  ],
  [
    "hop one ended after the verified session started",
    HOPS[0],
    [
      `UPDATE ${SESSIONS} prior SET terminal_at=child.started_at+INTERVAL '1 second'
       FROM ${SESSIONS} child
       WHERE child.revalidation_session_id='${SESSION}' AND prior.revalidation_session_id=$1`,
    ],
  ],
  [
    "hop zero ended after hop one started",
    HOPS[1],
    [
      `UPDATE ${SESSIONS} prior SET terminal_at=child.started_at+INTERVAL '1 second'
       FROM ${SESSIONS} child
       WHERE child.revalidation_session_id='${HOPS[0]}' AND prior.revalidation_session_id=$1`,
    ],
  ],
];
/** The schema refuses these single-column writes outright. Pinned here so that loosening
 * a constraint is noticed. This says nothing about compound rows: the attempt time and
 * mode predicates are reachable that way and are pinned in refusedAtEveryHop. */
const refusedAtWrite: readonly (readonly [string, string])[] = [
  [
    "attempt not consumed",
    `UPDATE ${ATTEMPTS} SET state='leased' WHERE revalidation_session_id=$1`,
  ],
  [
    "attempt not a same root recovery",
    `UPDATE ${ATTEMPTS} SET operation_mode='system_revalidation' WHERE revalidation_session_id=$1`,
  ],
  [
    "attempt ended before the challenge expired",
    `UPDATE ${ATTEMPTS} attempt SET terminal_at=session.challenge_expires_at-INTERVAL '1 second'
     FROM ${SESSIONS} session
     WHERE session.revalidation_session_id=attempt.revalidation_session_id
       AND attempt.revalidation_session_id=$1`,
  ],
  [
    "reservation not finalized",
    `UPDATE ${RESERVATIONS} SET state='acquired' WHERE revalidation_session_id=$1`,
  ],
  [
    "session expiry differs from its challenge",
    `UPDATE ${SESSIONS} SET expires_at=expires_at+INTERVAL '1 second'
     WHERE revalidation_session_id=$1`,
  ],
  [
    "reservation bound to evidence",
    `UPDATE ${RESERVATIONS} SET expected_verified_evidence_ref='evidence-root-import'
     WHERE revalidation_session_id=$1`,
  ],
  [
    "session is a system revalidation",
    `UPDATE ${SESSIONS} SET operation_mode='system_revalidation' WHERE revalidation_session_id=$1`,
  ],
  [
    "session bound to evidence",
    `UPDATE ${SESSIONS} SET expected_verified_evidence_ref='evidence-root-import'
     WHERE revalidation_session_id=$1`,
  ],
];

const origin = (admin: Client, maxHops?: number) =>
  admin.query<{ transition_id: string; expiry_generation: string }>(
    `SELECT expiry_origin.transition_id,expiry_origin.expiry_generation
     FROM community_route_revalidation_sessions session
     JOIN LATERAL (${hnsExpiredRecoveryOriginSql("session", maxHops)}) expiry_origin ON TRUE
     WHERE session.revalidation_session_id=$1`,
    [SESSION],
  );

/** Two real expired polls precede this verified recovery. Each hop must hold on its
 * own: any tamper below ends the walk with no origin rather than skipping that hop, and
 * the coherent ones reach the owner continuity and hop predicates themselves.
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
  const inTamper = async (use: () => Promise<void>) => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role=replica");
      await use();
    } finally {
      await admin.query("ROLLBACK");
    }
  };
  const tampered = (label: string, session: string, statements: readonly string[]) =>
    inTamper(async () => {
      for (const statement of statements)
        expect({ label, rows: (await admin.query(statement, [session])).rowCount }).toEqual({
          label,
          rows: 1,
        });
      expect({ label, origin: (await origin(admin)).rows }).toEqual({ label, origin: [] });
      await expect(
        readHnsStagingOwnerTxtRecovery(admin, {
          review: input.review,
          root_import_session_id: input.root_import_session_id,
          lock: false,
        }),
      ).rejects.toThrow("recovery lineage is unavailable");
      if (input.deferral !== null) expect(await deferred(input.deferral)).toBe(false);
    });
  for (const session of HOPS) {
    for (const [label, statements] of refusedAtEveryHop) await tampered(label, session, statements);
    await tampered("forged result hash", session, [
      `UPDATE ${ATTEMPTS} SET result_hash=repeat('0',64) WHERE revalidation_session_id=$1`,
    ]);
    await tampered("reservation disagrees", session, [
      `UPDATE ${RESERVATIONS} SET requirement_hash=repeat('1',64)
       WHERE revalidation_session_id=$1`,
    ]);
    for (const [label, statement] of refusedAtWrite)
      await inTamper(async () => {
        await expect(admin.query(statement, [session]), label).rejects.toThrow("check constraint");
      });
  }
  for (const [label, session, statements] of refusedOnce)
    await tampered(label, session, statements);
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
    // The baseline schema leaves routines open to PUBLIC, which would hide a missing grant.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${TERMINAL_VALIDATOR} FROM PUBLIC`);
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
    const asRuntime = Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        deferExpiredHnsRecoveryHosts(transaction, deferral),
      );
    }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(url.toString())));
    await expect(Effect.runPromise(asRuntime)).rejects.toThrow();
    await admin.query(`GRANT EXECUTE ON FUNCTION ${TERMINAL_VALIDATOR} TO "${role}"`);
    expect(await Effect.runPromise(asRuntime)).toBe(true);
  } finally {
    await admin.query(`GRANT EXECUTE ON FUNCTION ${TERMINAL_VALIDATOR} TO PUBLIC`);
    await admin.query(`DROP OWNED BY "${role}"`);
    await admin.query(`DROP ROLE "${role}"`);
  }
}
