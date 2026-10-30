import { expect } from "bun:test";
import {
  pollHnsOwnerRecovery,
  startHnsOwnerRecovery,
} from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import type { Client } from "pg";
import { makeControlPlaneHnsOwnerRecoveryPollStore } from "./hns-owner-recovery-poll-repository.ts";
import {
  makeControlPlaneHnsOwnerRecoveryAuthorityResolver,
  makeControlPlaneHnsOwnerRecoveryStartStore,
} from "./hns-owner-recovery-start-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

/** Isolated test-schema clock only. Every caller must explicitly put this
 * schema before pg_catalog before preparing SQL. No guard or system clock is
 * changed, and the production one-hour challenge remains one hour. */
export async function applyOwnerTxtClockFixtureBaseline(
  admin: Client,
  applyBaseline: (client: { query: (text: string) => Promise<unknown> }) => Promise<void>,
) {
  await admin.query(`CREATE FUNCTION clock_timestamp() RETURNS timestamptz
    LANGUAGE SQL VOLATILE AS $$ SELECT pg_catalog.clock_timestamp() $$`);
  let clockPath = 0;
  await applyBaseline({
    query: (text) => {
      // The baseline's test-schema setup normally puts pg_catalog implicitly
      // first. Explicitly put it after this isolated clock before parsing
      // defaults too. Every baseline DDL statement stays byte-identical.
      if (text.startsWith("DO $baseline_search_path$")) {
        const original = "pg_catalog.format('%I, pg_temp', target_schema)";
        expect(text.split(original)).toHaveLength(2);
        clockPath++;
        return admin.query(
          text.replace(original, "pg_catalog.format('%I, pg_catalog, pg_temp', target_schema)"),
        );
      }
      if (text.startsWith("-- GENERATED FILE. DO NOT EDIT.")) {
        // The generated baseline has its own matching setup prelude too.
        const original = "pg_catalog.format('%I, pg_temp', pg_catalog.current_schema())";
        expect(text.split(original)).toHaveLength(2);
        clockPath++;
        return admin.query(
          text.replace(
            original,
            "pg_catalog.format('%I, pg_catalog, pg_temp', pg_catalog.current_schema())",
          ),
        );
      }
      return admin.query(text);
    },
  });
  expect(clockPath).toBe(2);
  expect(
    (
      await admin.query(`SELECT 'clock_timestamp()'::regprocedure::oid=
    (SELECT oid FROM pg_proc WHERE proname='clock_timestamp'
      AND pronamespace=current_schema()::regnamespace) AS fixture_clock`)
    ).rows,
  ).toEqual([{ fixture_clock: true }]);
  expect(
    (
      await admin.query(`SELECT count(*)::int AS bound FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    JOIN pg_depend dependency ON dependency.classid='pg_attrdef'::regclass
      AND dependency.objid=d.oid AND dependency.refclassid='pg_proc'::regclass
      AND dependency.refobjid='clock_timestamp()'::regprocedure
    WHERE d.adrelid='community_route_ownership_evidence'::regclass
      AND a.attname='created_at'`)
    ).rows,
  ).toEqual([{ bound: 1 }]);
}

