import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    videoDatabase: string;
  }
}

export default async function setup(project: TestProject) {
  const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
  if (!connection)
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for composed video drills");
  const name = `api_next_video_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connection);
  url.pathname = `/${name}`;
  url.searchParams.delete("options");
  const fixture = new Client({ connectionString: url.toString() });
  try {
    await fixture.connect();
    await fixture.query("CREATE SCHEMA api_next; SET search_path TO api_next,pg_catalog");
    await fixture.query(
      await readFile(new URL("../../db/postgres/schema.sql", import.meta.url), "utf8"),
    );
    // Native custody is established only after the harness creates this exact
    // disposable database and installs its maintained canonical api_next schema.
    await fixture.query(`CREATE TABLE api_next.owned_video_test_custody (
      singleton BOOLEAN PRIMARY KEY CHECK(singleton), custody_database_oid OID NOT NULL,
      custody_namespace_oid OID NOT NULL, custody_role_oid OID NOT NULL
    ); INSERT INTO api_next.owned_video_test_custody
      SELECT TRUE,d.oid,n.oid,n.nspowner FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_namespace n ON n.nspname='api_next'
      WHERE d.datname=pg_catalog.current_database() AND d.datdba=n.nspowner
        AND n.nspowner=pg_catalog.to_regrole(current_user);`);
    project.provide("videoDatabase", url.toString());
  } catch (error) {
    await fixture.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  await fixture.end();
  return async () => {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  };
}
