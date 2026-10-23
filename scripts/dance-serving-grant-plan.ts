import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  DANCE_SERVING_CONSUMERS,
  DANCE_SERVING_FUNCTION_GROUPS,
  type DanceServingConsumer,
  danceServingRequirements,
} from "./dance-serving-permission-contract.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Input = Schema.Struct({
  role: Identifier,
  schema: Identifier,
  consumers: Schema.Array(
    Schema.Literals(Object.keys(DANCE_SERVING_CONSUMERS) as DanceServingConsumer[]),
  ).check(Schema.isMinLength(1)),
  ledgerSha256: Hash,
});
type Ledger = readonly { readonly version: string; readonly checksum: string }[];
export function danceServingLedgerHash(ledger: Ledger): string {
  return createHash("sha256")
    .update(ledger.map((row) => `${row.version}:${row.checksum}`).join("\n"))
    .digest("hex");
}

/** Renders an exact, transaction-bounded plan. This tool never connects to a DB,
 * creates a role, changes credentials, applies a grant or enables a feature. */
export function danceServingGrantPlan(raw: typeof Input.Type) {
  const input = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(raw);
  const required = new Map(
    input.consumers
      .flatMap((config) => danceServingRequirements(config))
      .map((row) => [row.name, row]),
  );
  const groups = new Set(input.consumers.flatMap((config) => [...DANCE_SERVING_CONSUMERS[config]]));
  const purposes = ["account", "worker", "media", "source_gateway"] as const;
  const purposeFunctions = new Set<string>(
    purposes.filter((p) => groups.has(p)).flatMap((p) => [...DANCE_SERVING_FUNCTION_GROUPS[p]]),
  );
  const direct = [...required.values()].filter(
    (row) => row.execute && !purposeFunctions.has(row.name),
  );
  // The existing purpose helper intentionally predates these frozen-read wrappers.
  for (const name of [
    "read_owned_moderated_dance_capture_context_v1(text,text,text)",
    "read_moderated_dance_owner_rubric_v1(text,text,text)",
  ]) {
    const row = required.get(name);
    if (row?.execute && !direct.some((entry) => entry.name === name)) direct.push(row);
  }
  const requirements = [...required.values()]
    .map((row) => `('${row.name}','${row.boundary}',${row.execute},'${row.path}',${row.stable})`)
    .join(",\n");
  const assertion = (after: boolean) => `DO $dance_release$
DECLARE target OID; trusted OID; owner_oid OID; required RECORD; f RECORD; t RECORD;
BEGIN
 SELECT n.oid,u.relowner INTO trusted,owner_oid FROM pg_catalog.pg_namespace n
 JOIN pg_catalog.pg_class u ON u.relnamespace=n.oid AND u.relname='users'
 WHERE n.nspname='${input.schema}' AND n.nspowner=u.relowner;
 IF trusted IS NULL OR current_user<>session_user OR session_user<>pg_catalog.pg_get_userbyid(owner_oid)
 THEN RAISE EXCEPTION 'Dance release requires the bound schema-owner session'; END IF;
 SELECT r.oid INTO target FROM pg_catalog.pg_roles r WHERE r.rolname='${input.role}' AND r.rolcanlogin
 AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication);
 IF target IS NULL OR pg_catalog.pg_has_role(target,owner_oid,'MEMBER')
 OR NOT pg_catalog.has_schema_privilege(target,trusted,'USAGE') OR pg_catalog.has_schema_privilege(target,trusted,'CREATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles inherited WHERE inherited.oid<>target
   AND pg_catalog.pg_has_role(target,inherited.oid,'MEMBER')
   AND (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreatedb OR inherited.rolcreaterole OR inherited.rolreplication))
 THEN RAISE EXCEPTION 'Dance release runtime role is not confined'; END IF;
 IF (SELECT encode(sha256(convert_to(string_agg(version||':'||checksum,E'\\n' ORDER BY version),'UTF8')),'hex') FROM "${input.schema}".schema_migrations)
 IS DISTINCT FROM '${input.ledgerSha256}' THEN RAISE EXCEPTION 'Dance release ledger differs'; END IF;
 FOR required IN SELECT * FROM (VALUES ${requirements}) r(name,boundary,allowed,path,require_stable) LOOP
  IF required.boundary='function' THEN
   SELECT p.* INTO f FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('"${input.schema}".'||required.name);
   IF f.oid IS NULL OR f.pronamespace<>trusted OR f.proowner<>owner_oid
    OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
    OR (required.allowed AND (NOT f.prosecdef OR (required.require_stable AND f.provolatile<>'s') OR f.proconfig IS DISTINCT FROM ARRAY[CASE WHEN required.path='wallet_lock'
      THEN pg_catalog.format('search_path=%I, pg_temp','${input.schema}') ELSE pg_catalog.format('search_path=%I, pg_catalog, pg_temp','${input.schema}') END]))
    OR ((${after} OR NOT required.allowed) AND pg_catalog.has_function_privilege(target,f.oid,'EXECUTE') IS DISTINCT FROM required.allowed)
   THEN RAISE EXCEPTION 'Dance release function boundary differs: %',required.name; END IF;
  ELSE
   SELECT c.* INTO t FROM pg_catalog.pg_class c WHERE c.relnamespace=trusted AND c.relname=required.name;
   IF t.oid IS NULL OR t.relowner<>owner_oid OR t.relkind NOT IN('r','p')
    OR (required.boundary='table' AND (pg_catalog.has_table_privilege(target,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(target,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR (required.boundary='read_table' AND NOT pg_catalog.has_table_privilege(target,t.oid,'SELECT'))
   THEN RAISE EXCEPTION 'Dance release private table boundary differs: %',required.name; END IF;
  END IF;
 END LOOP;
END $dance_release$`;
  const statements = [
    "BEGIN",
    `SET LOCAL search_path TO "${input.schema}",pg_catalog`,
    assertion(false),
    ...purposes
      .filter((p) => groups.has(p))
      .map(
        (p) => `SELECT "${input.schema}".grant_moderated_dance_runtime_v1('${input.role}','${p}')`,
      ),
    ...direct.map(
      (row) => `GRANT EXECUTE ON FUNCTION "${input.schema}".${row.name} TO "${input.role}"`,
    ),
    assertion(true),
    "COMMIT",
  ];
  return {
    ...input,
    statements,
    sha256: createHash("sha256")
      .update(JSON.stringify({ ...input, statements }))
      .digest("hex"),
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let role: string | undefined;
  let schema = "api_next";
  const consumers: DanceServingConsumer[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined) throw Error("Grant plan option requires a value");
    if (args[i] === "--runtime-role") role = value;
    else if (args[i] === "--schema") schema = value;
    else if (args[i] === "--config" && Object.hasOwn(DANCE_SERVING_CONSUMERS, value))
      consumers.push(value as DanceServingConsumer);
    else throw Error("Unknown grant plan option or consumer");
  }
  if (role === undefined) throw Error("Grant plan requires --runtime-role");
  const ledger = await loadPostgresMigrations();
  const plan = danceServingGrantPlan({
    role,
    schema,
    consumers,
    ledgerSha256: danceServingLedgerHash(ledger),
  });
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({ source_sha: source, mode: "render_only", plan }, null, 2));
}
