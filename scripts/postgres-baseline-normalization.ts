const sourceInventorySeedLine = /^\s*INSERT INTO (?:(?:"public"|public)\.)?(?:"owner_accounting_native_source_inventory_v1"|owner_accounting_native_source_inventory_v1) VALUES\b/u;

const ownerFinancialSourcePrivilegesSql = String.raw`
-- Baseline replay only: exact private source attestation, no serving grants.
DO $baseline_owner_source_privileges$
DECLARE
 target_schema TEXT:=pg_catalog.current_schema(); namespace_id OID; owner_id OID;
 source_manifest JSONB; source_row_count INTEGER; expected RECORD; native_function RECORD;
 native_relation RECORD; grantee_role TEXT; column_name TEXT; actual_acl JSONB;
BEGIN
 SELECT c.relnamespace,c.relowner INTO STRICT namespace_id,owner_id
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=target_schema AND c.relname='owner_accounting_native_source_inventory_v1'
   AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
 IF owner_id IS DISTINCT FROM pg_catalog.to_regrole(current_user)
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(
     pg_catalog.format('%I.participation_owners',target_schema))
     AND c.relnamespace=namespace_id AND c.relowner=owner_id)
 THEN RAISE EXCEPTION 'baseline source custody unavailable' USING ERRCODE='GP003'; END IF;
 EXECUTE pg_catalog.format('SELECT count(*) FROM %I.owner_accounting_native_source_inventory_v1',target_schema)
 INTO STRICT source_row_count;
 IF source_row_count<>1 THEN RAISE EXCEPTION 'one baseline source attestation required' USING ERRCODE='GP003'; END IF;
 EXECUTE pg_catalog.format('SELECT manifest FROM %I.owner_accounting_native_source_inventory_v1
   WHERE singleton AND source_version=''owner_accounting_native_source_v1''',target_schema)
 INTO STRICT source_manifest;
 IF pg_catalog.jsonb_typeof(source_manifest->'functions') IS DISTINCT FROM 'array'
   OR pg_catalog.jsonb_array_length(source_manifest->'functions') NOT BETWEEN 1 AND 1024
   OR pg_catalog.jsonb_typeof(source_manifest->'relations') IS DISTINCT FROM 'array'
   OR source_manifest->>'phase' IS DISTINCT FROM 'owner_accounting_native_source_v1'
   OR (SELECT count(*) FROM pg_catalog.jsonb_to_recordset(source_manifest->'functions') AS f(signature TEXT))
     <> (SELECT count(DISTINCT signature) FROM pg_catalog.jsonb_to_recordset(source_manifest->'functions') AS f(signature TEXT))
 THEN RAISE EXCEPTION 'finite baseline source inventory required' USING ERRCODE='GP003'; END IF;
 FOR expected IN SELECT * FROM pg_catalog.jsonb_to_recordset(source_manifest->'functions') AS f(
   signature TEXT,body_sha256 TEXT,definer BOOLEAN,language TEXT,result TEXT,configuration TEXT[],
   controlled BOOLEAN,acl_class TEXT,source_acl JSONB)
 LOOP
  IF expected.signature IS NULL OR (expected.body_sha256 ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE
    OR expected.definer IS NULL OR expected.controlled IS NULL
    OR (expected.language IN('sql','plpgsql')) IS DISTINCT FROM TRUE
    OR (expected.acl_class IN('private_source_only','controlled_financial','legacy_source_default')) IS DISTINCT FROM TRUE
    OR expected.controlled IS DISTINCT FROM (expected.acl_class='controlled_financial')
  THEN RAISE EXCEPTION 'baseline function source class unavailable' USING ERRCODE='GP003'; END IF;
  SELECT p.*,l.lanname INTO STRICT native_function
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=pg_catalog.to_regprocedure(pg_catalog.format('%I.%s',target_schema,expected.signature));
  IF native_function.proowner IS DISTINCT FROM owner_id OR native_function.pronamespace IS DISTINCT FROM namespace_id
    OR native_function.prokind IS DISTINCT FROM 'f' OR native_function.prosecdef IS DISTINCT FROM expected.definer
    OR native_function.lanname IS DISTINCT FROM expected.language
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(native_function.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha256
    OR pg_catalog.replace(pg_catalog.pg_get_function_result(native_function.oid),target_schema||'.','@NATIVE_SCHEMA@.') IS DISTINCT FROM expected.result
    OR native_function.proconfig IS DISTINCT FROM (CASE WHEN expected.configuration IS NULL THEN NULL ELSE
      ARRAY(SELECT pg_catalog.replace(v,'@NATIVE_SCHEMA@',target_schema) FROM pg_catalog.unnest(expected.configuration) v) END)
  THEN RAISE EXCEPTION 'baseline raw function source differs' USING ERRCODE='GP003'; END IF;
  IF expected.acl_class='legacy_source_default' THEN
   IF expected.definer IS DISTINCT FROM FALSE OR expected.configuration IS NOT NULL
     OR pg_catalog.jsonb_typeof(expected.source_acl) IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'retained ordinary source class differs' USING ERRCODE='GP003'; END IF;
   SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'grantor',CASE WHEN a.grantor=owner_id THEN '@NATIVE_OWNER@' ELSE pg_catalog.pg_get_userbyid(a.grantor) END,
     'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=owner_id THEN '@NATIVE_OWNER@' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
     'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
     ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=owner_id THEN '@NATIVE_OWNER@' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
       (CASE WHEN a.grantor=owner_id THEN '@NATIVE_OWNER@' ELSE pg_catalog.pg_get_userbyid(a.grantor) END) COLLATE "C",a.privilege_type COLLATE "C"),'[]'::JSONB)
   INTO STRICT actual_acl FROM pg_catalog.aclexplode(COALESCE(native_function.proacl,pg_catalog.acldefault('f',native_function.proowner))) a;
   IF actual_acl IS DISTINCT FROM expected.source_acl THEN
    RAISE EXCEPTION 'retained ordinary baseline ACL differs' USING ERRCODE='GP003'; END IF;
  ELSE
   IF expected.source_acl IS NOT NULL THEN
    RAISE EXCEPTION 'private baseline source ACL differs' USING ERRCODE='GP003'; END IF;
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',target_schema,native_function.proname,pg_catalog.oidvectortypes(native_function.proargtypes));
   FOR grantee_role IN SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee)
     FROM pg_catalog.aclexplode(COALESCE(native_function.proacl,pg_catalog.acldefault('f',native_function.proowner))) a
     WHERE a.grantee<>0 AND a.grantee<>owner_id LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I CASCADE',target_schema,native_function.proname,pg_catalog.oidvectortypes(native_function.proargtypes),grantee_role);
   END LOOP;
  END IF;
 END LOOP;
 -- Private relation identities also come from the same committed literal.
 FOR expected IN SELECT * FROM pg_catalog.jsonb_to_recordset(source_manifest->'relations') AS r(name TEXT,kind TEXT,rls BOOLEAN,private BOOLEAN)
   WHERE private IS TRUE
 LOOP
  SELECT c.* INTO STRICT native_relation FROM pg_catalog.pg_class c WHERE c.relnamespace=namespace_id AND c.relname=expected.name;
  IF expected.kind IS DISTINCT FROM 'r' OR expected.rls IS DISTINCT FROM TRUE
    OR native_relation.relkind IS DISTINCT FROM 'r' OR native_relation.relowner IS DISTINCT FROM owner_id
    OR native_relation.relrowsecurity IS DISTINCT FROM TRUE OR native_relation.relforcerowsecurity IS DISTINCT FROM FALSE
  THEN RAISE EXCEPTION 'private baseline relation custody differs' USING ERRCODE='GP003'; END IF;
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',target_schema,native_relation.relname);
  FOR grantee_role IN SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee)
    FROM pg_catalog.aclexplode(COALESCE(native_relation.relacl,pg_catalog.acldefault('r',native_relation.relowner))) a
    WHERE a.grantee<>0 AND a.grantee<>owner_id LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I.%I FROM %I CASCADE',target_schema,native_relation.relname,grantee_role);
  END LOOP;
  FOR column_name,grantee_role IN SELECT c.attname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
    FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
    WHERE c.attrelid=native_relation.oid AND a.grantee<>owner_id LOOP
   EXECUTE pg_catalog.format('REVOKE ALL(%I) ON TABLE %I.%I FROM %s CASCADE',column_name,target_schema,native_relation.relname,
     CASE WHEN grantee_role='PUBLIC' THEN 'PUBLIC' ELSE pg_catalog.quote_ident(grantee_role) END);
  END LOOP;
 END LOOP;
 -- Only after exact signature ACL restoration may the complete source verifier run.
 EXECUTE pg_catalog.format('SELECT %I.require_owner_accounting_ready_private_v1()',target_schema);
END
$baseline_owner_source_privileges$;
`;

