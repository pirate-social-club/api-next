import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  makeSongMegapotContributionReads,
  makeSongMegapotContributions,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongContributionReadPorts,
} from "./song-megapot-contribution-repository.ts";

// Exact isolated293->294 upgrade and synthetic identities. No provider, managed
// database, real wallet or monetary policy is used by this suite.
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Isolated Postgres URL required");
const suite = url ? describe : describe.skip;
const schema = `refusal_upgrade_${process.pid}_${Date.now()}`;
const admin = new Client({ connectionString: url });
let connected = false;
const connectionString = () => {
  if (!url) throw new Error("Isolated Postgres URL required");
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  return scoped.toString();
};
const roles = new Set<string>();
setDefaultTimeout(30_000);
beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  connected = true;
  await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  const migrations = await loadPostgresMigrations();
  const boundary = migrations.findIndex((m) => m.version === "0294_song_contribution_refusals.sql");
  expect(boundary).toBe(293);
  const prefix = await runPostgresMigrations({
    connectionString: connectionString(),
    migrations: migrations.slice(0, boundary),
    expectedLedger: [],
  });
  if (prefix.dryRun) throw new Error("Expected actual isolated migration prefix");
  expect(prefix.result.currentVersion).toBe(
    "0293_moderated_dance_notification_recovery_bounds.sql",
  );
  const upgrade = await runPostgresMigrations({ connectionString: connectionString(), migrations });
  if (upgrade.dryRun) throw new Error("Expected actual isolated migration upgrade");
  expect(upgrade.result.currentVersion).toBe("0294_song_contribution_refusals.sql");
});
afterAll(async () => {
  if (!connected) return;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const role of roles) await admin.query(`DROP ROLE "${role}"`);
  } finally {
    await admin.end();
  }
});
const scope = { communityId: "refusal-community", postId: "refusal-song", contributionId: null };
const hash = "a".repeat(64);
const request = (key: string): C.ContributionRequestV2 => ({
  version: 2,
  idempotency_key: key,
  persona_id: "refusal-persona",
  funding_amount_atomic: "1000000",
  expected_context_hash: hash,
  expected_lifecycle_revision: 0,
  context_version: "funding-context-reference-v1",
  context_slot_id: "refusal-slot",
  context_slot_generation: 0,
  context_leg_snapshot_id: "",
  context_schedule_witness_id: "refusal-witness",
  context_profile_id: "refusal-profile",
  context_profile_hash: hash,
  context_funding_policy_hash: hash,
  context_wallet_assignment_id: "refusal-wallet",
  context_wallet_assignment_revision: 0,
  context_lifecycle_revision: 0,
  expected_terms_kind: "prospective",
  expected_terms_hash: hash,
});
async function fixture(
  use: (f: { admin: Client; connectionString: string; schema: string }) => Promise<void>,
) {
  if (!url) throw new Error("Isolated Postgres URL required");
  return use({ admin, connectionString: connectionString(), schema });
}
const service = (connectionString: string, accountId = "refusal-account") =>
  makeSongMegapotContributions(
    makeControlPlaneSongContributionPorts(
      makeDirectPostgresControlPlaneLayer(connectionString),
      { authorize: () => Effect.succeed({ accountId }) },
      { rewardsEnabled: false },
    ),
  );

