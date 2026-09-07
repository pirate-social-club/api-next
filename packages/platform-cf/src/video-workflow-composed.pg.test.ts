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
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Composed video Workerd gate exited ${exitCode}`);
    // This wraps 30 serial drills and scale fixtures plus Workerd startup;
    // individual tests retain the 60-second bound in the Vitest configuration.
  }, 300_000);
});
