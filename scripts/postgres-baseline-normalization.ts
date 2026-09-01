export function normalizePostgresBaselineDump(dump: string): string {
  const lines = dump.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const normalized: string[] = [];
  let dollarDelimiter: string | undefined;
  let functionHeader = false;

  for (const line of lines) {
    const topLevel = dollarDelimiter === undefined;
    const trimmed = line.trim();
    if (topLevel && /^CREATE (?:OR REPLACE )?FUNCTION\b/iu.test(trimmed)) {
      functionHeader = true;
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
  }

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
