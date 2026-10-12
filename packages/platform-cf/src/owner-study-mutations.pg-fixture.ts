// Actual maintained0001..0256 proposal. Reuses the populated genuine0001..0254
// fixture and real restricted LOGIN, then applies actual255/256 ONCE through
// the maintained runner. No outside SQL supplement/helper/phase replacement.
import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";
import { makeControlPlaneOwnerStudyMutations } from "./owner-study-mutations.ts";
import {
  fixture,
  hash,
  q,
  disclosure,
  policy,
  pgUrl,
  type Fixture,
} from "./owner-study-starter.pg-fixture.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ExactSuffix = Schema.Struct({ "0254": Hash, "0255": Hash, "0256": Hash });
async function migrations(): Promise<readonly PostgresMigration[]> {
  const declared = process.env.GUEST_STUDY_MUTATION_SUFFIX_SHA256;
  if (!declared) throw new Error("Root-sealed exact actual254/255/256 source hashes required");
  const suffix = Schema.decodeUnknownSync(ExactSuffix, {
    onExcessProperty: "error",
  })(JSON.parse(declared));
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
export async function mutationFixture(use: (f: MutationFixture) => Promise<void>) {
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
  });
}
