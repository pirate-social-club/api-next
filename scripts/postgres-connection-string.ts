/** Node pg treats sslrootcert as a filesystem path, unlike psql's system value. */
export function normalizePostgresConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslrootcert") === "system") {
    url.searchParams.delete("sslrootcert");
  }
  return url.toString();
}
