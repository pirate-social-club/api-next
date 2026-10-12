import { expect } from "bun:test";
import type { KaraokeSessionAuthority } from "@pirate/application";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import type { Runtime } from "./activity-participation-composed-drivers.pg-fixture.ts";
import {
  confirmWallet,
  prepareIdentity,
} from "./activity-participation-composed-identity.pg-fixture.ts";
import { seedActivitySong } from "./activity-participation-composed-song.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

export const policy1 = "karaoke_qualification_v2@1";
export const policy2 = "karaoke_qualification_v2@2";
export const migrationVersion = "0247_karaoke_instrumental_qualification_policy.sql";

export async function withPolicyDatabase(
  connectionString: string,
  predecessor: boolean,
  run: (fixture: { admin: Client; scoped: string; runtime: Runtime }) => Promise<void>,
) {
  const schema = `karaoke_policy_${crypto.randomUUID().replaceAll("-", "")}`;
  const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  try {
    if (predecessor) {
      const migrations = await loadPostgresMigrations();
      const index = migrations.findIndex(({ version }) => version === migrationVersion);
      if (index < 0) throw new Error("policy migration missing");
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: migrations.slice(0, index),
      });
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_test_fixture') FROM reward_operations_control WHERE singleton",
      );
    } else {
      await applyPostgresTestBaselineConnection({ connectionString: scoped, rewardsRunning: true });
    }
    await admin.query("SET session_replication_role=replica");
    try {
      await seedActivitySong(admin);
    } finally {
      await admin.query("SET session_replication_role=origin");
    }
    await run({ admin, scoped, runtime: makeDirectPostgresControlPlaneLayer(scoped) });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

export async function prepareSinger(admin: Client, runtime: Runtime, accountId: string) {
  await admin.query("INSERT INTO users(user_id) VALUES ($1)", [accountId]);
  const prepared = await prepareIdentity(runtime)(accountId, `prepare-${accountId}`);
  await confirmWallet(runtime)(accountId, prepared.persona_id);
  return prepared.persona_id;
}

/** Insert a historical producer's full-mix take; never rewrite an admitted session's pins. */
export async function insertFullMixSession(
  admin: Client,
  source: KaraokeSessionAuthority,
  suffix: string,
) {
  const authority = {
    ...source,
    sessionId: `historical-session-${suffix}`,
    attemptId: `historical-attempt-${suffix}`,
    artifactId: `historical-artifact-${suffix}`,
    playbackKind: "full_mix" as const,
  };
  await admin.query(
    `INSERT INTO karaoke_sessions (
       session_id,attempt_id,account_id,persona_id,community_id,post_id,audio_revision,
       karaoke_revision_id,qualification_policy_version_id,endpoint_template,idempotency_key,
       request_hash,timezone,status,created_at,expires_at,completed_at,playback_kind,
       lyrics_revision,scoring_version,scoring_provider,scoring_model,line_snapshot,client_context
     ) SELECT $2,$3,account_id,persona_id,community_id,post_id,audio_revision,
       karaoke_revision_id,qualification_policy_version_id,endpoint_template,$4,
       request_hash,timezone,status,created_at,expires_at,completed_at,'full_mix',
       lyrics_revision,scoring_version,scoring_provider,scoring_model,line_snapshot,client_context
       FROM karaoke_sessions WHERE session_id=$1`,
    [source.sessionId, authority.sessionId, authority.attemptId, `historical-${suffix}`],
  );
  await admin.query(
    `INSERT INTO karaoke_recordings(session_id,attempt_id,account_id,artifact_id,created_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz)`,
    [
      authority.sessionId,
      authority.attemptId,
      authority.accountId,
      authority.artifactId,
      authority.createdAt,
    ],
  );
  return authority;
}

export async function qualificationCounts(admin: Client, account: string) {
  return (
    await admin.query(
      `SELECT (SELECT count(*)::integer FROM activity_qualifications WHERE account_id=$1) AS qualifications,
      (SELECT count(*)::integer FROM megapot_pool_shares WHERE account_id=$1) AS shares`,
      [account],
    )
  ).rows[0];
}

export async function assertTransitionGuards(admin: Client, sql: string) {
  const registry =
    "SELECT to_jsonb(r) AS row FROM activity_registry r WHERE activity_key='karaoke'";
  const policies =
    "SELECT to_jsonb(p) AS row FROM qualification_policy_versions p WHERE activity_key='karaoke' ORDER BY qualification_policy_version_id";
  const cases = [
    "UPDATE activity_registry SET current_policy_version_id='karaoke_qualification_v1@1' WHERE activity_key='karaoke'",
    "UPDATE activity_registry SET producer_version='unexpected_producer' WHERE activity_key='karaoke'",
    "UPDATE activity_registry SET status='reserved',producer_version=NULL,current_policy_version_id=NULL WHERE activity_key='karaoke'",
    "UPDATE qualification_policy_versions SET policy_document=jsonb_set(policy_document,'{eligible_playback_kinds}','[\"instrumental\"]') WHERE qualification_policy_version_id='karaoke_qualification_v2@1'",
    "INSERT INTO qualification_policy_versions SELECT 'karaoke_qualification_v2@2',activity_key,policy_kind,policy_document,created_at FROM qualification_policy_versions WHERE qualification_policy_version_id='karaoke_qualification_v2@1'",
  ];
  for (const [index, setup] of cases.entries()) {
    await admin.query("BEGIN");
    try {
      // Only the corrupt predecessor-document fixture bypasses append-only protection.
      if (index === 3) await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query(setup);
      if (index === 3) await admin.query("SET LOCAL session_replication_role=origin");
      const beforeRegistry = (await admin.query(registry)).rows;
      const beforePolicies = (await admin.query(policies)).rows;
      await admin.query("SAVEPOINT transition_attempt");
      await expect(admin.query(sql)).rejects.toMatchObject({
        code: index === 4 ? "23505" : "P0001",
      });
      await admin.query("ROLLBACK TO SAVEPOINT transition_attempt");
      expect((await admin.query(registry)).rows).toEqual(beforeRegistry);
      expect((await admin.query(policies)).rows).toEqual(beforePolicies);
    } finally {
      await admin.query("ROLLBACK");
    }
  }
}
