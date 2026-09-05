import { describe, test } from "bun:test";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connection)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for composed video drills");
const suite = connection ? describe : describe.skip;

suite("composed video Workflow PostgreSQL and Workerd gate", () => {
  test("runs the exported entrypoint success case and named fault drills", async () => {
    const child = Bun.spawn([process.execPath, "run", "test:video-workflow:postgres"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: { ...process.env, CONTROL_PLANE_POSTGRES_TEST_URL: connection },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(`Composed video Workerd gate exited ${exitCode}\n${stdout}\n${stderr}`);
    console.info(stdout.trim());
  }, 120_000);
});
