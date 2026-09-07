import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildKaraokeCollector } from "./build-karaoke-collector.ts";

test("self-contained stdin bundle denies missing live configuration without running imported diagnostic mains", async () => {
  const result = await buildKaraokeCollector();
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
  for (const command of ["collect-karaoke-reconciliation", "record-karaoke-fence"]) {
    const child = spawnSync(
      process.execPath,
      ["run", "-", command, "--run-directory", "/nonexistent-fixture"],
      {
        input: result.bytes,
        env: { PATH: process.env.PATH },
        timeout: 5000,
        maxBuffer: 32768,
      },
    );
    expect(child.status).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString().trim()).toBe("staging_karaoke_collection_denied");
  }
}, 20_000);