suite("native Create refusal resolution on the maintained schema", () => {
  test("concurrent same-key refusals commit one original receipt; changed body cannot reopen it", async () =>
    fixture(async ({ admin, connectionString }) => {
      const body = request("native_refusal_key_001");
      const execute = () =>
        Effect.runPromise(
          service(connectionString).execute("CreateSongMegapotContributionV2", scope, body),
        );
      const outcomes = await Promise.allSettled([execute(), execute()]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({
            code: "paused",
            refusalReceipt: { allocation: "none", instruction_issued: false },
          });
      }
      const rows = (
        await admin.query(
          "SELECT receipt,refusal_code,contribution_id FROM song_megapot_contribution_commands_v2 WHERE idempotency_key=$1",
          [body.idempotency_key],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ refusal_code: "paused", contribution_id: null });
      if (outcomes[0]?.status === "rejected" && outcomes[1]?.status === "rejected")
        expect(outcomes[0].reason.refusalReceipt).toEqual(outcomes[1].reason.refusalReceipt);
      await expect(
        Effect.runPromise(
          service(connectionString).execute("CreateSongMegapotContributionV2", scope, {
            ...body,
            funding_amount_atomic: "2000000",
          }),
        ),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const reads = makeSongMegapotContributionReads(
        makeControlPlaneSongContributionReadPorts(
          makeDirectPostgresControlPlaneLayer(connectionString),
          { authorize: () => Effect.succeed({ accountId: "refusal-account" }) },
          { rewardsEnabled: false },
        ),
      );
      await expect(
        Effect.runPromise(
          reads.command(scope, "CreateSongMegapotContributionV2", body.idempotency_key),
        ),
      ).rejects.toMatchObject({ code: "paused", refusalReceipt: rows[0].receipt });
      const foreign = makeSongMegapotContributionReads(
        makeControlPlaneSongContributionReadPorts(
          makeDirectPostgresControlPlaneLayer(connectionString),
          { authorize: () => Effect.succeed({ accountId: "other-account" }) },
          { rewardsEnabled: false },
        ),
      );
      await expect(
        Effect.runPromise(
          foreign.command(scope, "CreateSongMegapotContributionV2", body.idempotency_key),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const value = (
        await admin.query(
          "SELECT load_song_contribution_command_v2('refusal-account','CreateSongMegapotContributionV2',$1) AS packet",
          [body.idempotency_key],
        )
      ).rows[0].packet;
      // Exact pre-repair successful-packet decoder: old Workers fail closed.
      expect(() =>
        Schema.decodeUnknownSync(
          Schema.Struct({ requestHash: C.HashV2, receipt: C.FundingCommandReceiptV2 }),
          { onExcessProperty: "error" },
        )(value),
      ).toThrow();
    }));

  test("SQL constraints prohibit malformed proofs and retain append-only exclusive command ownership", async () =>
    fixture(async ({ admin }) => {
      const identity = {
        ...scope,
        accountId: "constraint-account",
        operation: "CreateSongMegapotContributionV2",
        key: "constraint_key_001",
        hash,
      };
      const packet = (
        await admin.query(
          "SELECT record_song_contribution_refusal_v2($1::jsonb,'paused','constraint-command') AS packet",
          [JSON.stringify(identity)],
        )
      ).rows[0].packet;
      expect(packet.refusal.receipt).toEqual({
        command_id: "constraint-command",
        request_hash: hash,
        allocation: "none",
        instruction_issued: false,
      });
      await expect(
        admin.query(
          "UPDATE song_megapot_contribution_commands_v2 SET refusal_code='policy_unavailable' WHERE command_id='constraint-command'",
        ),
      ).rejects.toMatchObject({ code: "PCV01" });
      await expect(
        admin.query(
          "DELETE FROM song_megapot_contribution_commands_v2 WHERE command_id='constraint-command'",
        ),
      ).rejects.toMatchObject({ code: "PCV01" });
      await expect(
        admin.query(
          "INSERT INTO song_megapot_contribution_commands_v2(command_id,account_id,operation,idempotency_key,request_hash,community_id,post_id,contribution_id,receipt) VALUES('conflicting-success','constraint-account','CreateSongMegapotContributionV2','constraint_key_001',$1,$2,$3,'uncommitted-contribution',$4::jsonb)",
          [
            hash,
            scope.communityId,
            scope.postId,
            JSON.stringify({
              command_id: "conflicting-success",
              request_hash: hash,
              contribution_id: "uncommitted-contribution",
            }),
          ],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      const changes = [
        { allocation: "unknown" },
        { instruction_issued: true },
        { extra: true },
        { request_hash: "b".repeat(64) },
        { instruction_issued: null },
      ];
      for (let index = 0; index < changes.length; index++) {
        const command = `invalid-command-${index}`;
        const proof = {
          command_id: command,
          request_hash: hash,
          allocation: "none",
          instruction_issued: false,
          ...changes[index],
        };
        await expect(
          admin.query(
            "INSERT INTO song_megapot_contribution_commands_v2(command_id,account_id,operation,idempotency_key,request_hash,community_id,post_id,receipt,refusal_code) VALUES($1,'constraint-account','CreateSongMegapotContributionV2',$2,$3,$4,$5,$6::jsonb,'paused')",
            [
              command,
              `invalid_proof_key_${index}`,
              hash,
              scope.communityId,
              scope.postId,
              JSON.stringify(proof),
            ],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        admin.query(
          "SELECT record_song_contribution_refusal_v2($1::jsonb,'outcome_unknown','invalid-unknown-command')",
          [JSON.stringify({ ...identity, key: "unknown_proof_key_01" })],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }));

  test("a separate restricted LOGIN receives only the admitted function capability", async () =>
    fixture(async ({ admin, connectionString, schema }) => {
      const role = `refusal_http_${crypto.randomUUID().replaceAll("-", "")}`;
      // Test-only credential: the same restricted LOGIN must also work when
      // the CI fixture requires SCRAM rather than local-socket trust.
      const fixturePassword = crypto.randomUUID().replaceAll("-", "");
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${fixturePassword}'`);
      roles.add(role);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await admin.query("SELECT bind_reward_contribution_purpose_v2($1,'http_commands')", [role]);
      const restrictedUrl = new URL(connectionString);
      restrictedUrl.username = role;
      restrictedUrl.password = fixturePassword;
      const restricted = new Client({ connectionString: restrictedUrl.toString() });
      try {
        await restricted.connect();
        expect((await restricted.query("SELECT session_user AS role")).rows[0].role).toBe(role);
        await expect(
          restricted.query("SELECT * FROM song_megapot_contribution_commands_v2"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          restricted.query("SELECT bind_reward_contribution_purpose_v2($1,'http_commands')", [
            role,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          Effect.runPromise(
            service(restrictedUrl.toString()).execute(
              "CreateSongMegapotContributionV2",
              scope,
              request("restricted_refusal_001"),
            ),
          ),
        ).rejects.toMatchObject({
          code: "paused",
          refusalReceipt: { allocation: "none", instruction_issued: false },
        });
        const rows = (
          await admin.query(
            "SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname IN('record_song_contribution_refusal_v2','load_song_contribution_command_v2','read_song_contribution_command_v2') ORDER BY proname",
          )
        ).rows;
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.prosecdef).toBe(true);
          expect(row.proconfig).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
        }
      } finally {
        await restricted.end();
      }
    }));
});
