// Migration0264 positively requires these exact private helper ACLs after baseline replay.
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

  const body = normalized
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
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
    "SET check_function_bodies = true;",
    "",
  ].join("\n");
}

export function normalizePostgresBaselineSeedDump(dump: string): string {
  return dump.replaceAll(
    /'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}(?::?\d{2})?)?'/gu,
    "'2000-01-01 00:00:00+00'",
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
