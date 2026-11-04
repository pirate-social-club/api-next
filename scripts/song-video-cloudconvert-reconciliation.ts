#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { getPlatformProxy } from "wrangler";
import { makeCloudConvertRenderCleanup } from "../packages/platform-cf/src/song-video-cloudconvert-renderer.ts";
import { makeCloudConvertRenderRepository } from "../packages/platform-cf/src/song-video-cloudconvert-repository.ts";
import { makeSongVideoCloudConvertTransport } from "../packages/platform-cf/src/song-video-cloudconvert-transport.ts";

/** Reconciles expired attempts only. No create, seal, acceptance or credentials in output. */
export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      attempt: { type: "string" },
      "immutable-bucket": { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.attempt || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(values.attempt))
    throw new Error("attempt required");
  const connectionString = process.env.CONTROL_PLANE_DATABASE_URL;
  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!connectionString || !apiKey)
    throw new Error("operator database and CloudConvert credentials required");
  const repository = makeCloudConvertRenderRepository({
    connect: async () => {
      const client = new Client({ connectionString });
      await client.connect();
      return client;
    },
  });
  const attempt = await repository.read(values.attempt);
  if (attempt === null) throw new Error("CloudConvert attempt absent");
  if (Date.now() < attempt.deadlineMs && !attempt.reconciliationRequired)
    throw new Error("provider wait has not expired");
  const jobs = makeSongVideoCloudConvertTransport({ apiKey, fetch });
  if (!values.apply) {
    const found = await jobs.findAllByTag(values.attempt);
    console.log(
      JSON.stringify({
        attemptId: values.attempt,
        cleanupComplete: attempt.cleanupComplete,
        knownJobId: attempt.jobId,
        matchingJobIds: found.map((job) => job.id),
        apply: false,
      }),
    );
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucketName = values["immutable-bucket"];
  if (
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !bucketName ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucketName)
  )
    throw new Error("explicit account and immutable bucket required");
  const scratch = await mkdtemp(join(tmpdir(), "song-video-cloudconvert-reconciliation-"));
  let dispose: (() => Promise<void>) | undefined;
  try {
    const configPath = join(scratch, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "song-video-cloudconvert-reconciliation",
        account_id: accountId,
        compatibility_date: "2026-08-15",
        workers_dev: false,
        observability: { enabled: false },
        r2_buckets: [{ binding: "IMMUTABLE", bucket_name: bucketName, remote: true }],
      }),
    );
    const proxy = await getPlatformProxy<{ IMMUTABLE: R2Bucket }>({
      configPath,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    dispose = proxy.dispose;
    await repository.requireReconciliation(values.attempt);
    await makeCloudConvertRenderCleanup({ repository, bucket: proxy.env.IMMUTABLE, jobs })(
      values.attempt,
    );
    console.log(
      JSON.stringify({
        attemptId: values.attempt,
        cleanupComplete: (await repository.read(values.attempt))?.cleanupComplete ?? false,
        apply: true,
      }),
    );
  } finally {
    await dispose?.();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
