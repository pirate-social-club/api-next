import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "plan-workers.ts");
const isolatedId = "11111111111111111111111111111111";

async function run(id: string, output: string): Promise<number> {
  const child = Bun.spawn([process.execPath, script], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      E2E_HYPERDRIVE_ID: id,
      E2E_ATTESTATION_ID: "megapot-e2e-sepolia-20260926-r1",
      E2E_CONFIG_OUT_DIR: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return child.exited;
}

test("isolated Worker plan has no shared database, storage, queue or workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "megapot-workers-"));
  try {
    expect(await run(isolatedId, directory)).toBe(0);
    const http = JSON.parse(await readFile(join(directory, "http.json"), "utf8"));
    const jobs = JSON.parse(await readFile(join(directory, "jobs.json"), "utf8"));
    for (const config of [http, jobs]) {
      expect(config.hyperdrive[0].id).toBe(isolatedId);
      expect(config.vars.MEGAPOT_REWARDS_ENABLED).toBe("false");
      expect(config.queues.producers).toEqual([]);
      expect(config.queues.consumers ?? []).toEqual([]);
      expect(config.r2_buckets.every((bucket: { bucket_name: string }) =>
        bucket.bucket_name.endsWith("-e2e-staging"))).toBe(true);
    }
    expect(http.services).toEqual([]);
    expect(jobs.workflows).toEqual([]);
    expect(http.vars.MEDIA_UPLOADS_ENABLED).toBe("false");
    expect(http.vars.SONG_PLAYBACK_R2_BUCKET).toBe("pirate-media-immutable-staging");
    expect(http.secrets.required.some((name: string) =>
      name.startsWith("HNS_") || name.startsWith("SPACES_") || name.startsWith("AVATAR_"))).toBe(false);
    expect(jobs.secrets.required.some((name: string) =>
      name.startsWith("HNS_") || name.startsWith("SPACES_") || name.startsWith("VIDEO_"))).toBe(false);
    expect(jobs.vars.MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING).toBe("1");
    expect(jobs.vars.MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC).toBe("10000");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated Worker plan refuses the shared Hyperdrive ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "megapot-workers-"));
  try {
    expect(await run("8cb7658a0f7143359c1becfec6a15c23", directory)).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
