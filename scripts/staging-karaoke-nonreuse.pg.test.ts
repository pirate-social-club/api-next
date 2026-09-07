import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { observeKaraokeSqlIdentity, verifyKaraokeSqlNonReuse } from "./staging-karaoke-nonreuse.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
async function fixture(use: (admin: Client) => Promise<void>) {
  if (!url) throw new Error("test URL required");
  const name = `nonreuse_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: url });
  const scoped = new URL(url);
  scoped.pathname = `/${name}`;
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${name}"`);
    await admin.connect();
    await admin.query(`CREATE SCHEMA api_next;
      CREATE TABLE api_next.karaoke_sessions (
        session_id text, attempt_id text, account_id text, created_at timestamptz);
      CREATE TABLE api_next.karaoke_recordings (
        session_id text, attempt_id text, account_id text, artifact_id text,
        created_at timestamptz, object_ref text);
      CREATE TABLE api_next.learner_audio_artifacts (
        learner_audio_artifact_id text, account_id text, attempt_ref text,
        expected_object_ref text, object_ref text);
      INSERT INTO api_next.karaoke_sessions VALUES ('session','attempt','account','2026-09-01T00:00:00Z');
      INSERT INTO api_next.karaoke_recordings VALUES
        ('session','attempt','account','artifact','2026-09-01T00:00:00Z',null)`);
    await use(admin);
  } finally {
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${name}"`);
    await root.end();
  }
}
const authority = { accountId: "account", attemptId: "attempt" };
suite("Karaoke exact identity non-reuse", () => {
  test("retains original identity before reset and requires total absence afterward", async () =>
    fixture(async (admin) => {
      const first = await observeKaraokeSqlIdentity(admin, authority);
      if (first.state !== "present") throw new Error("missing fixture");
      expect(verifyKaraokeSqlNonReuse(first.identity, first, "before-reset").keyNotReused).toBe(
        true,
      );
      expect(() => verifyKaraokeSqlNonReuse(first.identity, first, "after-reset")).toThrow();
      await admin.query(
        "DELETE FROM api_next.karaoke_recordings; DELETE FROM api_next.karaoke_sessions",
      );
      const absent = await observeKaraokeSqlIdentity(admin, authority);
      expect(verifyKaraokeSqlNonReuse(first.identity, absent, "after-reset").keyNotReused).toBe(
        true,
      );
      expect(() => verifyKaraokeSqlNonReuse(first.identity, absent, "before-reset")).toThrow();
      await admin.query(`INSERT INTO api_next.learner_audio_artifacts VALUES
        ('another-artifact','another-account','another-attempt','karaoke/account/attempt.pcm',null)`);
      await expect(observeKaraokeSqlIdentity(admin, authority)).rejects.toThrow(
        "nonreuse_unproven",
      );
    }));
  test("replacement creation identity, cross-account recording and key aliases are refused", async () =>
    fixture(async (admin) => {
      const first = await observeKaraokeSqlIdentity(admin, authority);
      if (first.state !== "present") throw new Error("missing fixture");
      await admin.query("UPDATE api_next.karaoke_sessions SET created_at='2026-09-02T00:00:00Z'");
      const replacement = await observeKaraokeSqlIdentity(admin, authority);
      expect(() => verifyKaraokeSqlNonReuse(first.identity, replacement, "before-reset")).toThrow();
      await admin.query("UPDATE api_next.karaoke_recordings SET account_id='different'");
      await expect(observeKaraokeSqlIdentity(admin, authority)).rejects.toThrow();
      await admin.query("UPDATE api_next.karaoke_recordings SET account_id='account'");
      await admin.query(`INSERT INTO api_next.karaoke_recordings VALUES
        ('other-session','other-attempt','other-account','other-artifact','2026-09-01T00:00:00Z','karaoke/account/attempt.pcm')`);
      await expect(observeKaraokeSqlIdentity(admin, authority)).rejects.toThrow();
    }));
  test("a missing recording or conflicting artifact cannot become a baseline", async () =>
    fixture(async (admin) => {
      await admin.query(`INSERT INTO api_next.learner_audio_artifacts VALUES
        ('artifact','account','attempt','karaoke/account/attempt.pcm','karaoke/account/attempt.pcm')`);
      expect((await observeKaraokeSqlIdentity(admin, authority)).state).toBe("present");
      await admin.query("UPDATE api_next.learner_audio_artifacts SET account_id='different'");
      await expect(observeKaraokeSqlIdentity(admin, authority)).rejects.toThrow();
      await admin.query(
        "DELETE FROM api_next.learner_audio_artifacts; DELETE FROM api_next.karaoke_recordings",
      );
      await expect(observeKaraokeSqlIdentity(admin, authority)).rejects.toThrow();
    }));
});
