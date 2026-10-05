import { createHash } from "node:crypto";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import { loadPostgresMigrations } from "../postgres-migrations.ts";
import {
  type IsolatedDatabaseIdentity,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";
import { verifyRetiredDatabase } from "./retired-stack-inventory.ts";

export const fixture = {
  community: "community_d77ee63a-e0dc-4162-aab1-ae593b533bda",
  song: "media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b",
  accounts: [
    "usr_1bc2311a-1b87-4837-bfb7-c9cdd31d7f19",
    "usr_87b732b0-6ab4-45fe-a91b-9b4c9f54e15e",
    "usr_00577b1e-2aba-46ca-aea3-3cb4cf4004aa",
  ],
};
const allowed = new Set([
  "users",
  "identity_credentials",
  "account_minimum_age_attestations",
  "personas",
  "persona_profiles",
  "persona_wallet_assignments",
  "persona_community_bindings",
  "persona_activity_presentations",
  "persona_role_presentations",
  "communities",
  "community_memberships",
  "community_follows",
  "community_role_assignments",
  "community_canonical_route_bindings",
  "community_route_ownership_evidence",
  "operator_managed_route_activations",
  "posts",
  "post_slug_aliases",
  "community_feed_projection",
  "song_owner_policies",
  "song_owner_policy_revisions",
  "media_post_submissions",
  "media_upload_reservations",
  "media_immutable_objects",
  "media_audio_revisions",
  "media_song_lyrics_revisions",
  "media_transcript_artifacts",
  "media_analysis_evidence",
  "media_submission_terms",
  "media_publication_decisions",
  "media_publication_projections",
  "media_timed_lyrics_artifacts",
  "media_alignment_projections",
  "media_song_canonical_timings",
  "localization_lyric_line_occurrences",
  "localization_lyrics_revision_lines",
  "localization_lyric_line_versions",
  "localization_study_units",
  "localization_lyric_line_study_units",
  "study_exercise_versions",
  "study_language_profiles",
  "study_language_profile_units",
  "study_unit_exercise_eligibility",
]);
export function fixtureTable(table: string) {
  if (!allowed.has(table)) throw new Error(`Fixture dependency requires review: ${table}`);
  return `api_next."${table}"`;
}
type Row = Record<string, unknown>;
type Node = { table: string; row: Row; dependencies: Set<string> };
type ForeignKey = {
  child: string;
  parent: string;
  child_columns: string[];
  parent_columns: string[];
  deferred: boolean;
};
const column = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid fixture column");
  return `"${name}"`;
};
const importGuards = [
  ["users", "users_provision_first_persona"],
  ["media_alignment_projections", "media_alignment_insert_guard"],
  ["media_post_submissions", "media_submission_insert_authority_guard"],
  ["media_post_submissions", "media_submission_initial_event"],
  ["media_upload_reservations", "media_reservation_claim_pair"],
  ["media_immutable_objects", "media_immutable_object_insert_guard"],
  ["media_publication_projections", "media_publication_projection_insert_guard"],
  ["media_submission_terms", "media_terms_lineage_guard"],
  ["media_audio_revisions", "media_audio_lineage_guard"],
  ["media_analysis_evidence", "media_analysis_lineage_guard"],
  ["media_publication_decisions", "media_decision_lineage_guard"],
  ["media_song_lyrics_revisions", "media_song_lyrics_insert_guard"],
  ["media_publication_projections", "media_publication_song_owner_policy_initialize"],
] as const;

