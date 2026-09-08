import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";

/** A single reviewed stdin program. Imported diagnostic mains are disabled and
 * all non-runtime dependencies must be bundled, never resolved beside the run.
 */
export async function buildKaraokeCollector() {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./staging-karaoke-collector-main.ts", import.meta.url))],
    target: "bun",
    format: "esm",
    splitting: false,
    metafile: true,
    allowUnresolved: [],
    define: { "import.meta.main": "false" },
    plugins: [
      {
        name: "deny-native-postgres",
        setup(builder) {
          builder.onResolve({ filter: /^pg-native$/u }, () => ({
            path: "pg-native",
            namespace: "collector-denied",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "collector-denied" }, () => ({
            contents: 'throw new Error("collector_native_postgres_denied");',
            loader: "js",
          }));
        },
      },
    ],
  });
  const artifact = result.outputs[0];
  if (
    !result.success ||
    result.outputs.length !== 1 ||
    artifact?.kind !== "entry-point" ||
    !result.metafile
  )
    throw new Error("collector_bundle_failed");
  for (const output of Object.values(result.metafile.outputs))
    if (output.imports.some((value) => !value.path.startsWith("node:") && value.path !== "bun"))
      throw new Error("collector_bundle_external_dependency");
  const bytes = await artifact.text();
  if (Buffer.byteLength(bytes) > 16_777_216) throw new Error("collector_bundle_size");
  return { bytes, digest: reconciliationDigest(bytes) };
}

if (import.meta.main) {
  try {
    if (
      process.argv.length !== 4 ||
      process.argv[2] !== "--output" ||
      !process.argv[3]?.startsWith("/")
    )
      throw new Error("collector_build_invocation");
    const result = await buildKaraokeCollector();
    const fd = openSync(
      process.argv[3],
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, result.bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.log(
      JSON.stringify({
        collectorSourceDigest: result.digest,
        bytes: Buffer.byteLength(result.bytes),
        executionAuthorized: false,
      }),
    );
  } catch {
    console.error("collector_build_denied");
    process.exitCode = 1;
  }
}
