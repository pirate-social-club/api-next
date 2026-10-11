import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isolatedOrigins } from "./worker-plan.mjs";

export const solidRelease = "8baa1948f767cbf8b2876c8cce2ad14255688250";
const reviewedManifestDigest = "ebd22bf61cb87831a8f9cf111e68384469a882b493d72e37b7ee372a4e3c3bc2";

/** Copy a reviewed, immutable Solid build; no source checkout, build or shared deploy. */
export async function prepareSolidArtifact({ root, solidRoot, manifestPath }) {
  const manifestBytes = await readFile(manifestPath);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== reviewedManifestDigest)
    throw new Error("Solid build evidence differs from its independent review");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.source !== solidRelease ||
    manifest.passed !== true ||
    Object.keys(manifest.files).length !== 324
  )
    throw new Error("Solid release identity refused");
  const output = resolve(root, "tests/rewards-e2e/dist/solid");
  const verified = [];
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (!/^dist\/(client|ssr)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes(".."))
      throw new Error("Solid artifact path refused");
    const bytes = await readFile(resolve(solidRoot, path));
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error(`Solid artifact changed: ${path}`);
    const target = resolve(output, path.slice(5));
    verified.push({ target, bytes });
  }
  for (const { target, bytes } of verified) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return { source: solidRelease, verifiedFiles: 324, manifestSha256: reviewedManifestDigest };
}

export function isolatedSolidConfiguration(source) {
  const stage = source.env.staging;
  const environment = {
    name: "pirate-web-solid-megapot-e2e-staging",
    version_metadata: { binding: "CF_VERSION_METADATA" },
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: new URL(isolatedOrigins.web).host, custom_domain: true }],
    vars: {
      API_NEXT_ORIGIN: isolatedOrigins.api,
      PUBLIC_APP_CANONICAL_ORIGIN: isolatedOrigins.web,
      PRIVY_APP_ID: stage.vars.PRIVY_APP_ID,
      VERIFICATION_UI_ENABLED: "true",
      COMMUNITY_CREATION_AVATAR_AUTHORING_ENABLED: "false",
      HNS_COMMUNITY_APP_INGRESS_ENABLED: "false",
      HNS_HANDLE_HOST_INGRESS_ENABLED: "false",
    },
    durable_objects: structuredClone(source.durable_objects),
    secrets: { required: [] },
  };
  if (
    source.account_id !== "08a4c22cf52e2ecae883e36f80a33f4a" ||
    environment.vars.PRIVY_APP_ID !== "cmsw5pis300b80cladbxx7bsr" ||
    JSON.stringify(environment.durable_objects) !==
      JSON.stringify({
        bindings: [
          { name: "HNS_COMMUNITY_APP_REPLAY", class_name: "HnsCommunityAppReplayStoreDO" },
        ],
      }) ||
    JSON.stringify(source.migrations) !==
      JSON.stringify([{ tag: "v1", new_sqlite_classes: ["HnsCommunityAppReplayStoreDO"] }])
  )
    throw new Error("Isolated Solid resource inventory changed");
  return {
    name: environment.name,
    account_id: source.account_id,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    main: "./dist/solid/ssr/index.js",
    no_bundle: true,
    assets: { directory: "./dist/solid/client", binding: "ASSETS" },
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    migrations: source.migrations,
    ...environment,
    env: { "rewards-e2e": environment },
  };
}
