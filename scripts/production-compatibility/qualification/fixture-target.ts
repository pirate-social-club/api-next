import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { exactKeys, type Observation, object } from "../compatibility-contract.ts";
import { APP_SOURCE, sha256, sourceInputs } from "../source-inputs.ts";

export const OWNER = "compatibility_fixture_owner";
export const READER_MANIFEST = "075b2b3d9cf9dfbbbeedf593e42fe6b6f98bc07160c96cc64109bc04fe62d6a5";
export const IMAGE = "sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const sourceDirectory = new URL("./", import.meta.url);

/** Local synthetic admission only. This module has no production selector or URL input. */
export async function fixtureTarget(args: readonly string[]) {
  assert.equal(args.length, 1);
  const [runRoot] = args;
  assert.ok(runRoot && /^\/tmp\/pirate-v1-compatibility-[a-f0-9]{32}$/u.test(runRoot));
  assert.equal(realpathSync(runRoot), runRoot);
  const inputs = await sourceInputs();
  assert.equal(inputs.manifestSha256, READER_MANIFEST);
  const manifestBytes = readFileSync(new URL("source-manifest.json", sourceDirectory));
  const files = object(object(JSON.parse(manifestBytes.toString("utf8"))).files);
  const required = [
    "fixture-target.ts",
    "fixture-bootstrap.ts",
    "fixture-cases.ts",
    "fixture-seed.sql",
    "qualify-compatibility-pg18.ts",
    "README.md",
  ];
  exactKeys(files, required);
  const tracked = execFileSync(
    "/usr/bin/git",
    ["ls-files", "--", "scripts/production-compatibility/qualification/"],
    { cwd: inputs.toolingRoot, encoding: "utf8", timeout: 15_000 },
  )
    .trim()
    .split("\n")
    .map((path) => path.slice("scripts/production-compatibility/qualification/".length))
    .filter((path) => path !== "source-manifest.json")
    .sort();
  assert.deepEqual(tracked, [...required].sort());
  for (const name of required)
    assert.equal(sha256(readFileSync(new URL(name, sourceDirectory))), files[name]);
  const requestBytes = readFileSync(join(runRoot, "admission.json"));
  const request = object(JSON.parse(requestBytes.toString("utf8")));
  assert.equal(request.kind, "local-pg18-compatibility-qualification-v1");
  assert.equal(request.accepted, true);
  assert.equal(request.reviewer_role, "independent_reviewer");
  assert.deepEqual(request.findings, []);
  assert.equal(request.run_root, runRoot);
  assert.equal(request.api_source, APP_SOURCE);
  assert.equal(request.tooling_source, inputs.toolingSource);
  assert.equal(request.reader_manifest_sha256, READER_MANIFEST);
  assert.equal(request.qualification_manifest_sha256, sha256(manifestBytes));
  assert.equal(
    request.driver_sha256,
    sha256(readFileSync(new URL("qualify-compatibility-pg18.ts", sourceDirectory))),
  );
  assert.equal(request.image_id, IMAGE);
  assert.equal(request.network_mode, "none");
  assert.equal(request.public_ports, 0);
  assert.match(String(request.container_id), /^[a-f0-9]{64}$/u);
  assert.equal(request.driver_timeout_seconds, 240);
  assert.equal(request.outer_timeout_seconds, 360);
  const starts = Date.parse(String(request.starts_at)),
    expires = Date.parse(String(request.expires_at));
  assert.ok(
    Number.isFinite(starts) &&
      Number.isFinite(expires) &&
      starts <= Date.now() &&
      expires - starts <= 360_000 &&
      expires - Date.now() >= 240_000,
  );
  const socket = join(runRoot, "socket");
  assert.equal(realpathSync(socket), socket);
  assert.ok(lstatSync(join(socket, ".s.PGSQL.5432")).isSocket());
  const password = process.env.PIRATE_COMPATIBILITY_FIXTURE_PASSWORD;
  assert.ok(password && /^[a-f0-9]{64}$/u.test(password));
  for (const name of [
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSERVICE",
    "PGSERVICEFILE",
    "DATABASE_URL",
    "RUNTIME_POSTGRES_URL",
    "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
    "CONTROL_PLANE_POSTGRES_ADMIN_URL",
  ])
    assert.equal(process.env[name], undefined, "Foreign database environment is forbidden");
  const admin = new pg.Client({
    host: socket,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    options: "-c timezone=UTC -c search_path=api_next,pg_catalog",
  });
  const url = new URL("postgresql://" + OWNER + "@localhost/postgres");
  url.password = password;
  url.searchParams.set("host", socket);
  url.searchParams.set("sslmode", "disable");
  url.searchParams.set(
    "options",
    "-c search_path=api_next,pg_catalog -c timezone=UTC -c transaction_timeout=170000 -c statement_timeout=30000",
  );
  const output = join(runRoot, "qualification-result.json");
  assert.ok(!existsSync(output));
  const fd = openSync(output, "wx", 0o600);
  const checkpoint = () => assert.ok(Date.now() < expires, "Synthetic fixture admission expired");
  return {
    runRoot,
    admin,
    ownerUrl: url.toString(),
    password,
    inputs,
    checkpoint,
    queryObservations: [] as Observation[],
    lastQuery: "",
    clusterName: "pirate_compatibility_" + runRoot.slice(-32),
    evidence: {
      admission_sha256: sha256(requestBytes),
      tooling_source: inputs.toolingSource,
      reader_manifest_sha256: READER_MANIFEST,
      qualification_manifest_sha256: sha256(manifestBytes),
      image_id: IMAGE,
      container_id: request.container_id,
    },
    finish(result: unknown) {
      try {
        writeFileSync(fd, JSON.stringify(result, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(runRoot, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    },
  };
}

export const seedSource = () =>
  readFileSync(fileURLToPath(new URL("fixture-seed.sql", sourceDirectory)), "utf8");