// Migration0266 positively requires these exact private helper ACLs after baseline replay.
// Preserve ordinary baseline privilege behavior for every unrelated routine.
const ownerFinancialPrivateFunctions = new Set([
  "reject_disabled_owner_financial_dml_v1",
  "guard_disabled_beneficiary_dispatch_v1",
  "guard_disabled_owner_credit_dispatch_v1",
  "require_megapot_beneficiary_version_private_v1",
  "guest_financial_component_has_history_private_v1",
  "require_disabled_owner_financial_inventory_private_v1",
]);

export function normalizePostgresBaselineDump(dump: string): string {
  const lines = dump.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const normalized: string[] = [];
  let dollarDelimiter: string | undefined;
  let completeOwnerFinancialSource = false;
  let functionHeader = false;
  let functionDeclaration: Readonly<{ name: string; arguments: string }> | undefined;
  let catalogFirstFunction: Readonly<{ name: string; arguments: string }> | undefined;
  const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const catalogFirstAlter = (
    declaration: Readonly<{ name: string; arguments: string }>,
  ): string => {
    // pg_dump's declaration arguments are pg_get_function_arguments output,
    // including defaults. Select that exact overload in the unchanged target
    // namespace, then ALTER with its actual identity arguments (no defaults).
    const name = sqlLiteral(declaration.name);
    const argumentsLiteral = sqlLiteral(
      declaration.arguments.replaceAll(/"public"\.|\bpublic\./gu, ""),
    );
    let delimiter = "$baseline_function_path$";
    while (name.includes(delimiter) || argumentsLiteral.includes(delimiter))
      delimiter = delimiter.replace("$", "$_");
    const privateFinancialHelper = ownerFinancialPrivateFunctions.has(declaration.name);
    return [
      `DO ${delimiter}`,
      `DECLARE target_schema TEXT := pg_catalog.current_schema(); target_function RECORD;${privateFinancialHelper ? " grantee_role TEXT;" : ""}`,
      "BEGIN",
      `  SELECT p.proname, ${privateFinancialHelper ? "p.oid, " : ""}pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments`,
      "    INTO STRICT target_function",
      "    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace",
      `    WHERE n.nspname=target_schema AND p.proname=${name}`,
      `      AND pg_catalog.pg_get_function_arguments(p.oid)=${argumentsLiteral};`,
      "  EXECUTE pg_catalog.format('ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, %I, pg_temp',",
      "    target_schema,target_function.proname,target_function.identity_arguments,target_schema);",
      ...(privateFinancialHelper
        ? [
            "  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',",
            "    target_schema,target_function.proname,target_function.identity_arguments);",
            "  FOR grantee_role IN SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee)",
            "    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a",
            "    WHERE p.oid=target_function.oid AND a.grantee<>0 AND a.grantee<>p.proowner LOOP",
            "    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I CASCADE',",
            "      target_schema,target_function.proname,target_function.identity_arguments,grantee_role);",
            "  END LOOP;",
          ]
        : []),
      "END",
      `${delimiter};`,
    ].join("\n");
  };

  for (const line of lines) {
    const topLevel = dollarDelimiter === undefined;
    const trimmed = line.trim();
    if (topLevel && sourceInventorySeedLine.test(line)) {
      // This is the committed native JSONB literal, not a schema expression.
      // Only its leading table qualifier is portable; its contents stay exact.
      if (!trimmed.endsWith(";")) throw new Error("Complete source metadata seed statement required");
      normalized.push(line.replace(/^(\s*INSERT INTO )(?:(?:"public"|public)\.)/u, "$1"));
      continue;
    }
    if (
      topLevel &&
      /^CREATE TABLE (?:public\.|"public"\.)?owner_accounting_native_source_inventory_v1 \(/u.test(trimmed)
    )
      completeOwnerFinancialSource = true;
    if (topLevel && /^CREATE (?:OR REPLACE )?FUNCTION\b/iu.test(trimmed)) {
      functionHeader = true;
      const declaration = trimmed.match(
        /^CREATE (?:OR REPLACE )?FUNCTION (?:public\.|"public"\.)?([a-z_][a-z0-9_]*)\((.*)\) RETURNS /u,
      );
      functionDeclaration =
        declaration?.[1] === undefined || declaration[2] === undefined
          ? undefined
          : { name: declaration[1], arguments: declaration[2] };
    }
    // pg_dump emits function-local configuration before the dollar-quoted
    // body. Preserve configured search paths without baking the generator's
    // schema name into the portable baseline. Baseline application selects
    // the target schema before replay, so FROM CURRENT captures that schema.
    const portableFunctionSearchPath =
      topLevel && functionHeader && /^SET search_path (?:TO|=) /u.test(trimmed)
        ? line.replace(trimmed, "SET search_path FROM CURRENT")
        : undefined;
    if (
      portableFunctionSearchPath !== undefined &&
      /^SET search_path (?:TO|=) 'pg_catalog'(?:,|$)/u.test(trimmed)
    ) {
      if (
        functionDeclaration === undefined ||
        !/^SET search_path (?:TO|=) 'pg_catalog', '[^']+', 'pg_temp'$/u.test(trimmed)
      )
        throw new Error("Unsupported catalog-first portable function declaration");
      catalogFirstFunction = functionDeclaration;
    }
    if (
      topLevel &&
      (trimmed.startsWith("--") ||
        trimmed.startsWith("\\restrict ") ||
        trimmed.startsWith("\\unrestrict ") ||
        (trimmed.startsWith("SET ") && portableFunctionSearchPath === undefined) ||
        trimmed.startsWith("SELECT pg_catalog.set_config('search_path'") ||
        /^CREATE SCHEMA public;$/i.test(trimmed) ||
        /^ALTER SCHEMA public OWNER TO /i.test(trimmed) ||
        /^ALTER .* OWNER TO /i.test(trimmed) ||
        /^GRANT /i.test(trimmed) ||
        /^REVOKE /i.test(trimmed))
    ) {
      continue;
    }

    normalized.push(
      (portableFunctionSearchPath ?? line)
        .replaceAll(/"public"\.|\bpublic\./g, "")
        .replaceAll(
          /\(\(octet_length\(upstream_session_ref\) >= 1\) AND \(octet_length\(upstream_session_ref\) <= 16384\)\)/g,
          "(octet_length(upstream_session_ref) BETWEEN 1 AND 16384)",
        )
        .replaceAll(
          "(((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer >= 0) AND (((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer <= 20)",
          "((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer BETWEEN 0 AND 20",
        )
        .replaceAll(
          "CHECK ((((expected_activation_generation >= 0) AND (expected_activation_generation <= '9007199254740991'::bigint)) AND",
          "CHECK (((expected_activation_generation >= 0) AND (expected_activation_generation <= '9007199254740991'::bigint) AND",
        )
        .replaceAll(
          "CHECK ((((octet_length(activation_document_bytes) >= 1) AND (octet_length(activation_document_bytes) <= 65536)) AND",
          "CHECK (((octet_length(activation_document_bytes) >= 1) AND (octet_length(activation_document_bytes) <= 65536) AND",
        )
        .replaceAll(
          "CHECK ((((dns_zone_activation_generation >= 1) AND (dns_zone_activation_generation <= '9007199254740991'::bigint)) AND",
          "CHECK (((dns_zone_activation_generation >= 1) AND (dns_zone_activation_generation <= '9007199254740991'::bigint) AND",
        )
        .replaceAll(
          "CHECK ((((health_generation >= 1) AND (health_generation <= '9007199254740991'::bigint)) AND",
          "CHECK (((health_generation >= 1) AND (health_generation <= '9007199254740991'::bigint) AND",
        )
        .replaceAll(
          "(expected_activation_generation >= 0) AND (expected_activation_generation <= '9007199254740991'::bigint)",
          "(expected_activation_generation BETWEEN 0 AND '9007199254740991'::bigint)",
        )
        .replaceAll(
          "(octet_length(activation_document_bytes) >= 1) AND (octet_length(activation_document_bytes) <= 65536)",
          "(octet_length(activation_document_bytes) BETWEEN 1 AND 65536)",
        )
        .replaceAll(
          "(dns_zone_activation_generation >= 1) AND (dns_zone_activation_generation <= '9007199254740991'::bigint)",
          "(dns_zone_activation_generation BETWEEN 1 AND '9007199254740991'::bigint)",
        )
        .replaceAll(
          "(health_generation >= 1) AND (health_generation <= '9007199254740991'::bigint)",
          "(health_generation BETWEEN 1 AND '9007199254740991'::bigint)",
        ),
    );

    const delimiter = line.match(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (dollarDelimiter === undefined) {
      if (delimiter !== undefined) {
        functionHeader = false;
        const occurrences = line.split(delimiter).length - 1;
        if (occurrences % 2 === 1) dollarDelimiter = delimiter;
      }
    } else if ((line.split(dollarDelimiter).length - 1) % 2 === 1) {
      dollarDelimiter = undefined;
    }
    if (delimiter !== undefined && dollarDelimiter === undefined) {
      if (catalogFirstFunction !== undefined)
        normalized.push(catalogFirstAlter(catalogFirstFunction));
      catalogFirstFunction = undefined;
      functionDeclaration = undefined;
    }
  }
  if (catalogFirstFunction !== undefined)
    throw new Error("Unclosed catalog-first portable function body");

  // Raw native bodies are hashed by the committed source attestation.
  // Preserve their whitespace; pg_dump object separators are deterministic.
  const body = normalized.join("\n").trim();
  return [
    "-- GENERATED FILE. DO NOT EDIT. Regenerate with bun run db:generate:baseline.",
    "-- Source of truth: db/postgres/migrations/*.sql",
    "",
    "SELECT pg_catalog.set_config(",
    "  'search_path',",
    "  pg_catalog.format('%I, pg_temp', pg_catalog.current_schema()),",
    "  false",
    ");",
    "",
    "SET check_function_bodies = false;",
    "",
    body,
    "",
    ...(completeOwnerFinancialSource ? [ownerFinancialSourcePrivilegesSql, ""] : []),
    "SET check_function_bodies = true;",
    "",
  ].join("\n");
}

export function normalizePostgresBaselineSeedDump(dump: string): string {
  return dump.replaceAll(/[^\r\n]+/gu, (line) =>
    sourceInventorySeedLine.test(line)
      ? line
      : line.replaceAll(
          /'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}(?::?\d{2})?)?'/gu,
          "'2000-01-01 00:00:00+00'",
        ),
  );
}

export function normalizePostgresBaselineResetDump(
  seedDump: string,
  tableNames: readonly string[],
): string {
  const seedStatements = normalizePostgresBaselineSeedDump(seedDump)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("--") ||
        trimmed.startsWith("\\restrict ") ||
        trimmed.startsWith("\\unrestrict ") ||
        trimmed.startsWith("SET ") ||
        trimmed.startsWith("SELECT pg_catalog.set_config('search_path'")
      );
    })
    .join("\n")
    .replaceAll(/"public"\.|\bpublic\./g, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  const quotedTables = [...tableNames]
    .sort()
    .map((table) => `"${table.replaceAll('"', '""')}"`)
    .join(",\n  ");

  return [
    "-- GENERATED FILE. DO NOT EDIT. Regenerate with bun run db:generate:baseline.",
    "-- Source of truth: db/postgres/migrations/*.sql",
    "",
    "SELECT pg_catalog.set_config(",
    "  'search_path',",
    "  pg_catalog.format('%I, pg_temp', pg_catalog.current_schema()),",
    "  false",
    ");",
    "",
    "TRUNCATE TABLE",
    `  ${quotedTables}`,
    "RESTART IDENTITY CASCADE;",
    ...(seedStatements.length === 0
      ? []
      : [
          "",
          "SET LOCAL session_replication_role = replica;",
          "",
          seedStatements,
          "",
          "SET LOCAL session_replication_role = origin;",
        ]),
    "",
  ].join("\n");
}
