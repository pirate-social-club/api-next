import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./api-client-provenance.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "api-client");
const currentVersion = "0.24.0";
const packageName = `pirate-api-client-${currentVersion}.tgz`;

interface ReleaseLedger {
  readonly schemaVersion: 1;
  readonly package: "@pirate/api-client";
  readonly releases: readonly {
    readonly version: string;
    readonly artifact: string;
    readonly artifactSha256: string;
    readonly handoff: string;
  }[];
}

type ReleaseLedgerEntry = ReleaseLedger["releases"][number];

async function verifyReleaseLedger(currentVersion: string): Promise<ReleaseLedgerEntry> {
  const ledger = JSON.parse(
    await readFile(join(repositoryRoot, "docs/api-next/api-client-release-ledger.json"), "utf8"),
  ) as ReleaseLedger;
  if (ledger.schemaVersion !== 1 || ledger.package !== "@pirate/api-client") {
    throw new Error("Invalid api-client release ledger identity");
  }
  const versions = new Set<string>();
  let currentRelease: ReleaseLedgerEntry | undefined;
  for (const release of ledger.releases) {
    if (versions.has(release.version)) throw new Error(`Duplicate release ${release.version}`);
    versions.add(release.version);
    const artifact = await readFile(join(repositoryRoot, release.artifact));
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    if (artifactSha256 !== release.artifactSha256) {
      throw new Error(`Immutable api-client artifact drifted: ${release.version}`);
    }
    const handoff = JSON.parse(await readFile(join(repositoryRoot, release.handoff), "utf8")) as {
      readonly package?: string;
      readonly version?: string;
      readonly artifact?: { readonly path?: string; readonly sha256?: string };
    };
    if (
      handoff.package !== ledger.package ||
      handoff.version !== release.version ||
      handoff.artifact?.path !== release.artifact ||
      handoff.artifact.sha256 !== release.artifactSha256
    ) {
      throw new Error(`Api-client handoff does not match its release ledger: ${release.version}`);
    }
    if (release.version === currentVersion) currentRelease = release;
  }
  if (currentRelease === undefined) {
    throw new Error(`Current api-client ${currentVersion} is absent from the release ledger`);
  }
  return currentRelease;
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pirate-api-client-"));
  const packDirectory = join(tempRoot, "pack");
  const extractedDirectory = join(tempRoot, "extracted");
  const artifactDirectory = join(tempRoot, "artifact");
  const consumerDirectory = join(tempRoot, "consumer");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(extractedDirectory),
    mkdir(artifactDirectory),
    mkdir(consumerDirectory),
  ]);

  try {
    run("bun", ["pm", "pack", "--destination", packDirectory, "--quiet"], packageRoot);
    const archive = join(packDirectory, packageName);
    const archiveListing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    if (archiveListing.status !== 0) {
      throw new Error(`Unable to inspect ${archive}: ${archiveListing.stderr}`);
    }
    const archiveFiles = archiveListing.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.length > 0)
      .sort();
    const expectedFiles = [
      "package/package.json",
      "package/src/generated/client.ts",
      "package/src/generated/provenance.json",
      "package/src/index.ts",
    ];
    if (JSON.stringify(archiveFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `Unexpected @pirate/api-client archive contents:\n${archiveFiles.join("\n")}`,
      );
    }
    run("tar", ["-xzf", archive, "-C", extractedDirectory], repositoryRoot);

    const packedRoot = join(extractedDirectory, "package");
    const packedPackage = JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8")) as {
      readonly name?: string;
      readonly version?: string;
      readonly dependencies?: unknown;
      readonly devDependencies?: unknown;
      readonly peerDependencies?: unknown;
      readonly exports?: Record<string, unknown>;
    };
    if (packedPackage.name !== "@pirate/api-client" || packedPackage.version !== currentVersion) {
      throw new Error(
        `Packed package identity/version is not @pirate/api-client@${currentVersion}`,
      );
    }
    const currentRelease = await verifyReleaseLedger(packedPackage.version);
    const immutableArchive = join(repositoryRoot, currentRelease.artifact);
    const immutableListing = spawnSync("tar", ["-tzf", immutableArchive], { encoding: "utf8" });
    if (immutableListing.status !== 0) {
      throw new Error(`Unable to inspect ${immutableArchive}: ${immutableListing.stderr}`);
    }
    const immutableFiles = immutableListing.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.length > 0)
      .sort();
    if (JSON.stringify(immutableFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `Unexpected immutable @pirate/api-client archive contents:\n${immutableFiles.join("\n")}`,
      );
    }
    run("tar", ["-xzf", immutableArchive, "-C", artifactDirectory], repositoryRoot);
    for (const entry of expectedFiles) {
      const [packedFile, immutableFile] = await Promise.all([
        readFile(join(extractedDirectory, entry)),
        readFile(join(artifactDirectory, entry)),
      ]);
      if (!packedFile.equals(immutableFile)) {
        throw new Error(
          `Packed client content does not match its immutable release artifact: ${entry}`,
        );
      }
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      if (packedPackage[field] !== undefined) {
        throw new Error(`Packed client must have zero package dependencies (${field} present)`);
      }
    }
    if (
      packedPackage.exports?.["."] === undefined ||
      packedPackage.exports?.["./provenance.json"] === undefined
    ) {
      throw new Error("Packed client is missing explicit exports");
    }

    const clientText = await readFile(join(packedRoot, "src/generated/client.ts"), "utf8");
    const openapiText = await readFile(
      join(repositoryRoot, "apps", "http-worker", "src", "generated", "openapi.json"),
      "utf8",
    );
    const indexText = await readFile(join(packedRoot, "src/index.ts"), "utf8");
    const manifest = JSON.parse(
      await readFile(join(packedRoot, "src/generated/provenance.json"), "utf8"),
    ) as {
      readonly sourceIdentifier?: string;
      readonly openapiSha256?: string;
      readonly clientSha256?: string;
    };
    if (
      !/^api-next-contracts@[a-f0-9]{64}$/.test(manifest.sourceIdentifier ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.openapiSha256 ?? "") ||
      manifest.openapiSha256 !== sha256(openapiText) ||
      manifest.sourceIdentifier !== `api-next-contracts@${sha256(openapiText)}` ||
      manifest.clientSha256 !== sha256(clientText)
    ) {
      throw new Error("Packed client provenance manifest does not match its immutable artifact");
    }
    if (!indexText.includes("./generated/client.ts")) {
      throw new Error("Packed client entrypoint does not export generated client");
    }
    const packedFiles = [
      join(packedRoot, "package.json"),
      join(packedRoot, "src/index.ts"),
      join(packedRoot, "src/generated/client.ts"),
    ];
    for (const file of packedFiles) {
      const text = await readFile(file, "utf8");
      if (/(?:@pirate\/contracts|(?:^|["'])effect(?:["'/]))/.test(text)) {
        throw new Error(`Packed client contains a contracts/effect dependency or import: ${file}`);
      }
    }

    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "api-client-clean-consumer",
          private: true,
          type: "module",
          dependencies: { "@pirate/api-client": `file:${archive}` },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
            lib: ["ES2022", "DOM"],
            skipLibCheck: true,
          },
          files: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    const consumerSource = [
      'import { ApiClientError, createPirateApiClient } from "@pirate/api-client";',
      "import type {",
      "  GetHealthInput,",
      "  GetHealthResponse,",
      "  GetPostsPostIdError,",
      "  GetPublicCommunityThreadsInput,",
      "  GetPublicCommunityThreadsResponse,",
      "  GetPublicCommunityThreadsError,",
      '} from "@pirate/api-client";',
      "",
      "const healthInput: GetHealthInput = undefined;",
      'const healthResponse: GetHealthResponse = { status: "ok" };',
      "const errorTypeCheck: GetPostsPostIdError | undefined = undefined;",
      "void errorTypeCheck;",
      "const communityInput: GetPublicCommunityThreadsInput = {",
      '  path: { communityRef: "crew" },',
      '  query: { surface: "threads", sort: "new", locale: "en" },',
      "};",
      "const communityResponseTypeCheck: GetPublicCommunityThreadsResponse | undefined = undefined;",
      "const communityErrorTypeCheck: GetPublicCommunityThreadsError | undefined = undefined;",
      "void communityResponseTypeCheck;",
      "void communityErrorTypeCheck;",
      "",
      'const successClient = createPirateApiClient("https://api.example", async () =>',
      "  new Response(JSON.stringify(healthResponse), { status: 200 }),",
      ");",
      "const response = await successClient.get_health(healthInput);",
      'if (response.status !== "ok") throw new Error("successful fake fetch did not decode");',
      "",
      'const communityClient = createPirateApiClient("https://api.example", async (input) => {',
      "  const url = String(input);",
      '  if (!url.includes("/public-communities/crew/feed?surface=threads&sort=new&locale=en")) {',
      '    throw new Error("unexpected public-community URL: " + url);',
      "  }",
      "  return new Response(JSON.stringify({",
      "    error: {",
      '      code: "not_found",',
      '      message: "missing community",',
      "      retryable: false,",
      "    },",
      '    request_id: "community-clean-consumer-request",',
      "  }), { status: 404 });",
      "});",
      "try {",
      "  await communityClient.get_publicCommunitiesCommunityRefFeed(communityInput);",
      '  throw new Error("declared public-community error was not thrown");',
      "} catch (error) {",
      "  if (!(error instanceof ApiClientError)) throw error;",
      '  if (error.status !== 404 || error.code !== "not_found") throw error;',
      '  if (error.requestId !== "community-clean-consumer-request") throw error;',
      "}",
      "",
      'const errorClient = createPirateApiClient("https://api.example", async () =>',
      "  new Response(JSON.stringify({",
      "    error: {",
      '      code: "not_found",',
      '      message: "missing",',
      "      retryable: false,",
      '      details: { resource: "post" },',
      "    },",
      '    request_id: "clean-consumer-request",',
      "  }), { status: 404 }),",
      ");",
      "try {",
      '  await errorClient.get_postsPostId({ path: { postId: "post-1" } });',
      '  throw new Error("declared fake error was not thrown");',
      "} catch (error) {",
      "  if (!(error instanceof ApiClientError)) throw error;",
      '  if (error.status !== 404 || error.code !== "not_found" || error.retryable !== false) throw error;',
      '  if (error.requestId !== "clean-consumer-request") throw error;',
      '  if (error.details?.resource !== "post") throw error;',
      "}",
      "",
    ].join("\n");
    await writeFile(join(consumerDirectory, "consumer.ts"), consumerSource);
    run("bun", ["install", "--no-progress", "--ignore-scripts"], consumerDirectory);
    run(
      "node",
      [
        join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        "tsconfig.json",
      ],
      consumerDirectory,
    );
    run("bun", ["run", "consumer.ts"], consumerDirectory);
    console.log(`api-client package verification passed (${archive})`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
