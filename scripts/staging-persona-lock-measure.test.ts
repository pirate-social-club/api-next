import { expect, test } from "bun:test";

test("measurement refuses missing acknowledgement and non-local targets before connecting", async () => {
  for (const args of [[], ["--local-measure"]]) {
    const child = Bun.spawn(
      [process.execPath, "scripts/staging-persona-lock-measure.ts", ...args],
      {
        env: {
          ...process.env,
          CONTROL_PLANE_POSTGRES_TEST_URL: "postgresql://operator@invalid.example/postgres",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe("local_lock_measurement_unproven");
  }
});