/** Plan only fixture identity, corpus and published song data. Never old attempts or money. */
export async function planFixtureSeed(connectionString: string) {
  verifyRetiredDatabase(connectionString);
  const source = new Client({
    connectionString: normalizePostgresConnectionString(connectionString),
  });
  await source.connect();
  try {
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: fks } = await source.query<ForeignKey>(`
      SELECT child.relname AS child, parent.relname AS parent, c.condeferrable AS deferred,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY n) AS child_columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY n) AS parent_columns
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
        JOIN pg_class parent ON parent.oid=c.confrelid
      WHERE c.contype='f' AND c.connamespace='api_next'::regnamespace
    `);
    const nodes = new Map<string, Node>();
    const lookups = new Map<string, string[]>();
    async function collect(table: string, filters: Row): Promise<string[]> {
      fixtureTable(table);
      const lookup = JSON.stringify([table, filters]);
      const cached = lookups.get(lookup);
      if (cached) return cached;
      const entries = Object.entries(filters);
      const { rows } = await source.query<Row>(
        `SELECT * FROM ${fixtureTable(table)} WHERE ${entries.map(([key], index) => `${column(key)}=$${index + 1}`).join(" AND ")}`,
        entries.map(([, value]) => value),
      );
      const keys: string[] = [];
      lookups.set(lookup, keys);
      for (const row of rows) {
        if (table === "users" && !fixture.accounts.includes(String(row.user_id)))
          throw new Error("Song dependency reaches a non-fixture account");
        if (row.community_id && row.community_id !== fixture.community)
          throw new Error("Fixture dependency reaches another community");
        const key = `${table}:${createHash("sha256").update(JSON.stringify(row)).digest("hex")}`;
        keys.push(key);
        if (nodes.has(key)) continue;
        if (nodes.size >= 1000) throw new Error("Fixture dependency exceeds bounded inventory");
        const node: Node = { table, row, dependencies: new Set() };
        nodes.set(key, node);
        for (const fk of fks.filter((item) => item.child === table)) {
          const values = fk.child_columns.map((name) => row[name]);
          if (values.some((value) => value === null || value === undefined)) continue;
          const parents = await collect(
            fk.parent,
            Object.fromEntries(fk.parent_columns.map((name, index) => [name, values[index]])),
          );
          const parent = parents[0];
          if (parents.length !== 1 || !parent)
            throw new Error(`Fixture parent is missing or ambiguous: ${fk.parent}`);
          if (!fk.deferred) node.dependencies.add(parent);
        }
      }
      return keys;
    }
    for (const user_id of fixture.accounts) {
      await collect("users", { user_id });
      await collect("account_minimum_age_attestations", { account_id: user_id });
      await collect("identity_credentials", { canonical_user_id: user_id, status: "active" });
    }
    await collect("communities", { community_id: fixture.community });
    await collect("post_slug_aliases", { post_id: fixture.song });
    for (const account_id of fixture.accounts) {
      for (const table of [
        "personas",
        "persona_wallet_assignments",
        "persona_community_bindings",
        "persona_activity_presentations",
        "persona_role_presentations",
      ])
        await collect(
          table,
          table === "personas" || table === "persona_wallet_assignments"
            ? { account_id }
            : { account_id, community_id: fixture.community },
        );
      for (const table of ["community_memberships", "community_follows"])
        await collect(table, { community_id: fixture.community, user_id: account_id });
      await collect("community_role_assignments", { community_id: fixture.community, account_id });
    }
    for (const table of [
      "posts",
      "community_feed_projection",
      "song_owner_policies",
      "media_publication_projections",
      "media_timed_lyrics_artifacts",
      "media_alignment_projections",
      "localization_lyric_line_occurrences",
      "localization_lyrics_revision_lines",
      "localization_study_units",
      "localization_lyric_line_study_units",
      "study_exercise_versions",
      "study_language_profiles",
      "study_language_profile_units",
      "study_unit_exercise_eligibility",
    ])
      await collect(table, { community_id: fixture.community, post_id: fixture.song });
    await collect("media_song_canonical_timings", { song_post_id: fixture.song });
    for (const node of [...nodes.values()]) {
      if (node.table === "personas")
        await collect("persona_profiles", { persona_id: node.row.persona_id });
      if (node.table === "media_publication_projections")
        await collect("media_publication_decisions", { submission_id: node.row.submission_id });
    }
    for (const table of [
      "users",
      "posts",
      "study_exercise_versions",
      "media_publication_decisions",
      "media_timed_lyrics_artifacts",
      "media_alignment_projections",
      "media_song_canonical_timings",
    ]) {
      if (![...nodes.values()].some((node) => node.table === table))
        throw new Error(`Required fixture data is missing: ${table}`);
    }
    const ordered: Node[] = [];
    const done = new Set<string>();
    while (done.size < nodes.size) {
      let progress = false;
      for (const [key, node] of nodes)
        if (!done.has(key) && [...node.dependencies].every((dependency) => done.has(dependency))) {
          done.add(key);
          ordered.push(node);
          progress = true;
        }
      if (!progress) throw new Error("Fixture immediate foreign-key cycle requires review");
    }
    await source.query("COMMIT");
    return ordered;
  } finally {
    await source.end();
  }
}

