import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresQueryConfig } from "./postgres.ts";
import {
  finalizedFixture,
  operationId,
  seedVideoActors,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeVideoSourceGrantIssuer } from "./video-source-grant-issuer.ts";
import { makeVideoSourceGrantResolver } from "./video-source-grant-resolver.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
suite("video source grants PostgreSQL authority", () => {
  const schema = `video_grants_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const statements: PostgresQueryConfig[] = [];
  const layer = makeDirectPostgresControlPlaneLayer(scoped.toString(), {
    clientFactory: async (_url, config) => {
      const client = new Client(config);
      return {
        connect: () => client.connect(),
        end: () => client.end(),
        query: async (statement) => {
          statements.push(statement);
          return client.query(statement.text, [...(statement.values ?? [])]);
        },
      };
    },
  });
  const issuer = makeVideoSourceGrantIssuer(layer, "https://source.example", "qencode");
  const resolver = makeVideoSourceGrantResolver(layer);
  const input = () => ({
    objectKey: `immutable/${operationId}/video/1`,
    sha256: videoSha256,
    byteLength: 1024,
    mediaType: "video/mp4" as const,
    requestId: "same-request",
    expiresAtMs: Date.now() + 60_000,
  });
  const bearer = (url: string) => new URL(url).pathname.split("/").at(-1) ?? "";
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    await finalizedFixture(scoped.toString());
  }, 120_000);
  beforeEach(async () => {
    await admin.query("DELETE FROM media_video_source_grants");
    statements.length = 0;
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("random capabilities share request identity without recovering or revoking bearers", async () => {
    const request = input();
    const first = await issuer.issue(request);
    const second = await issuer.issue(request);
    expect(first.url).not.toBe(second.url);
    expect(first.expiresAtMs).toBe(request.expiresAtMs);
    for (const issued of [first, second]) {
      const capability = bearer(issued.url);
      expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(capability, "base64url").length).toBe(32);
      expect(new URL(issued.url).search).toBe("");
      const resolved = await resolver.resolve(capability);
      expect(resolved).toEqual({
        expiresAtMs: request.expiresAtMs,
        object: {
          key: request.objectKey,
          version: "immutable-version",
          etag: "immutable-etag",
          size: 1024,
          contentType: "video/mp4",
          canonicalSha256: videoSha256,
        },
      });
      expect(JSON.stringify(statements)).not.toContain(capability);
      expect(JSON.stringify(resolved)).not.toContain(capability);
    }
    const rows = (await admin.query("SELECT * FROM media_video_source_grants")).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.capability_sha256).sort()).toEqual(
      [first, second]
        .map((grant) => createHash("sha256").update(bearer(grant.url)).digest("hex"))
        .sort(),
    );
    for (const row of rows) {
      expect(row.request_id).toBe(request.requestId);
      expect(row.revoked_at).toBeNull();
    }
    for (const issued of [first, second])
      expect(JSON.stringify(rows)).not.toContain(bearer(issued.url));
  });

  test("issuer rejects mismatched seal identity, unknown keys and expired ceilings", async () => {
    for (const patch of [
      { sha256: "b".repeat(64) },
      { byteLength: 1025 },
      { mediaType: "video/quicktime" as const },
      { objectKey: "immutable/missing" },
      { objectKey: "arbitrary/key" },
      { objectKey: "immutable/../escape" },
      { expiresAtMs: Date.now() - 1 },
      { expiresAtMs: Infinity },
    ]) {
      await expect(issuer.issue({ ...input(), ...patch })).rejects.toThrow();
    }
    expect(
      (await admin.query("SELECT count(*)::int n FROM media_video_source_grants")).rows[0].n,
    ).toBe(0);
  });

  test("resolver refuses absent, expired, revoked and malformed capabilities", async () => {
    expect(await resolver.resolve("invalid")).toBeNull();
    expect(await resolver.resolve("b".repeat(43))).toBeNull();
    const first = await issuer.issue(input());
    expect(await resolver.resolve(bearer(first.url))).not.toBeNull();
    await admin.query(
      "UPDATE media_video_source_grants SET issued_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'",
    );
    expect(await resolver.resolve(bearer(first.url))).toBeNull();
    const next = await issuer.issue(input());
    await admin.query("UPDATE media_video_source_grants SET revoked_at=clock_timestamp()");
    expect(await resolver.resolve(bearer(next.url))).toBeNull();
  });

  test("Stream can use a longer ceiling with the same seal and schema", async () => {
    const stream = makeVideoSourceGrantIssuer(layer, "https://source.example", "stream");
    const request = { ...input(), expiresAtMs: Date.now() + 6 * 60 * 60_000 };
    const grant = await stream.issue(request);
    expect((await resolver.resolve(bearer(grant.url)))?.expiresAtMs).toBe(request.expiresAtMs);
    expect(
      (await admin.query("SELECT consumer FROM media_video_source_grants")).rows[0].consumer,
    ).toBe("stream");
  });

  test("digest primary key and grant checks reject invalid rows", async () => {
    await issuer.issue(input());
    for (const mutation of [
      "capability_sha256='bad'",
      "consumer='browser'",
      "size_bytes=0",
      "content_type='text/plain'",
      "canonical_sha256='bad'",
      "expires_at=issued_at",
      "expires_at='infinity'",
      "revoked_at=issued_at-interval '1 second'",
      "physical_key='immutable/wrong'",
      "request_id=''",
      "etag=''",
      "object_version='' ",
    ]) {
      await admin.query("BEGIN");
      try {
        await expect(
          admin.query(`UPDATE media_video_source_grants SET ${mutation}`),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await expect(
      admin.query("INSERT INTO media_video_source_grants SELECT * FROM media_video_source_grants"),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await admin.query(
          "SELECT confdeltype FROM pg_constraint WHERE conrelid='media_video_source_grants'::regclass AND contype='f'",
        )
      ).rows[0].confdeltype,
    ).toBe("c");
    const indexes = (
      await admin.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='media_video_source_grants'",
        [schema],
      )
    ).rows.map((row) => row.indexdef);
    expect(
      indexes.some((text) => text.includes("UNIQUE INDEX") && text.includes("(capability_sha256)")),
    ).toBe(true);
    expect(
      indexes.some((text) => !text.includes("UNIQUE INDEX") && text.includes("(request_id)")),
    ).toBe(true);
    expect(
      indexes.some((text) => text.includes("(expires_at)") && text.includes("revoked_at IS NULL")),
    ).toBe(true);
  });
});
