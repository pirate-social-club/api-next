#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { ControlPlaneDb } from "../packages/application/src/index.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  makeReadOnlyPostgresControlPlaneLayer,
} from "../packages/platform-cf/src/postgres.ts";
import { makeAcceptedAnalysisCleanup } from "../packages/platform-cf/src/video-accepted-analysis-cleanup.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      submission: { type: "string" },
      request: { type: "string", multiple: true },
      fence: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const raw = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (!raw) throw new Error("staging database required");
  if (
    values.apply
      ? !values.fence || values.submission || values.request
      : !values.submission || !values.request || values.fence
  )
    throw new Error("exact preview or apply arguments required");
  const url = new URL(normalizePostgresConnectionString(raw));
  url.searchParams.set("options", "-c search_path=api_next");
  const options = { logger: { info: () => {}, error: () => {} } };
  const runtime = values.apply
    ? makeDirectPostgresControlPlaneLayer(url.toString(), options)
    : makeReadOnlyPostgresControlPlaneLayer(url.toString(), options);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const session = yield* db.execute<{ role: string; schema: string }>({
        label: "video-cleanup.staging-role",
        readonly: true,
        values: [],
        text: "SELECT current_user AS role,current_schema() AS schema",
      });
      if (
        session.rows[0]?.role !== "pscale_api_gy9lze83nr29" ||
        session.rows[0]?.schema !== "api_next"
      )
        throw new Error("staging role/schema refused");
    }).pipe(Effect.provide(runtime)),
  );
  const operator = makeAcceptedAnalysisCleanup(runtime);
  if (values.apply) {
    const bytes = await readFile(values.fence as string);
    if (bytes.length > 16384) throw new Error("fence exceeds bound");
    console.log(JSON.stringify(await operator.apply(JSON.parse(bytes.toString("utf8")))));
  } else {
    console.log(
      JSON.stringify(
        await operator.preview({ submissionId: values.submission, requestIds: values.request }),
      ),
    );
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch(() => {
    // A failed acknowledgement can follow COMMIT. Never report a failed exit as no mutation.
    console.error(
      JSON.stringify({ outcome: "refused_or_unavailable", retry_requires_fresh_state: true }),
    );
    process.exitCode = 1;
  });
