import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { finalizedFixture, seedVideoActors, submissionId } from "./video-publication.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const schema = `video_reasons_${Date.now()}_${Math.random().toString(36).slice(2)}`;

suite("video publication reason migration", () => {
  let client: Client;
  let sql: string;
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrations = await loadPostgresMigrations();
    const index = migrations.findIndex(
      (m) => m.version === "0125_video_publication_failure_reasons.sql",
    );
    expect(index).toBeGreaterThan(0);
    sql = migrations[index]?.sql ?? "";
    const scoped = new URL(connectionString ?? "");
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: migrations.slice(0, index),
    });
    await seedVideoActors(client);
    const { store, finalized } = await finalizedFixture(scoped.toString());
    await store.recordProcessingFailure({
      submission: finalized.state,
      observedEventSequence: finalized.eventSequence,
      failureCode: "transform_failed",
      evidenceRef: "fixture:failure",
    });
  }, 120_000);
  afterAll(async () => {
    if (!client) return;
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });
  test("preflight refuses historical codes outside the old set and rolls back", async () => {
    await client.query("BEGIN");
    // Historical seed mutation bypasses transition triggers; CHECK enforcement remains active.
    await client.query("SET LOCAL session_replication_role = replica");
    try {
      await client.query(
        "ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_failure_code_check",
      );
      await client.query(
        "UPDATE media_post_submissions SET failure_code='unexpected' WHERE submission_id=$1",
        [submissionId],
      );
      await expect(client.query(sql)).rejects.toThrow("unexpected existing failure code");
    } finally {
      await client.query("ROLLBACK");
    }
    expect(
      (
        await client.query(
          "SELECT failure_code FROM media_post_submissions WHERE submission_id=$1",
          [submissionId],
        )
      ).rows[0].failure_code,
    ).toBe("transform_failed");
  });
  test("admits both video reasons and preserves refusal of unknown codes", async () => {
    await client.query("BEGIN");
    // Historical seed mutation bypasses transition triggers; CHECK enforcement remains active.
    await client.query("SET LOCAL session_replication_role = replica");
    try {
      await client.query(sql);
      for (const code of [
        "membership_required",
        "provider_submission_unconfirmed",
        "transform_failed",
      ]) {
        await client.query(
          "UPDATE media_post_submissions SET failure_code=$1 WHERE submission_id=$2",
          [code, submissionId],
        );
        expect(
          (
            await client.query(
              "SELECT failure_code FROM media_post_submissions WHERE submission_id=$1",
              [submissionId],
            )
          ).rows[0].failure_code,
        ).toBe(code);
      }
      await expect(
        client.query(
          "UPDATE media_post_submissions SET failure_code='unknown' WHERE submission_id=$1",
          [submissionId],
        ),
      ).rejects.toThrow("media_post_submissions_failure_code_check");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