export async function applyFixtureSeed(
  connectionString: string,
  identity: IsolatedDatabaseIdentity,
  plan: readonly Node[],
) {
  validateIsolatedDatabaseIdentity(connectionString, identity);
  const target = new Client({
    connectionString: normalizePostgresConnectionString(connectionString),
  });
  await target.connect();
  try {
    await target.query("BEGIN");
    await target.query("SET LOCAL search_path TO api_next, public");
    await target.query("SET CONSTRAINTS ALL DEFERRED");
    const marker = await target.query(
      `SELECT finished FROM rewards_bootstrap_${identity.branchId}.receipt`,
    );
    if (marker.rows.length !== 1 || marker.rows[0].finished !== true)
      throw new Error("Fixture target bootstrap is incomplete");
    const migrations = await loadPostgresMigrations();
    const ledger = await target.query(
      "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
    );
    if (
      JSON.stringify(ledger.rows) !==
      JSON.stringify(migrations.map(({ version, checksum }) => ({ version, checksum })))
    )
      throw new Error("Fixture target ledger differs from pinned source");
    const empty = await target.query(
      "SELECT (SELECT count(*) FROM api_next.users)+(SELECT count(*) FROM api_next.reward_chain_effects) AS rows",
    );
    if (empty.rows[0].rows !== "0")
      throw new Error("Fixture seed refuses a populated target; no reset is automatic");
    if (
      plan.some(
        (node) => node.table === "media_post_submissions" && node.row.status !== "published",
      )
    )
      throw new Error("Historical song import requires terminal published submissions");
    // Existing published fixtures are not new uploads. Only initial-state
    // provisioners and temporal admission are suspended, atomically restored.
    // FK, snapshot, identity, mutation and money guards stay active.
    for (const [table, trigger] of importGuards) {
      const observed = await target.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2",
        [`api_next.${table}`, trigger],
      );
      if (observed.rows.length !== 1 || observed.rows[0].tgenabled !== "O")
        throw new Error(`Fixture admission guard differs from pinned schema: ${trigger}`);
      await target.query(`ALTER TABLE ${fixtureTable(table)} DISABLE TRIGGER ${column(trigger)}`);
    }
    const metadata = await target.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_generated: string;
    }>(
      "SELECT table_name,column_name,data_type,is_generated FROM information_schema.columns WHERE table_schema='api_next'",
    );
    for (const { table, row } of plan) {
      fixtureTable(table);
      if (table === "community_role_assignments") {
        const existing = await target.query<Row>(
          "SELECT * FROM api_next.community_role_assignments WHERE role_assignment_id=$1",
          [row.role_assignment_id],
        );
        if (existing.rows[0]) {
          const actual = existing.rows[0];
          if (
            !Object.entries(row).every(
              ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
            )
          )
            throw new Error("Generated community role differs from fixture authority");
          continue;
        }
      }
      const columns = metadata.rows.filter((item) => item.table_name === table);
      const available = new Set(columns.map((item) => item.column_name));
      const computed = new Set(
        columns.filter((item) => item.is_generated !== "NEVER").map((item) => item.column_name),
      );
      const jsonColumns = new Set(
        columns
          .filter((item) => ["json", "jsonb"].includes(item.data_type))
          .map((item) => item.column_name),
      );
      if (Object.keys(row).some((key) => !available.has(key)))
        throw new Error(`Fixture source columns differ from current schema: ${table}`);
      const entries = Object.entries(row).filter(([key]) => !computed.has(key));
      await target.query(
        `INSERT INTO ${fixtureTable(table)} (${entries.map(([key]) => column(key)).join(",")}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(",")})`,
        entries.map(([key, value]) =>
          jsonColumns.has(key) && value !== null ? JSON.stringify(value) : value,
        ),
      );
    }
    await target.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of importGuards)
      await target.query(`ALTER TABLE ${fixtureTable(table)} ENABLE TRIGGER ${column(trigger)}`);
    await target.query("COMMIT");
    return {
      rows: plan.length,
      tables: [...new Set(plan.map((node) => node.table))].sort(),
      restoredTriggers: importGuards.map(([, trigger]) => trigger),
    };
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  } finally {
    await target.end();
  }
}
