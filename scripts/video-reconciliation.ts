#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { getPlatformProxy } from "wrangler";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  makeQencodeReconciliationObserver,
  makeQencodeTaskTransport,
  makeR2QencodeArtifactStore,
} from "../packages/platform-cf/src/qencode-media-transform.ts";
import { makeVideoReconciliationOperator } from "../packages/platform-cf/src/video-reconciliation-operator.ts";
import { makeVideoStageArtifactHead } from "../packages/platform-cf/src/video-stage-artifact-head.ts";

/** No credentials in arguments or output. --apply explicitly allows sealing and fenced resolution. */
export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      submission: { type: "string" },
      attempt: { type: "string" },
      "derived-bucket": { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.submission || !/^[A-Za-z0-9._:-]{1,512}$/u.test(values.submission))
    throw new Error("submission required");
  const connection = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!connection) throw new Error("database required");
  const runtime = makeDirectPostgresControlPlaneLayer(connection);
  const readOnly = makeVideoReconciliationOperator(runtime, {
    observer: { observe: () => Effect.die("operator observation not configured") },
    artifactHead: async () => null,
  });
  if (!values.attempt) {
    if (values.apply) throw new Error("attempt required for apply");
    for (const row of await readOnly.list(values.submission))
      console.log(
        JSON.stringify({
          submissionId: row.submission_id,
          requestId: row.request_id,
          providerJobId: row.provider_job_id,
          capability: row.capability,
          phase: row.provider_job_phase,
          lastObservation: row.last_observation?.status ?? null,
        }),
      );
    return;
  }
  // Check authority before opening any remote binding session, including dry runs.
  const preview = await readOnly.resolve(values.submission, values.attempt, false);
  if (!values.apply) {
    console.log(JSON.stringify(preview));
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !values["derived-bucket"] ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(values["derived-bucket"])
  )
    throw new Error("explicit account and derived bucket required");
  const scratch = await mkdtemp(join(tmpdir(), "video-reconciliation-"));
  let dispose: (() => Promise<void>) | undefined;
  try {
    const configPath = join(scratch, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "video-reconciliation-operator",
        account_id: accountId,
        compatibility_date: "2026-08-15",
        workers_dev: false,
        observability: { enabled: false },
        r2_buckets: [{ binding: "DERIVED", bucket_name: values["derived-bucket"], remote: true }],
      }),
    );
    const proxy = await getPlatformProxy<{
      DERIVED: Parameters<typeof makeR2QencodeArtifactStore>[0];
    }>({
      configPath,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    dispose = proxy.dispose;
    const operator = makeVideoReconciliationOperator(runtime, {
      observer: makeQencodeReconciliationObserver({
        transport: makeQencodeTaskTransport(),
        artifacts: makeR2QencodeArtifactStore(proxy.env.DERIVED),
      }),
      artifactHead: makeVideoStageArtifactHead(proxy.env.DERIVED),
    });
    console.log(JSON.stringify(await operator.resolve(values.submission, values.attempt, true)));
  } finally {
    try {
      await dispose?.();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
if (import.meta.main)
  main(process.argv.slice(2)).catch(() => {
    console.error(JSON.stringify({ outcome: "operator_refused_or_unavailable" }));
    process.exitCode = 1;
  });
