import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const esbuildPath = require.resolve("esbuild", {
  paths: [dirname(require.resolve("wrangler/package.json"))],
});
const { build } = require(esbuildPath);

const root = resolve(import.meta.dir, "../..");

/** Build-time pins are embedded in the isolated artifact and are never runtime flags. */
/** @param {string} mode @param {string | undefined} [databaseSqlRoleSha256] */
export async function buildRewardsHttpArtifact(mode, databaseSqlRoleSha256) {
  if (!["isolated", "staging", "production"].includes(mode)) {
    throw new Error("Unknown Rewards Worker build mode");
  }
  if (mode === "isolated" && !/^[a-f0-9]{64}$/.test(databaseSqlRoleSha256 ?? "")) {
    throw new Error("An independently verified isolated database role pin is required");
  }
  const entry =
    mode === "isolated" ? "tests/rewards-e2e/entry.ts" : "apps/http-worker/src/index.ts";
  const plugins =
    mode === "isolated"
      ? [
          {
            name: "isolated-rewards-resource-pins",
            setup(builder) {
              builder.onResolve({ filter: /^#rewards-e2e-pins$/ }, () => ({
                path: "resource-pins",
                namespace: "isolated-rewards-pins",
              }));
              builder.onLoad({ filter: /.*/, namespace: "isolated-rewards-pins" }, () => ({
                contents: `export const databaseSqlRoleSha256 = "${databaseSqlRoleSha256}";`,
                loader: "js",
              }));
            },
          },
        ]
      : [];
  return buildArtifact(entry, plugins, mode);
}

export async function buildNormalRewardsJobsArtifact() {
  return buildArtifact("apps/jobs-worker/src/index.ts", [], "jobs");
}

async function buildArtifact(entry, plugins, mode) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, entry)],
    bundle: true,
    write: false,
    platform: "node",
    conditions: ["workerd"],
    target: "es2022",
    format: "esm",
    external: ["cloudflare:*", "node:*"],
    minify: false,
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
    tsconfig: resolve(root, "tsconfig.json"),
    plugins,
    // Prebundled CommonJS drivers retain dynamic builtin requires.
    banner: {
      js: 'import { createRequire as rewardsCreateRequire } from "node:module"; const require = rewardsCreateRequire("/rewards-worker.js");',
    },
  });
  if (result.outputFiles.length !== 1) throw new Error("Unexpected Rewards Worker build output");
  return {
    source: result.outputFiles[0].text,
    inputPaths: Object.keys(result.metafile.inputs),
    mode,
  };
}
