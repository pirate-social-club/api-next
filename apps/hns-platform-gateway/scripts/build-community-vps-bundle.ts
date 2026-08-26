const outputPath = "dist/pirate-hns-community-app-gateway.mjs";

async function command(arguments_: readonly string[]): Promise<string> {
  const process = Bun.spawn([...arguments_], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error("Community gateway build provenance check failed");
  return output.trim();
}

const status = await command(["git", "status", "--porcelain", "--untracked-files=no"]);
if (status !== "") throw new Error("Community gateway build requires a clean tracked tree");
const sourceCommit = await command(["git", "rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error("Community gateway source commit is invalid");
}

const result = await Bun.build({
  entrypoints: ["src/community-main.ts"],
  outdir: "dist",
  naming: "pirate-hns-community-app-gateway.mjs",
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
  define: {
    __PIRATE_API_NEXT_SOURCE_COMMIT__: JSON.stringify(sourceCommit),
  },
});
if (!result.success) throw new Error("Community gateway bundle build failed");

const bundle = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bundle));
const bundleSha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
console.log(
  JSON.stringify({
    event: "hns_community_app_gateway_bundle_built",
    api_next_source_commit: sourceCommit,
    artifact: outputPath,
    bundle_sha256: bundleSha256,
  }),
);

export {};
