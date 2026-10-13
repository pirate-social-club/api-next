// Actual maintained0001..0256 proposal. Reuses the populated genuine0001..0254
// fixture and real restricted LOGIN, then applies actual255/256 ONCE through
// the maintained runner. No outside SQL supplement/helper/phase replacement.
import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneOwnerStudyMutations } from "./owner-study-mutations.ts";
import {
  disclosure,
  type Fixture,
  fixture,
  hash,
  type PreparedSongFixtureOptions,
  pgUrl,
  policy,
  q,
} from "./owner-study-starter.pg-fixture.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ExactSuffix = Schema.Struct({ "0254": Hash, "0255": Hash, "0256": Hash });
async function migrations(): Promise<readonly PostgresMigration[]> {
  // Independently accepted exact source hashes are committed with this fixture.
  // An owned runner declaration can assert equality; it cannot override them.
  const decodeSuffix = Schema.decodeUnknownSync(ExactSuffix, {
    onExcessProperty: "error",
  });
  const suffix = decodeSuffix(
    JSON.parse(
      await readFile(
        new URL("./owner-study-mutation-suffix.pg-fixture.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const declared = process.env.GUEST_STUDY_MUTATION_SUFFIX_SHA256;
  if (declared !== undefined) expect(decodeSuffix(JSON.parse(declared))).toEqual(suffix);
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Hash),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 256)
    .sort();
  expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(
    Array.from({ length: 256 }, (_, i) => i + 1),
  );
  expect(names[246]).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  expect(names[253]).toBe("0254_guest_prepared_study_session_capture.sql");
  expect(names[254]).toBe("0255_guest_spoken_success_checkpoints.sql");
  const all: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8"),
      checksum = hash(sql),
      number = Number(version.slice(0, 4));
    const historical = manifest.migrations[version];
    if (number <= 247 && historical === undefined)
      throw new Error("Immutable historical source hash missing");
    if (historical !== undefined) expect(checksum).toBe(historical);
    switch (version.slice(0, 4)) {
      case "0254":
        expect(checksum).toBe(suffix["0254"]);
        break;
      case "0255":
        expect(checksum).toBe(suffix["0255"]);
        break;
      case "0256":
        expect(checksum).toBe(suffix["0256"]);
        break;
      default:
        break;
    }
    all.push({ version, sql, checksum });
  }
  return all;
}
export type MutationFixture = Fixture & {
  mutationStore: ReturnType<typeof makeControlPlaneOwnerStudyMutations>;
  mutationStoreFor: (
    options?: PostgresControlPlaneOptions,
  ) => ReturnType<typeof makeControlPlaneOwnerStudyMutations>;
};
export async function mutationFixture(
  use: (f: MutationFixture) => Promise<void>,
  options?: PreparedSongFixtureOptions,
) {
  if (!pgUrl) throw new Error("Owned loopback PostgreSQL URL required");
  const all = await migrations();
  await fixture(async (f) => {
    const original = (
      await f.admin.query(
        "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure) AS definition",
      )
    ).rows;
    const prefix = all.slice(0, 254);
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(prefix.map(({ version, checksum }) => ({ version, checksum })));
    const fixtureUrl = pgUrl;
    if (fixtureUrl === undefined) throw new Error("Owned mutation PostgreSQL URL missing");
    const scoped = new URL(fixtureUrl);
    scoped.searchParams.set("options", `-c search_path=${f.schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: all,
      expectedLedger: prefix,
    });
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(all.map(({ version, checksum }) => ({ version, checksum })));
    expect(
      (
        await f.admin.query(
          "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure) AS definition",
        )
      ).rows,
    ).toEqual(original);
    await f.admin.query("SELECT require_guest_learning_runtime_role_v1($1::regrole)", [f.role]);
    // Prove actual native255/256 stripping BEFORE granting any mutation leaf.
    // Fixture admission must not create a false native-private ACL receipt.
    expect(
      (
        await f.admin.query(
          `SELECT c.relname,a.grantee,a.privilege_type
      FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=ANY($1::regclass[]) AND a.grantee<>c.relowner`,
          [["guest_study_spoken_captures", "guest_study_spoken_checkpoints"]],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.admin.query(
          `SELECT p.proname,a.grantee,a.privilege_type
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=ANY($1::regprocedure[]) AND a.grantee<>p.proowner`,
          [
            [
              "guest_study_answer_resource_scope_v1(text,text,text,integer,text)",
              "capture_guest_spoken_dispatch_private_v1(text,jsonb,text,text,text,text,text,bigint,boolean)",
              "persist_guest_spoken_success_private_v1(text,jsonb,text,text,jsonb,jsonb)",
              "load_guest_spoken_success_private_v1(text,jsonb,text,text)",
              "read_guest_spoken_capture_private_v1(text,jsonb,text,text)",
              "require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)",
              "guest_spoken_component_has_history_private_v1(text[])",
              "require_guest_practice_only_schema_phase_v1()",
              "guest_authority_component_is_empty_v1(text)",
              "require_guest_review_schedule_private_v1(jsonb,timestamptz)",
              "require_guest_answer_operation_private_v1(text,jsonb,text,text,text,text,integer,text)",
              "project_owner_study_session_private_v1(text,text,text)",
              "prepare_guest_json_answer_v1(jsonb,jsonb,text,text,text,integer,jsonb)",
              "apply_guest_json_item_mutation_v1(jsonb,jsonb,jsonb,jsonb,text,text)",
              "apply_guest_lesson_transition_private_v1(text,text,integer,text,integer,text,timestamptz)",
              "transition_guest_json_answer_v1(jsonb,text,jsonb,jsonb,jsonb)",
              "finish_guest_json_answer_v1(jsonb,text,jsonb,jsonb)",
              "read_guest_spoken_context_v1(jsonb,text,text,text,text)",
              "reserve_guest_spoken_answer_v1(jsonb,jsonb,text,jsonb,text,bigint,jsonb,text,boolean,text,text,text)",
              "fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)",
              "prepare_guest_spoken_finalization_v1(text,jsonb,text)",
              "apply_guest_spoken_item_mutation_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb)",
              "transition_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb)",
              "finish_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb)",
              "require_owner_guest_source_private_v1(jsonb)",
              "persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)",
              "read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)",
              "read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)",
              "acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)",
            ],
          ],
        )
      ).rows,
    ).toEqual([]);
    for (const signature of [
      "prepare_guest_json_answer_v1(jsonb,jsonb,text,text,text,integer,jsonb)",
      "apply_guest_json_item_mutation_v1(jsonb,jsonb,jsonb,jsonb,text,text)",
      "transition_guest_json_answer_v1(jsonb,text,jsonb,jsonb,jsonb)",
      "finish_guest_json_answer_v1(jsonb,text,jsonb,jsonb)",
      "read_guest_spoken_context_v1(jsonb,text,text,text,text)",
      "reserve_guest_spoken_answer_v1(jsonb,jsonb,text,jsonb,text,bigint,jsonb,text,boolean,text,text,text)",
    ])
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    const mutationStoreFor = (options: PostgresControlPlaneOptions = {}) =>
      makeControlPlaneOwnerStudyMutations(
        makeDirectPostgresControlPlaneLayer(f.guestUrl, {
          closeTimeoutMs: 2000,
          ...options,
        }),
        {
          rawPolicy: policy,
          disclosureVersion: disclosure.version,
          rerecordEnabled: true,
          providerRetention: "stored",
        },
      );
    await use({ ...f, mutationStore: mutationStoreFor(), mutationStoreFor });
  }, options);
}
