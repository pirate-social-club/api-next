const CATALOG_START = "// POSTGRES_FOUNDATION_TABLE_CATALOG_START";
const CATALOG_END = "// POSTGRES_FOUNDATION_TABLE_CATALOG_END";

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function tableNamesFromPostgresBaseline(source: string): readonly string[] {
  return sortedUnique(
    [...source.matchAll(/^CREATE TABLE ([a-z][a-z0-9_]*) \(/gmu)].map(
      (match) => match[1] as string,
    ),
  );
}

export function tableNamesFromFoundationCatalog(source: string): readonly string[] {
  const start = source.indexOf(CATALOG_START);
  const end = source.indexOf(CATALOG_END);
  if (
    start < 0 ||
    end <= start ||
    source.indexOf(CATALOG_START, start + 1) >= 0 ||
    source.indexOf(CATALOG_END, end + 1) >= 0
  ) {
    throw new Error("Postgres foundation table catalog markers are missing or ambiguous");
  }
  const section = source.slice(start + CATALOG_START.length, end);
  const names = [...section.matchAll(/^\s*"([a-z][a-z0-9_]*)",\s*$/gmu)].map(
    (match) => match[1] as string,
  );
  const sorted = sortedUnique(names);
  if (
    names.length === 0 ||
    sorted.length !== names.length ||
    names.some((name, index) => name !== sorted[index])
  ) {
    throw new Error("Postgres foundation table catalog is empty, duplicated, or unsorted");
  }
  return names;
}

export function assertPostgresFoundationTableCatalogFresh(input: {
  readonly baselineSource: string;
  readonly foundationTestSource: string;
}): void {
  const baseline = tableNamesFromPostgresBaseline(input.baselineSource);
  const expected = tableNamesFromFoundationCatalog(input.foundationTestSource);
  const missing = baseline.filter((table) => !expected.includes(table));
  const unexpected = expected.filter((table) => !baseline.includes(table));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `Postgres foundation table catalog is stale: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
  );
}
