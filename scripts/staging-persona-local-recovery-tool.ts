/** Test-only pg_dump/pg_restore transport for UUID-created local databases. */
export async function localResetRecoveryTool(
  url: URL,
  executable: "pg_dump" | "pg_restore" | "psql",
  args: string[],
  input?: Uint8Array,
) {
  if (url.hostname !== "127.0.0.1" || !/^\/phased_reset_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("local_phased_recovery_target_required");
  const container = process.env.CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER;
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "10",
    PGOPTIONS: "-c search_path=api_next,pg_catalog",
  };
  const prefix = container
    ? ["docker", "exec", "-i", ...Object.keys(env).flatMap((k) => ["--env", k]), container]
    : [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network=host",
        "--memory=512m",
        "--cpus=1",
        ...Object.keys(env).flatMap((k) => ["--env", k]),
        "postgres:17",
      ];
  const child = Bun.spawn([...prefix, executable, ...args], {
    env: { ...process.env, ...env },
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, bytes] = await Promise.all([
      child.exited,
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error("local_phased_restore_tool_failed");
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