export async function expireOwnerTxtFixtureSessions(
  admin: Client,
  connection: string,
  count: number,
) {
  if (count === 0) return;
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const guards = () =>
    admin.query(`SELECT oid,proname,proconfig,md5(pg_get_functiondef(oid)) AS body
      FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
        AND (proname LIKE 'guard_hns_owner_recovery_%'
          OR proname LIKE 'validate_hns_owner_recovery_%') ORDER BY oid`);
  const before = (await guards()).rows;
  expect(before).toHaveLength(7);
  expect(before.every((row) => row.proconfig === null)).toBe(true);
  for (let index = 0; index < count; index++) {
    const prefix = `expired-owner-txt-${index}`;
    const started = await Effect.runPromise(
      Effect.scoped(
        startHnsOwnerRecovery(
          {
            actor_id: "actor-root-import",
            community_id: "community-root-import",
            expected_generation: 2 + index,
            idempotency_key: prefix,
          },
          {
            authority: makeControlPlaneHnsOwnerRecoveryAuthorityResolver(layer),
            store: makeControlPlaneHnsOwnerRecoveryStartStore(layer),
            provider: {
              start: (request) =>
                Effect.succeed({
                  upstream_session_ref: prefix,
                  expires_at: request.challenge_expires_at,
                  presentation: {
                    kind: "embedded_sdk",
                    session_id: prefix,
                    protocol: "hns-txt-challenge",
                    version: "1",
                    payload: {
                      ownership_source: "hns_parent_chain_txt",
                      challenge_name: "newroot",
                      challenge_value: `pirate-verification=${prefix}`,
                      expires_at: request.challenge_expires_at,
                    },
                  },
                }),
            },
            ids: {
              reservation: () => `${prefix}-reservation`,
              recovery: () => `${prefix}-recovery`,
              session: () => `${prefix}-session`,
            },
          },
        ),
      ),
    );
    expect(started).toMatchObject({ status: "pending", generation: 2 + index });
    expect(
      (
        await admin.query(
          `SELECT status,
          extract(epoch FROM expires_at-started_at)::int AS lifetime,
          expires_at>clock_timestamp() AS fresh
          FROM community_route_revalidation_sessions WHERE revalidation_session_id=$1`,
          [started.session_id],
        )
      ).rows,
    ).toEqual([{ status: "pending", lifetime: 3600, fresh: true }]);
    // Advance only this fixture clock after the real start transaction commits.
    // The normal poll writer creates the terminal document, fence and gen3/4.
    await admin.query(`CREATE OR REPLACE FUNCTION clock_timestamp() RETURNS timestamptz
      LANGUAGE SQL VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()
      + INTERVAL '${3601 * (index + 1)} seconds' $$`);
    let providerCalls = 0;
    expect(
      await Effect.runPromise(
        Effect.scoped(
          pollHnsOwnerRecovery(
            {
              actor_id: "actor-root-import",
              community_id: "community-root-import",
              route_recovery_id: started.route_recovery_id,
              session_id: started.session_id,
              expected_generation: 2 + index,
              idempotency_key: `${prefix}-poll`,
              channel: "poll_result",
            },
            {
              store: makeControlPlaneHnsOwnerRecoveryPollStore(layer),
              provider: {
                poll: () => {
                  providerCalls++;
                  return Effect.succeed(Buffer.from("{}"));
                },
              },
              policy: {
                expected_block_interval_seconds: 600,
                minimum_safe_remaining_blocks: 1,
                expiry_safety_blocks: 100,
                evidence_lease_seconds: 2592000,
              },
              ids: {
                attempt: () => `${prefix}-attempt`,
                evidence: () => `${prefix}-unused-evidence`,
                observation: () => `${prefix}-observation`,
              },
            },
          ),
        ),
      ),
    ).toMatchObject({ status: "expired", generation: 3 + index });
    expect(providerCalls).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT s.status,a.consumption_kind,
          a.terminal_at>=s.expires_at AS expired,
          validate_hns_owner_recovery_terminal_document(
            a.terminal_result_document,a.result_hash,a.terminal_result_version,
            a.route_revalidation_id,a.revalidation_session_id,
            a.route_revalidation_attempt_id,a.route_binding_id,
            a.expected_binding_generation,a.idempotency_key,
            a.completion_request_hash,a.consumption_kind) AS valid
          FROM community_route_revalidation_sessions s
          JOIN community_route_revalidation_completion_attempts a
            USING (route_revalidation_id,revalidation_session_id)
          WHERE s.revalidation_session_id=$1`,
          [started.session_id],
        )
      ).rows,
    ).toEqual([
      { status: "expired", consumption_kind: "session_expired", expired: true, valid: true },
    ]);
    expect(
      (await admin.query("SHOW session_replication_role")).rows[0]?.session_replication_role,
    ).toBe("origin");
    expect(
      (
        await admin.query(`SELECT count(*)::int AS disabled FROM pg_trigger
        WHERE tgrelid IN ('community_route_revalidation_sessions'::regclass,
          'community_route_revalidation_start_reservations'::regclass,
          'community_route_revalidation_completion_attempts'::regclass)
          AND tgenabled<>'O'`)
      ).rows[0]?.disabled,
    ).toBe(0);
  }
  expect((await guards()).rows).toEqual(before);
}
