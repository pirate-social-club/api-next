import { expect, test } from "bun:test";

// Exercise operational refusal behavior without requiring a production host.
test("native runtime acceptance refuses stale, redirected and replaced processes", () => {
  const result = Bun.spawnSync(
    ["python3", "-B", "scripts/hns-deployment/verify-native-runtime.test.py"],
    {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});
