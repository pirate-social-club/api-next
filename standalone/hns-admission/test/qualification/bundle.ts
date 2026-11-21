import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
const bundle = await Effect.runPromise(
  Effect.gen(function* () {
    const builder = yield* WorkerBundle;
    return yield* builder.build({
      id: "HnsAdmission",
      main: new URL("../../src/worker.ts", import.meta.url).pathname,
      compatibility: { date: "2026-11-14", flags: [] },
      entry: { kind: "effect", exports: {} },
      stack: { name: "HnsAdmission", stage: "offline" },
      extraOptions: undefined,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
console.log(
  JSON.stringify({
    files: bundle.files.map((file) => ({
      path: file.path,
      bytes:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content).length
          : file.content.length,
    })),
    hash: bundle.hash,
    qualification:
      "offline compilation only; no DO exports discovery or runtime/deployment acceptance",
  }),
);
